import {
  type AdjustmentProposal,
  type BlueReturn,
  CLOSING_NOTE_MAX,
  type FiledDocumentInput,
  type FixedAssetInput,
  type HomeUseAllocationInput,
  type RentDetailInput,
  TAX_RETURN_LABEL_MAX,
  TAX_RETURN_MEMO_MAX,
  type TaxReturnMemoInput,
  YEN_LIMIT,
} from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import type { PriorPeriod } from "../blue-return/balance-sheet.ts";
import { buildBlueReturn } from "../blue-return/build.ts";
import {
  type BlueDeductionCap,
  blueDeductionCap,
  type DeductionRequirementAnswers,
} from "../blue-return/deduction.ts";
import {
  type Depreciation,
  depreciate,
  proposeDepreciationAdjustment,
  validateFixedAsset,
} from "../blue-return/depreciation.ts";
import {
  type HomeUseAssessment,
  type HomeUseNoProposalReason,
  proposeHomeUseAdjustment,
  validateHomeUseAllocation,
} from "../blue-return/home-use.ts";
import { yearOfDate } from "../dates.ts";
import type {
  Clock,
  ClosingStore,
  ClosingUnitOfWork,
  IdGenerator,
  LedgerRepository,
  MasterRepository,
  ReportRepository,
} from "../ports.ts";
import { computeBalances } from "../reports/balances.ts";
import {
  type AdjustmentKind,
  type AdjustmentRef,
  type ClosingNote,
  type ClosingNoteKind,
  type DeductionAnswers,
  type DomainError,
  type DomainWarning,
  domainError,
  err,
  type FiledDocument,
  type FiscalPeriod,
  type FixedAsset,
  type HomeUseAllocation,
  type Journal,
  ok,
  periodNotFound,
  type RentDetail,
  type Result,
  type TaxReturnMemo,
  validation,
} from "../types.ts";
import { createJournal } from "./create-journal.ts";
import type { ReportDeps } from "./reports.ts";

/** 決算書の参照の依存。帳簿は 001 の ReportDeps、決算の設定は ClosingStore から読む */
export type BlueReturnDeps = ReportDeps & { closing: ClosingStore };

/** 決算の設定（控除の回答・按分・内訳・資産）の読み取りの依存 */
export type ClosingReadDeps = { masters: MasterRepository; closing: ClosingStore };

/**
 * 決算の設定（控除の回答・メモ・按分・内訳・資産）の保存の依存。
 * 保存と closing_audit_log の記録を UnitOfWork の 1 つのトランザクションで行う
 */
export type ClosingSettingsDeps = { uow: ClosingUnitOfWork; ids: IdGenerator; clock: Clock };

/**
 * UnitOfWork の中で保存の本体に渡す依存（同じトランザクションのマスタ・ClosingStore と、
 * 償却の仕訳の状態を読む仕訳。009/R12）
 */
type ClosingTxDeps = ClosingReadDeps & {
  ledger: Pick<LedgerRepository, "getJournal">;
  ids: IdGenerator;
  clock: Clock;
};

function inClosingTx<T>(
  deps: ClosingSettingsDeps,
  fn: (tx: ClosingTxDeps) => Result<T>,
): Result<T> {
  return deps.uow.run(({ ledger, masters, closing }) =>
    fn({ ledger, masters, closing, ids: deps.ids, clock: deps.clock }),
  );
}

/** 控除の回答と、そこから決まる上限額。回答がなければどちらも null（0 として計算しない） */
export type DeductionAnswersView = {
  answers: DeductionAnswers | null;
  cap: BlueDeductionCap | null;
};

/** 個人の事業体でなければ ENTITY_KIND_UNSUPPORTED（事業体がなければ ENTITY_NOT_FOUND） */
function requireIndividual(masters: Pick<MasterRepository, "getProfile">): Result<null> {
  const profile = masters.getProfile();
  if (profile === undefined) {
    return err(domainError("ENTITY_NOT_FOUND", "事業体が見つかりません"));
  }
  if (profile.kind !== "individual") {
    return err(
      domainError("ENTITY_KIND_UNSUPPORTED", "青色申告決算書は個人事業主の事業体だけが使えます", {
        kind: profile.kind,
      }),
    );
  }
  return ok(null);
}

/**
 * 個人の事業体でなければ ENTITY_KIND_UNSUPPORTED。年度がなければ 001 の締め・解除と同じ
 * VALIDATION（会計期間が見つかりません）。種別の判定が先
 */
function resolveYear(masters: MasterRepository, fiscalYear: number): Result<FiscalPeriod> {
  const individual = requireIndividual(masters);
  if (!individual.ok) return individual;
  const period = masters.getFiscalPeriodByYear(fiscalYear);
  return period === undefined ? err(periodNotFound(fiscalYear)) : ok(period);
}

/**
 * 前の年度の期末の残高（4ページの繰越の検査、R8）。前の年度の会計期間がない、または期首残高も
 * 有効な仕訳もない（帳簿がない）ときは null
 */
function readPriorPeriod(deps: ReportDeps, fiscalYear: number): PriorPeriod | null {
  const prior = deps.masters.getFiscalPeriodByYear(fiscalYear - 1);
  if (prior === undefined) return null;
  const opening = deps.reports.openingBalances(prior.fiscalYear);
  const lines = deps.reports.linesInRange(prior.startDate, prior.endDate);
  if (opening.length === 0 && lines.length === 0) return null;
  return {
    fiscalYear: prior.fiscalYear,
    status: prior.status,
    closing: computeBalances({
      opening,
      lines,
      periodStart: prior.startDate,
      to: prior.endDate,
    }),
  };
}

/**
 * 青色申告決算書を帳簿から導出する（US1・US4）。仕訳は年度の期間の有効なもの（取消済みを除く。
 * 001 の帳票と同じ読み方）、期首残高は 001、前の年度の期末は readPriorPeriod、控除の回答・税制の値・
 * メモは ClosingStore から読む
 */
export function getBlueReturn(
  deps: BlueReturnDeps,
  params: { fiscalYear: number },
): Result<BlueReturn> {
  const period = resolveYear(deps.masters, params.fiscalYear);
  if (!period.ok) return period;
  return ok(
    buildBlueReturn({
      period: period.value,
      accounts: deps.masters.listAccounts(),
      lines: deps.reports.linesInRange(period.value.startDate, period.value.endDate),
      deductionAnswers: deps.closing.getDeductionAnswers(params.fiscalYear) ?? null,
      taxParameters: deps.closing.listTaxParameters(),
      allocations: deps.closing.listHomeUseAllocations(params.fiscalYear),
      adjustmentRefs: deps.closing.listAdjustmentRefs(params.fiscalYear),
      rentDetails: deps.closing.listRentDetails(params.fiscalYear),
      fixedAssets: deps.closing.listFixedAssets(),
      straightLineRates: deps.closing.listStraightLineRates(),
      opening: deps.reports.openingBalances(params.fiscalYear),
      priorPeriod: readPriorPeriod(deps, params.fiscalYear),
      closingNotes: deps.closing.listClosingNotes(params.fiscalYear),
    }),
  );
}

/**
 * 決算のメモ（特殊事情・期首と前期末の差の説明）を年度・種類ごとに保存する（FR-027、FR-030）。
 * 本文は前後の空白を除く。closing_audit_log に closing_note（対象は `年度:種類`。初回は create、
 * 以降は update。変更前・後）を残す。締め済みの年度でも保存できる（メモは帳簿ではない。差額も変わらない）
 */
export function saveClosingNote(
  deps: ClosingSettingsDeps,
  params: { fiscalYear: number; kind: ClosingNoteKind; body: string },
): Result<ClosingNote> {
  return inClosingTx(deps, (tx) => saveClosingNoteIn(tx, params));
}

function saveClosingNoteIn(
  deps: ClosingTxDeps,
  params: { fiscalYear: number; kind: ClosingNoteKind; body: string },
): Result<ClosingNote> {
  const period = resolveYear(deps.masters, params.fiscalYear);
  if (!period.ok) return period;
  const body = params.body.trim();
  if (body.length > CLOSING_NOTE_MAX) {
    return err(
      domainError("VALIDATION", `メモは${CLOSING_NOTE_MAX}文字以内で入力してください`, {
        field: "body",
      }),
    );
  }
  const before = deps.closing
    .listClosingNotes(params.fiscalYear)
    .find((n) => n.kind === params.kind);
  const now = deps.clock.now();
  const saved: ClosingNote = {
    fiscalYear: params.fiscalYear,
    kind: params.kind,
    body,
    updatedAt: now,
  };
  deps.closing.upsertClosingNote(saved);
  deps.closing.appendClosingAudit(
    auditEntry(deps, {
      targetType: "closing_note",
      targetId: `${params.fiscalYear}:${params.kind}`,
      action: before === undefined ? "create" : "update",
      before,
      after: saved,
      at: now,
    }),
  );
  return ok(saved);
}

function viewOf(
  answers: DeductionAnswers | undefined,
  period: FiscalPeriod,
  closing: ClosingStore,
): DeductionAnswersView {
  if (answers === undefined) return { answers: null, cap: null };
  const cap = blueDeductionCap(answers, period.endDate, closing.listTaxParameters());
  return { answers, cap: cap ?? null };
}

/** 年度の控除の要件の回答と上限額（GET /blue-return/:year/deduction-answers） */
export function getDeductionAnswers(
  deps: ClosingReadDeps,
  params: { fiscalYear: number },
): Result<DeductionAnswersView> {
  const period = resolveYear(deps.masters, params.fiscalYear);
  if (!period.ok) return period;
  return ok(
    viewOf(deps.closing.getDeductionAnswers(params.fiscalYear), period.value, deps.closing),
  );
}

/**
 * 控除の要件の回答を保存し、closing_audit_log に blue_deduction_answer（初回は create、
 * 以降は update。変更前・後の回答）を残す。締め済みの年度でも保存できる（回答は帳簿ではない）
 */
export function saveDeductionAnswers(
  deps: ClosingSettingsDeps,
  params: { fiscalYear: number; answers: DeductionRequirementAnswers },
): Result<DeductionAnswersView> {
  return inClosingTx(deps, (tx) => saveDeductionAnswersIn(tx, params));
}

function saveDeductionAnswersIn(
  deps: ClosingTxDeps,
  params: { fiscalYear: number; answers: DeductionRequirementAnswers },
): Result<DeductionAnswersView> {
  const period = resolveYear(deps.masters, params.fiscalYear);
  if (!period.ok) return period;
  const before = deps.closing.getDeductionAnswers(params.fiscalYear);
  const { doubleEntry, statementsAttached, filedOnTime, eTax, electronicBooks } = params.answers;
  const now = deps.clock.now();
  const saved: DeductionAnswers = {
    fiscalYear: params.fiscalYear,
    doubleEntry,
    statementsAttached,
    filedOnTime,
    eTax,
    electronicBooks,
    updatedAt: now,
  };
  deps.closing.upsertDeductionAnswers(saved);
  deps.closing.appendClosingAudit(
    auditEntry(deps, {
      targetType: "blue_deduction_answer",
      targetId: String(params.fiscalYear),
      action: before === undefined ? "create" : "update",
      before,
      after: saved,
      at: now,
    }),
  );
  return ok(viewOf(saved, period.value, deps.closing));
}

// ---- 家事按分・地代家賃の内訳（US2） ----

const sameKey = (
  a: Pick<HomeUseAllocation, "accountId" | "subAccountId">,
  b: Pick<HomeUseAllocation, "accountId" | "subAccountId">,
) => a.accountId === b.accountId && a.subAccountId === b.subAccountId;

/**
 * 家事按分を登録する（FR-012〜013）。年度・科目・補助科目が同じ登録があれば更新（ID と作成日時は
 * そのまま）、なければ作る。前の年度の同じ科目（補助科目）と割合を比べて理由を求める。
 * closing_audit_log に home_use_allocation（create / update、理由、変更前・後）を残す。
 * 締め済みの年度でも登録できる（data-model §3。振替の仕訳の登録は commitAdjustment が拒否する）
 */
export function saveHomeUseAllocation(
  deps: ClosingSettingsDeps,
  params: { fiscalYear: number } & HomeUseAllocationInput,
): Result<HomeUseAllocation> {
  return inClosingTx(deps, (tx) => saveHomeUseAllocationIn(tx, params));
}

function saveHomeUseAllocationIn(
  deps: ClosingTxDeps,
  params: { fiscalYear: number } & HomeUseAllocationInput,
): Result<HomeUseAllocation> {
  const period = resolveYear(deps.masters, params.fiscalYear);
  if (!period.ok) return period;
  const key = { accountId: params.accountId, subAccountId: params.subAccountId ?? null };
  const previous = deps.closing
    .listHomeUseAllocations(params.fiscalYear - 1)
    .find((a) => sameKey(a, key));
  const validated = validateHomeUseAllocation(
    {
      fiscalYear: params.fiscalYear,
      ...key,
      businessRatio: params.businessRatio,
      basis: params.basis,
      changeReason: params.changeReason ?? null,
    },
    {
      accounts: deps.masters.listAccounts(),
      subAccounts: deps.masters.listSubAccounts(params.accountId),
      previous,
    },
  );
  if (!validated.ok) return validated;

  const before = deps.closing
    .listHomeUseAllocations(params.fiscalYear)
    .find((a) => sameKey(a, key));
  const now = deps.clock.now();
  const saved: HomeUseAllocation = {
    ...validated.value,
    id: before?.id ?? deps.ids.next(),
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  };
  deps.closing.upsertHomeUseAllocation(saved);
  deps.closing.appendClosingAudit(
    auditEntry(deps, {
      targetType: "home_use_allocation",
      targetId: saved.id,
      action: before === undefined ? "create" : "update",
      reason: saved.changeReason,
      before,
      after: saved,
      at: now,
    }),
  );
  return ok(saved);
}

/**
 * 年度の家事按分の登録と、前の年度の登録（GET .../home-use）。画面が前の年度の割合を見せて、
 * 割合を変えたときの理由の入力を促すのに使う
 */
export function listHomeUseAllocations(
  deps: ClosingReadDeps,
  params: { fiscalYear: number },
): Result<{ allocations: HomeUseAllocation[]; previousYear: HomeUseAllocation[] }> {
  const period = resolveYear(deps.masters, params.fiscalYear);
  if (!period.ok) return period;
  return ok({
    allocations: deps.closing.listHomeUseAllocations(params.fiscalYear),
    previousYear: deps.closing.listHomeUseAllocations(params.fiscalYear - 1),
  });
}

/** 年度の地代家賃の内訳（GET .../rent-details）。並び順は保存したとおり */
export function getRentDetails(
  deps: ClosingReadDeps,
  params: { fiscalYear: number },
): Result<RentDetail[]> {
  const period = resolveYear(deps.masters, params.fiscalYear);
  if (!period.ok) return period;
  return ok(deps.closing.listRentDetails(params.fiscalYear));
}

function validateRentRow(row: RentDetailInput, rowIndex: number): Result<RentDetailInput> {
  const fail = (field: string, message: string) =>
    err(domainError("VALIDATION", message, { rowIndex, field }));
  const payee = row.payee.trim();
  const property = row.property.trim();
  if (payee === "") return fail("payee", "支払先を入力してください");
  if (property === "") return fail("property", "賃借物件を入力してください");
  const isYen = (n: number) => Number.isInteger(n) && n >= 0 && n < YEN_LIMIT;
  if (!isYen(row.annualRent)) {
    return fail("annualRent", "賃借料は0円以上1兆円未満の整数で入力してください");
  }
  if (!isYen(row.deductibleAmount) || row.deductibleAmount > row.annualRent) {
    return fail("deductibleAmount", "必要経費算入額は0円以上、賃借料以下にしてください");
  }
  return ok({ ...row, payee, property });
}

/**
 * 地代家賃の内訳を全件置き換える（FR-017）。並び順は入力の順。closing_audit_log に rent_detail
 * （対象は年度。前が空なら create、後が空なら delete、ほかは update。変更前・後の全件）を残す
 */
export function saveRentDetails(
  deps: ClosingSettingsDeps,
  params: { fiscalYear: number; rows: readonly RentDetailInput[] },
): Result<RentDetail[]> {
  return inClosingTx(deps, (tx) => saveRentDetailsIn(tx, params));
}

function saveRentDetailsIn(
  deps: ClosingTxDeps,
  params: { fiscalYear: number; rows: readonly RentDetailInput[] },
): Result<RentDetail[]> {
  const period = resolveYear(deps.masters, params.fiscalYear);
  if (!period.ok) return period;
  const valid: RentDetailInput[] = [];
  for (const [i, row] of params.rows.entries()) {
    const v = validateRentRow(row, i);
    if (!v.ok) return v;
    valid.push(v.value);
  }
  const before = deps.closing.listRentDetails(params.fiscalYear);
  const rows: RentDetail[] = valid.map((r, sortOrder) => ({
    id: deps.ids.next(),
    fiscalYear: params.fiscalYear,
    payee: r.payee,
    property: r.property,
    annualRent: r.annualRent,
    deductibleAmount: r.deductibleAmount,
    sortOrder,
  }));
  deps.closing.replaceRentDetails(params.fiscalYear, rows);
  if (before.length > 0 || rows.length > 0) {
    deps.closing.appendClosingAudit(
      auditEntry(deps, {
        targetType: "rent_detail",
        targetId: String(params.fiscalYear),
        action: before.length === 0 ? "create" : rows.length === 0 ? "delete" : "update",
        before: before.length === 0 ? null : before,
        after: rows.length === 0 ? null : rows,
      }),
    );
  }
  return ok(rows);
}

// ---- 固定資産台帳（US3） ----

/** 償却を計算できない理由（率・税制の値がないなど。depreciate の失敗） */
export type DepreciationError = {
  code: DomainError["code"];
  details: NonNullable<DomainError["details"]> | null;
};

/**
 * 台帳の1行。fiscalYear を指定したときだけその年の償却の計算（なければ null）。
 * 計算できなければ depreciation は null で depreciationError に理由（009 contract §3）
 */
export type FixedAssetWithDepreciation = FixedAsset & {
  depreciation: Depreciation | null;
  depreciationError: DepreciationError | null;
};

/**
 * 固定資産の台帳（GET /fixed-assets）。fiscalYear があれば各資産に depreciate の結果を付ける。
 * 並び順は ClosingStore の順。会計期間があるかどうかは問わない
 */
export function listFixedAssets(
  deps: ClosingReadDeps,
  params: { fiscalYear?: number },
): Result<FixedAssetWithDepreciation[]> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  const { fiscalYear } = params;
  const depreciationParams = {
    rates: deps.closing.listStraightLineRates(),
    taxParameters: deps.closing.listTaxParameters(),
  };
  return ok(
    deps.closing.listFixedAssets().map((asset) => {
      if (fiscalYear === undefined) {
        return { ...asset, depreciation: null, depreciationError: null };
      }
      const result = depreciate(asset, fiscalYear, depreciationParams);
      return result.ok
        ? { ...asset, depreciation: result.value, depreciationError: null }
        : {
            ...asset,
            depreciation: null,
            depreciationError: { code: result.error.code, details: result.error.details ?? null },
          };
    }),
  );
}

/**
 * 償却の計算に効く資産の項目（009/R12、spec Edge Cases）。有効な償却の仕訳があれば変えられない。
 * 結びつけた仕訳（linkedJournalId）も含める: 償却の仕訳がある資産に既存の費用の仕訳を結びつけると、
 * 同じ取得が二重に費用になるため
 */
const DEPRECIATION_INPUT_FIELDS = [
  "acquiredOn",
  "inServiceOn",
  "acquisitionCost",
  "method",
  "usefulLifeYears",
  "businessRatio",
  "priorAccumulated",
  "priorThroughYear",
  "assetAccountId",
  "linkedJournalId",
] as const satisfies readonly (keyof FixedAsset)[];

/**
 * 資産に有効な（取り消されていない）償却の仕訳がある年度（昇順・重複なし）。参照は出所ごとの全年度、
 * 仕訳の状態は同じトランザクションの仕訳から読む（009/R12）
 */
function activeDepreciationYears(deps: ClosingTxDeps, assetId: string): number[] {
  const years = new Set<number>();
  for (const ref of deps.closing.listAdjustmentRefsBySource({ assetId })) {
    if (ref.kind !== "depreciation") continue;
    if (deps.ledger.getJournal(ref.journalId)?.status === "active") years.add(ref.fiscalYear);
  }
  return [...years].sort((a, b) => a - b);
}

const depreciationJournalExists = (years: readonly number[]): Result<never> =>
  err(
    domainError(
      "DEPRECIATION_JOURNAL_EXISTS",
      `${years.join("・")}年度の減価償却の仕訳が登録されています。先にその仕訳を取り消してください`,
      { years: [...years] },
    ),
  );

/**
 * 固定資産を登録・更新する（FR-018〜020）。params.id があれば更新（作成日時と除却の日はそのまま。
 * 年間の上限の合計から自分自身を除く）、なければ作る。closing_audit_log に fixed_asset（create / update、
 * 理由、変更前・後）を残す。締め済みの年度の取得でも登録できる（仕訳の案の確定は commitAdjustment が拒否する）。
 * 更新で償却の計算に効く項目が変わり、その資産に有効な償却の仕訳（どの年度でも。少額の特例を含む）が
 * あれば 409 DEPRECIATION_JOURNAL_EXISTS（details.years。009/R12）。名称・数量・備考は変えられる
 */
export function saveFixedAsset(
  deps: ClosingSettingsDeps,
  params: FixedAssetInput & { id?: string; reason?: string | null },
): Result<FixedAsset> {
  return inClosingTx(deps, (tx) => saveFixedAssetIn(tx, params));
}

function saveFixedAssetIn(
  deps: ClosingTxDeps,
  params: FixedAssetInput & { id?: string; reason?: string | null },
): Result<FixedAsset> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  const all = deps.closing.listFixedAssets();
  const before = params.id === undefined ? undefined : all.find((a) => a.id === params.id);
  if (params.id !== undefined && before === undefined) {
    return err(domainError("VALIDATION", "固定資産が見つかりません", { field: "id" }));
  }
  const validated = validateFixedAsset(
    {
      ...(params.id === undefined ? {} : { id: params.id }),
      name: params.name,
      quantity: params.quantity ?? null,
      acquiredOn: params.acquiredOn,
      acquisitionCost: params.acquisitionCost,
      method: params.method,
      usefulLifeYears: params.usefulLifeYears ?? null,
      inServiceOn: params.inServiceOn ?? null,
      priorAccumulated: params.priorAccumulated,
      priorThroughYear: params.priorThroughYear ?? null,
      businessRatio: params.businessRatio,
      assetAccountId: params.assetAccountId,
      linkedJournalId: params.linkedJournalId ?? null,
      note: params.note ?? null,
    },
    all,
    {
      accounts: deps.masters.listAccounts(),
      taxParameters: deps.closing.listTaxParameters(),
      rates: deps.closing.listStraightLineRates(),
    },
  );
  if (!validated.ok) return validated;
  if (
    before !== undefined &&
    DEPRECIATION_INPUT_FIELDS.some((field) => validated.value[field] !== before[field])
  ) {
    const years = activeDepreciationYears(deps, before.id);
    if (years.length > 0) return depreciationJournalExists(years);
  }

  const now = deps.clock.now();
  const { id: _draftId, ...fields } = validated.value;
  const saved: FixedAsset = {
    ...fields,
    id: before?.id ?? deps.ids.next(),
    disposedOn: before?.disposedOn ?? null,
    disposalKind: before?.disposalKind ?? null,
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  };
  deps.closing.upsertFixedAsset(saved);
  deps.closing.appendClosingAudit(
    auditEntry(deps, {
      targetType: "fixed_asset",
      targetId: saved.id,
      action: before === undefined ? "create" : "update",
      reason: params.reason?.trim() || null,
      before,
      after: saved,
      at: now,
    }),
  );
  return ok(saved);
}

export type DisposeFixedAssetParams = {
  id: string;
  disposedOn: string;
  /** 廃棄・売却（省略時は廃棄。009/R8） */
  disposalKind?: NonNullable<FixedAsset["disposalKind"]> | undefined;
  reason: string;
};

/**
 * 固定資産を除却する（disposed_on と種類を記録。物理削除はしない）。closing_audit_log に
 * fixed_asset（dispose、理由、変更前・後）を残す。資産がなければ、除却の日の形が違う・供用日
 * （なければ取得日）より前なら VALIDATION。除却の年度以後（除却済みなら前の除却の年度とのうち早い方以後）に
 * 有効な償却の仕訳があれば 409 DEPRECIATION_JOURNAL_EXISTS（009/R8・R12）
 */
export function disposeFixedAsset(
  deps: ClosingSettingsDeps,
  params: DisposeFixedAssetParams,
): Result<FixedAsset> {
  return inClosingTx(deps, (tx) => disposeFixedAssetIn(tx, params));
}

function disposeFixedAssetIn(
  deps: ClosingTxDeps,
  params: DisposeFixedAssetParams,
): Result<FixedAsset> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  const before = deps.closing.listFixedAssets().find((a) => a.id === params.id);
  if (before === undefined) {
    return err(domainError("VALIDATION", "固定資産が見つかりません", { field: "id" }));
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(params.disposedOn) ||
    Number.isNaN(Date.parse(params.disposedOn))
  ) {
    return err(
      domainError("VALIDATION", "除却の日は YYYY-MM-DD で入力してください", {
        field: "disposedOn",
      }),
    );
  }
  const serviceOn = before.inServiceOn ?? before.acquiredOn;
  if (params.disposedOn < serviceOn) {
    return err(
      domainError("VALIDATION", "除却の日は事業の用に供した日（取得年月日）以後にしてください", {
        field: "disposedOn",
        acquiredOn: before.acquiredOn,
        inServiceOn: serviceOn,
      }),
    );
  }
  // 除却済みの資産の除却の日・種類を変えると、前の除却の年度の仕訳（除却損・売却）とも食い違う
  const fromYear = Math.min(
    yearOfDate(params.disposedOn),
    before.disposedOn === null ? Number.POSITIVE_INFINITY : yearOfDate(before.disposedOn),
  );
  const years = activeDepreciationYears(deps, before.id).filter((y) => y >= fromYear);
  if (years.length > 0) return depreciationJournalExists(years);

  const now = deps.clock.now();
  const saved: FixedAsset = {
    ...before,
    disposedOn: params.disposedOn,
    disposalKind: params.disposalKind ?? "scrap",
    updatedAt: now,
  };
  deps.closing.upsertFixedAsset(saved);
  deps.closing.appendClosingAudit(
    auditEntry(deps, {
      targetType: "fixed_asset",
      targetId: saved.id,
      action: "dispose",
      reason: params.reason.trim() || null,
      before,
      after: saved,
      at: now,
    }),
  );
  return ok(saved);
}

// ---- 決算整理の仕訳の案と確定（R4〜R6） ----

/** 案の作り直しに使う読み取り（トランザクションの中でも外でも同じ形） */
type ProposalSources = {
  masters: Pick<MasterRepository, "listAccounts">;
  closing: Pick<
    ClosingStore,
    | "listHomeUseAllocations"
    | "listAdjustmentRefs"
    | "listAdjustmentRefsBySource"
    | "listFixedAssets"
    | "listStraightLineRates"
    | "listTaxParameters"
  >;
  reports: Pick<ReportRepository, "linesInRange">;
  /**
   * 仕訳が有効（取り消されていない）か。確定（commitAdjustment）はトランザクションの仕訳から読み、
   * 一覧（getAdjustmentProposals）は年度の有効な行から読む（日付を年度の外へ訂正した仕訳は一覧では
   * 未登録に見えるが、確定は登録済みとして拒否する。INV-60 を守るのは確定の側）
   */
  isActiveJournal: (journalId: string) => boolean;
};

/**
 * 減価償却の案（資産・年度ごと。009/R6・R12）。その資産・年度に有効な償却の仕訳が登録済みなら案を作らない
 * （取り消した仕訳は未登録として案を戻す。INV-60）。結びつけた仕訳のある資産・その年度に償却のない資産は
 * proposeDepreciationAdjustment が null にする。率・税制の値がなければ TAX_PARAMETER_MISSING
 */
function assessDepreciation(
  src: ProposalSources,
  period: FiscalPeriod,
  asset: FixedAsset,
): Result<RebuiltProposal> {
  const registered = src.closing
    .listAdjustmentRefsBySource({ assetId: asset.id })
    .some(
      (r) =>
        r.kind === "depreciation" &&
        r.fiscalYear === period.fiscalYear &&
        src.isActiveJournal(r.journalId),
    );
  if (registered) return ok({ proposal: null, reason: "ALREADY_REGISTERED" });
  const proposed = proposeDepreciationAdjustment(
    asset,
    period.fiscalYear,
    src.masters.listAccounts(),
    { rates: src.closing.listStraightLineRates(), taxParameters: src.closing.listTaxParameters() },
  );
  if (!proposed.ok) return proposed;
  if (proposed.value === null) {
    return ok({
      proposal: null,
      reason: asset.linkedJournalId === null ? "NOT_APPLICABLE" : "LINKED_JOURNAL",
    });
  }
  return ok({ proposal: proposed.value, reason: null });
}

function assessHomeUse(
  src: Omit<ProposalSources, "isActiveJournal">,
  period: FiscalPeriod,
  allocation: HomeUseAllocation,
  allocations: readonly HomeUseAllocation[],
): Result<HomeUseAssessment> {
  return proposeHomeUseAdjustment({
    allocation,
    allocations,
    accounts: src.masters.listAccounts(),
    period,
    lines: src.reports.linesInRange(period.startDate, period.endDate),
    refs: src.closing.listAdjustmentRefs(period.fiscalYear),
  });
}

/**
 * 決算整理の仕訳の案の一覧（差があるものだけ。FR-014・FR-016、FR-021）。按分の登録の順、
 * そのあとにその年度に償却のある資産の償却の案（台帳の順。定額法は startYear 以後の各年度）。
 * 締め済みの年度は償却の案を返さない（009 FR-021。按分の案は今のまま）。償却率・税制の値がない資産は
 * 案を出さず、一覧は失敗させない（決算書の DEPRECIATION_PARAMETER_MISSING が知らせる。確定は
 * TAX_PARAMETER_MISSING）
 */
export function getAdjustmentProposals(
  deps: BlueReturnDeps,
  params: { fiscalYear: number },
): Result<AdjustmentProposal[]> {
  const period = resolveYear(deps.masters, params.fiscalYear);
  if (!period.ok) return period;
  const allocations = deps.closing.listHomeUseAllocations(params.fiscalYear);
  const proposals: AdjustmentProposal[] = [];
  for (const allocation of allocations) {
    const assessed = assessHomeUse(deps, period.value, allocation, allocations);
    if (!assessed.ok) return assessed;
    if (assessed.value.proposal !== null) proposals.push(assessed.value.proposal);
  }
  if (period.value.status === "closed") return ok(proposals);

  const activeJournals = new Set(
    deps.reports
      .linesInRange(period.value.startDate, period.value.endDate)
      .filter((l) => l.status === "active")
      .map((l) => l.journalId),
  );
  const src: ProposalSources = {
    ...deps,
    isActiveJournal: (journalId) => activeJournals.has(journalId),
  };
  for (const asset of deps.closing.listFixedAssets()) {
    const assessed = assessDepreciation(src, period.value, asset);
    if (!assessed.ok) {
      if (assessed.error.code === "TAX_PARAMETER_MISSING") continue;
      return assessed;
    }
    if (assessed.value.proposal !== null) proposals.push(assessed.value.proposal);
  }
  return ok(proposals);
}

/** 償却の案を作らない理由 */
type DepreciationNoProposalReason =
  /** 既存の仕訳を結びつけてある（FR-022） */
  | "LINKED_JOURNAL"
  /** その年度に償却がない（供用の前、償却済み、除却の翌年度以後、少額の特例の取得の年度以外など） */
  | "NOT_APPLICABLE"
  /** その資産・年度の償却の仕訳がすでに登録されている（INV-60） */
  | "ALREADY_REGISTERED";

type RebuiltProposal = {
  proposal: AdjustmentProposal | null;
  reason: HomeUseNoProposalReason | DepreciationNoProposalReason | null;
};

/** 種別ごとに案を作り直す */
function rebuildProposal(
  src: ProposalSources,
  period: FiscalPeriod,
  kind: AdjustmentKind,
  sourceId: string,
): Result<RebuiltProposal> {
  switch (kind) {
    case "home_use": {
      const allocations = src.closing.listHomeUseAllocations(period.fiscalYear);
      const allocation = allocations.find((a) => a.id === sourceId);
      if (allocation === undefined) {
        return err(
          domainError("VALIDATION", "この年度の按分の登録が見つかりません", {
            field: "sourceId",
            sourceId,
          }),
        );
      }
      const assessed = assessHomeUse(src, period, allocation, allocations);
      if (!assessed.ok) return assessed;
      return ok({ proposal: assessed.value.proposal, reason: assessed.value.reason });
    }
    case "depreciation": {
      const asset = src.closing.listFixedAssets().find((a) => a.id === sourceId);
      if (asset === undefined) {
        return err(
          domainError("VALIDATION", "固定資産が見つかりません", { field: "sourceId", sourceId }),
        );
      }
      return assessDepreciation(src, period, asset);
    }
    case "deferred_amortization":
      // 開業費の案は T020 で作る
      return err(domainError("VALIDATION", "開業費の案はまだ作れません", { field: "kind", kind }));
  }
}

export type CommitAdjustmentDeps = {
  uow: ClosingUnitOfWork;
  /** トランザクションと同じ接続の帳簿を読む（freee の取込の proposeFreeeOpening と同じ形） */
  reports: ReportRepository;
  ids: IdGenerator;
  clock: Clock;
};

export type CommitAdjustmentParams = {
  fiscalYear: number;
  kind: AdjustmentKind;
  /** 按分の登録 ID または資産 ID */
  sourceId: string;
  /** 画面が見た案の金額（借方合計） */
  expected: { amount: number };
};

export type CommittedAdjustment = {
  journal: Journal;
  ref: AdjustmentRef;
  warnings: DomainWarning[];
};

const debitTotal = (proposal: AdjustmentProposal) =>
  proposal.journal.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);

/**
 * 決算整理の仕訳の案を確定する（FR-015、R4）。1つのトランザクションで、案を作り直し、
 * 画面が見た金額（expected.amount）と比べてから 001 の createJournal → adjustment_journal_refs。
 * 締め済みの年度は PERIOD_CLOSED、案がなければ ADJUSTMENT_NOT_NEEDED、金額が違えば
 * ADJUSTMENT_CHANGED（details.proposal に新しい案）。参照の登録で例外が出ると仕訳も残らない
 */
export function commitAdjustment(
  deps: CommitAdjustmentDeps,
  params: CommitAdjustmentParams,
): Result<CommittedAdjustment> {
  return deps.uow.run((tx) => {
    const period = resolveYear(tx.masters, params.fiscalYear);
    if (!period.ok) return period;
    if (period.value.status === "closed") {
      return err(
        domainError(
          "PERIOD_CLOSED",
          `${params.fiscalYear}年度は締め済みです。決算整理の仕訳を登録するには締めを解除してください`,
          { fiscalYear: params.fiscalYear, suggest: "reopen_period" },
        ),
      );
    }

    const rebuilt = rebuildProposal(
      {
        masters: tx.masters,
        closing: tx.closing,
        reports: deps.reports,
        // 登録済みの判定は参照の仕訳そのものの状態（日付を年度の外へ訂正しても二重に登録しない。INV-60）
        isActiveJournal: (journalId) => tx.ledger.getJournal(journalId)?.status === "active",
      },
      period.value,
      params.kind,
      params.sourceId,
    );
    if (!rebuilt.ok) return rebuilt;
    const { proposal, reason } = rebuilt.value;
    if (proposal === null) {
      return err(
        domainError("ADJUSTMENT_NOT_NEEDED", "登録する決算整理の仕訳はありません", {
          kind: params.kind,
          sourceId: params.sourceId,
          reason,
        }),
      );
    }
    const amount = debitTotal(proposal);
    if (amount !== params.expected.amount) {
      return err(
        domainError(
          "ADJUSTMENT_CHANGED",
          "帳簿が変わったため、仕訳の案の金額が変わりました。新しい案を確かめてください",
          { expected: params.expected.amount, actual: amount, proposal },
        ),
      );
    }

    const created = createJournal(
      { ledger: tx.ledger, masters: tx.masters, ids: deps.ids, clock: deps.clock },
      proposal.journal,
    );
    if (!created.ok) return created;
    const ref: AdjustmentRef = {
      journalId: created.value.journal.id,
      kind: params.kind,
      allocationId: params.kind === "home_use" ? params.sourceId : null,
      assetId: params.kind === "depreciation" ? params.sourceId : null,
      deferredAssetId: params.kind === "deferred_amortization" ? params.sourceId : null,
      fiscalYear: params.fiscalYear,
    };
    tx.closing.insertAdjustmentRef(ref);
    return ok({ journal: created.value.journal, ref, warnings: created.value.warnings });
  });
}

// ---- 申告の控え・提出書類（US6。FR-033〜036） ----

/** 控え・書類の保存の依存。決算書の計算に使わず、履歴（closing_audit_log）にも残さないので Clock は要らない */
export type TaxReturnRecordDeps = {
  masters: MasterRepository;
  closing: ClosingStore;
  ids: IdGenerator;
};

const invalid = (field: string, message: string): Result<never> => validation(message, { field });

/** ファイルの場所（R13）。相対パスはサーバーの作業ディレクトリに依存するため拒否する。中身は読まない */
function checkFilePath(value: string | null | undefined, required: boolean): Result<string | null> {
  if (value == null || value === "") {
    return required ? invalid("filePath", "ファイルの場所を入力してください") : ok(null);
  }
  if (!value.startsWith("/") || value.length > 1000) {
    return invalid("filePath", "絶対パス（/ で始まる）を入力してください");
  }
  return ok(value);
}

const checkMemoText = (value: string | null | undefined): Result<string | null> =>
  value != null && value.length > TAX_RETURN_MEMO_MAX
    ? invalid("memo", `メモは ${TAX_RETURN_MEMO_MAX} 文字以内で入力してください`)
    : ok(value ?? null);

/** 事業所得以外の控えの一覧（FR-033）。ファイルの有無はサーバーが付ける（R13） */
export function listTaxReturnMemos(
  deps: Pick<TaxReturnRecordDeps, "masters" | "closing">,
  params: { fiscalYear: number },
): Result<TaxReturnMemo[]> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  return ok(deps.closing.listTaxReturnMemos(params.fiscalYear));
}

/**
 * 事業所得以外の控え（給与・社会保険料・寄附金など）を登録・更新する（FR-033）。params.id があれば
 * 更新（同じ年度の控えだけ）、なければ作る。決算書の計算には使わない（FR-034）。履歴は残さない
 */
export function saveTaxReturnMemo(
  deps: TaxReturnRecordDeps,
  params: TaxReturnMemoInput & { fiscalYear: number; id?: string },
): Result<TaxReturnMemo> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  if (
    params.id !== undefined &&
    !deps.closing.listTaxReturnMemos(params.fiscalYear).some((m) => m.id === params.id)
  ) {
    return invalid("id", "控えが見つかりません");
  }
  const label = params.label?.trim() || null;
  if (params.kind === "other" && label === null) {
    return invalid("label", "「その他」のときは項目名を入力してください");
  }
  if (label !== null && label.length > TAX_RETURN_LABEL_MAX) {
    return invalid("label", `項目名は ${TAX_RETURN_LABEL_MAX} 文字以内で入力してください`);
  }
  const amount = params.amount ?? null;
  if (amount !== null && (!Number.isInteger(amount) || amount < 0)) {
    return invalid("amount", "金額は 0 以上の整数で入力してください");
  }
  const filePath = checkFilePath(params.filePath, false);
  if (!filePath.ok) return filePath;
  const memo = checkMemoText(params.memo);
  if (!memo.ok) return memo;
  const saved: TaxReturnMemo = {
    id: params.id ?? deps.ids.next(),
    fiscalYear: params.fiscalYear,
    kind: params.kind,
    label,
    amount,
    filePath: filePath.value,
    memo: memo.value,
  };
  deps.closing.upsertTaxReturnMemo(saved);
  return ok(saved);
}

/** 控えを削除する（計算に使わないので物理削除する）。その年度にない id は VALIDATION */
export function deleteTaxReturnMemo(
  deps: Pick<TaxReturnRecordDeps, "masters" | "closing">,
  params: { fiscalYear: number; id: string },
): Result<null> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  if (!deps.closing.listTaxReturnMemos(params.fiscalYear).some((m) => m.id === params.id)) {
    return invalid("id", "控えが見つかりません");
  }
  deps.closing.deleteTaxReturnMemo(params.id);
  return ok(null);
}

/** 提出書類の記録の一覧（FR-035）。ファイルの有無はサーバーが付ける（R13） */
export function listFiledDocuments(
  deps: Pick<TaxReturnRecordDeps, "masters" | "closing">,
  params: { fiscalYear: number },
): Result<FiledDocument[]> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  return ok(deps.closing.listFiledDocuments(params.fiscalYear));
}

/**
 * 提出書類（青色申告決算書・確定申告書・添付書類など）の場所を記録・更新する（FR-035）。
 * params.id があれば更新（同じ年度の記録だけ）、なければ作る。決算書の計算には使わない。履歴は残さない
 */
export function saveFiledDocument(
  deps: TaxReturnRecordDeps,
  params: FiledDocumentInput & { fiscalYear: number; id?: string },
): Result<FiledDocument> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  if (
    params.id !== undefined &&
    !deps.closing.listFiledDocuments(params.fiscalYear).some((d) => d.id === params.id)
  ) {
    return invalid("id", "書類の記録が見つかりません");
  }
  const filePath = checkFilePath(params.filePath, true);
  if (!filePath.ok) return filePath;
  const filedOn = params.filedOn ?? null;
  if (
    filedOn !== null &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(filedOn) || Number.isNaN(Date.parse(filedOn)))
  ) {
    return invalid("filedOn", "提出日は YYYY-MM-DD で入力してください");
  }
  const memo = checkMemoText(params.memo);
  if (!memo.ok) return memo;
  const saved: FiledDocument = {
    id: params.id ?? deps.ids.next(),
    fiscalYear: params.fiscalYear,
    kind: params.kind,
    filePath: params.filePath,
    filedOn,
    memo: memo.value,
  };
  deps.closing.upsertFiledDocument(saved);
  return ok(saved);
}

/** 提出書類の記録を削除する（ファイルそのものには触れない）。その年度にない id は VALIDATION */
export function deleteFiledDocument(
  deps: Pick<TaxReturnRecordDeps, "masters" | "closing">,
  params: { fiscalYear: number; id: string },
): Result<null> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  if (!deps.closing.listFiledDocuments(params.fiscalYear).some((d) => d.id === params.id)) {
    return invalid("id", "書類の記録が見つかりません");
  }
  deps.closing.deleteFiledDocument(params.id);
  return ok(null);
}
