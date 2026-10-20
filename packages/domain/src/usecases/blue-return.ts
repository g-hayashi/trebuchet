import type {
  AdjustmentProposal,
  BlueReturn,
  FixedAssetInput,
  HomeUseAllocationInput,
  RentDetailInput,
} from "@trebuchet/schema";
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
import type {
  Clock,
  ClosingStore,
  ClosingUnitOfWork,
  IdGenerator,
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
  type DomainWarning,
  domainError,
  err,
  type FiscalPeriod,
  type FixedAsset,
  type HomeUseAllocation,
  type Journal,
  ok,
  type RentDetail,
  type Result,
} from "../types.ts";
import { createJournal } from "./create-journal.ts";
import type { ReportDeps } from "./reports.ts";

/** 決算書の参照の依存。帳簿は 001 の ReportDeps、決算の設定は ClosingStore から読む */
export type BlueReturnDeps = ReportDeps & { closing: ClosingStore };

/** 控除の回答の保存の依存 */
export type DeductionAnswersDeps = {
  masters: MasterRepository;
  closing: ClosingStore;
  ids: IdGenerator;
  clock: Clock;
};

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
  return period === undefined
    ? err(domainError("VALIDATION", "会計期間が見つかりません", { fiscalYear }))
    : ok(period);
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
      opening: deps.reports.openingBalances(params.fiscalYear),
      priorPeriod: readPriorPeriod(deps, params.fiscalYear),
      closingNotes: deps.closing.listClosingNotes(params.fiscalYear),
    }),
  );
}

/** 決算のメモの長さの上限（schema の ClosingNoteInput と同じ） */
const CLOSING_NOTE_MAX = 5000;

/**
 * 決算のメモ（特殊事情・期首と前期末の差の説明）を年度・種類ごとに保存する（FR-027、FR-030）。
 * 本文は前後の空白を除く。closing_audit_log に closing_note（対象は `年度:種類`。初回は create、
 * 以降は update。変更前・後）を残す。締め済みの年度でも保存できる（メモは帳簿ではない。差額も変わらない）
 */
export function saveClosingNote(
  deps: ClosingSettingsDeps,
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
  deps.closing.appendClosingAudit({
    id: deps.ids.next(),
    occurredAt: now,
    targetType: "closing_note",
    targetId: `${params.fiscalYear}:${params.kind}`,
    action: before === undefined ? "create" : "update",
    reason: null,
    beforeJson: before === undefined ? null : JSON.stringify(before),
    afterJson: JSON.stringify(saved),
  });
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
  deps: Pick<DeductionAnswersDeps, "masters" | "closing">,
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
  deps: DeductionAnswersDeps,
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
  deps.closing.appendClosingAudit({
    id: deps.ids.next(),
    occurredAt: now,
    targetType: "blue_deduction_answer",
    targetId: String(params.fiscalYear),
    action: before === undefined ? "create" : "update",
    reason: null,
    beforeJson: before === undefined ? null : JSON.stringify(before),
    afterJson: JSON.stringify(saved),
  });
  return ok(viewOf(saved, period.value, deps.closing));
}

// ---- 家事按分・地代家賃の内訳（US2） ----

/** 決算の設定（按分・内訳）の保存の依存 */
export type ClosingSettingsDeps = {
  masters: MasterRepository;
  closing: ClosingStore;
  ids: IdGenerator;
  clock: Clock;
};

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
  deps.closing.appendClosingAudit({
    id: deps.ids.next(),
    occurredAt: now,
    targetType: "home_use_allocation",
    targetId: saved.id,
    action: before === undefined ? "create" : "update",
    reason: saved.changeReason,
    beforeJson: before === undefined ? null : JSON.stringify(before),
    afterJson: JSON.stringify(saved),
  });
  return ok(saved);
}

/**
 * 年度の家事按分の登録と、前の年度の登録（GET .../home-use）。画面が前の年度の割合を見せて、
 * 割合を変えたときの理由の入力を促すのに使う
 */
export function listHomeUseAllocations(
  deps: Pick<ClosingSettingsDeps, "masters" | "closing">,
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
  deps: Pick<ClosingSettingsDeps, "masters" | "closing">,
  params: { fiscalYear: number },
): Result<RentDetail[]> {
  const period = resolveYear(deps.masters, params.fiscalYear);
  if (!period.ok) return period;
  return ok(deps.closing.listRentDetails(params.fiscalYear));
}

const YEN_LIMIT = 1_000_000_000_000;

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
    deps.closing.appendClosingAudit({
      id: deps.ids.next(),
      occurredAt: deps.clock.now(),
      targetType: "rent_detail",
      targetId: String(params.fiscalYear),
      action: before.length === 0 ? "create" : rows.length === 0 ? "delete" : "update",
      reason: null,
      beforeJson: before.length === 0 ? null : JSON.stringify(before),
      afterJson: rows.length === 0 ? null : JSON.stringify(rows),
    });
  }
  return ok(rows);
}

// ---- 固定資産台帳（US3） ----

/** 台帳の1行。fiscalYear を指定したときだけその年の償却の計算（なければ null） */
export type FixedAssetWithDepreciation = FixedAsset & { depreciation: Depreciation | null };

/**
 * 固定資産の台帳（GET /fixed-assets）。fiscalYear があれば各資産に depreciate の結果を付ける。
 * 並び順は ClosingStore の順。会計期間があるかどうかは問わない
 */
export function listFixedAssets(
  deps: Pick<ClosingSettingsDeps, "masters" | "closing">,
  params: { fiscalYear?: number },
): Result<FixedAssetWithDepreciation[]> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  const { fiscalYear } = params;
  return ok(
    deps.closing.listFixedAssets().map((asset) => ({
      ...asset,
      depreciation: fiscalYear === undefined ? null : depreciate(asset, fiscalYear),
    })),
  );
}

/**
 * 固定資産を登録・更新する（FR-018〜020）。params.id があれば更新（作成日時と除却の日はそのまま。
 * 年間の上限の合計から自分自身を除く）、なければ作る。closing_audit_log に fixed_asset（create / update、
 * 理由、変更前・後）を残す。締め済みの年度の取得でも登録できる（仕訳の案の確定は commitAdjustment が拒否する）
 */
export function saveFixedAsset(
  deps: ClosingSettingsDeps,
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
      businessRatio: params.businessRatio,
      assetAccountId: params.assetAccountId,
      linkedJournalId: params.linkedJournalId ?? null,
      note: params.note ?? null,
    },
    all,
    { accounts: deps.masters.listAccounts(), taxParameters: deps.closing.listTaxParameters() },
  );
  if (!validated.ok) return validated;

  const now = deps.clock.now();
  const { id: _draftId, ...fields } = validated.value;
  const saved: FixedAsset = {
    ...fields,
    id: before?.id ?? deps.ids.next(),
    disposedOn: before?.disposedOn ?? null,
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  };
  deps.closing.upsertFixedAsset(saved);
  deps.closing.appendClosingAudit({
    id: deps.ids.next(),
    occurredAt: now,
    targetType: "fixed_asset",
    targetId: saved.id,
    action: before === undefined ? "create" : "update",
    reason: params.reason?.trim() || null,
    beforeJson: before === undefined ? null : JSON.stringify(before),
    afterJson: JSON.stringify(saved),
  });
  return ok(saved);
}

/**
 * 固定資産を除却する（disposed_on を記録。物理削除はしない）。closing_audit_log に
 * fixed_asset（dispose、理由、変更前・後）を残す。資産がなければ、除却の日の形が違う・取得の日より前なら VALIDATION
 */
export function disposeFixedAsset(
  deps: ClosingSettingsDeps,
  params: { id: string; disposedOn: string; reason: string },
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
  if (params.disposedOn < before.acquiredOn) {
    return err(
      domainError("VALIDATION", "除却の日は取得年月日以後にしてください", {
        field: "disposedOn",
        acquiredOn: before.acquiredOn,
      }),
    );
  }
  const now = deps.clock.now();
  const saved: FixedAsset = { ...before, disposedOn: params.disposedOn, updatedAt: now };
  deps.closing.upsertFixedAsset(saved);
  deps.closing.appendClosingAudit({
    id: deps.ids.next(),
    occurredAt: now,
    targetType: "fixed_asset",
    targetId: saved.id,
    action: "dispose",
    reason: params.reason.trim() || null,
    beforeJson: JSON.stringify(before),
    afterJson: JSON.stringify(saved),
  });
  return ok(saved);
}

// ---- 決算整理の仕訳の案と確定（R4〜R6） ----

/** 案の作り直しに使う読み取り（トランザクションの中でも外でも同じ形） */
type ProposalSources = {
  masters: Pick<MasterRepository, "listAccounts">;
  closing: Pick<ClosingStore, "listHomeUseAllocations" | "listAdjustmentRefs" | "listFixedAssets">;
  reports: Pick<ReportRepository, "linesInRange">;
};

/**
 * 減価償却の案。結びつけた仕訳のある資産・取得した年以外は proposeDepreciationAdjustment が null にする。
 * すでに有効な（取り消されていない）償却の仕訳が出所で登録されている資産も、案を作らない
 */
function assessDepreciation(
  src: ProposalSources,
  period: FiscalPeriod,
  asset: FixedAsset,
): Result<RebuiltProposal> {
  const proposed = proposeDepreciationAdjustment(
    asset,
    period.fiscalYear,
    src.masters.listAccounts(),
  );
  if (!proposed.ok) return proposed;
  if (proposed.value === null) {
    return ok({
      proposal: null,
      reason: asset.linkedJournalId === null ? "NOT_APPLICABLE" : "LINKED_JOURNAL",
    });
  }
  const journals = new Set(
    src.closing
      .listAdjustmentRefs(period.fiscalYear)
      .filter((r) => r.kind === "depreciation" && r.assetId === asset.id)
      .map((r) => r.journalId),
  );
  const registered =
    journals.size > 0 &&
    src.reports
      .linesInRange(period.startDate, period.endDate)
      .some((l) => l.status === "active" && journals.has(l.journalId));
  return ok(
    registered
      ? { proposal: null, reason: "ALREADY_REGISTERED" }
      : { proposal: proposed.value, reason: null },
  );
}

function assessHomeUse(
  src: ProposalSources,
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
 * そのあとにこの年度に取得した資産の償却の案（台帳の順）
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
  for (const asset of deps.closing.listFixedAssets()) {
    const assessed = assessDepreciation(deps, period.value, asset);
    if (!assessed.ok) return assessed;
    if (assessed.value.proposal !== null) proposals.push(assessed.value.proposal);
  }
  return ok(proposals);
}

/** 償却の案を作らない理由 */
type DepreciationNoProposalReason =
  /** 既存の仕訳を結びつけてある（FR-022） */
  | "LINKED_JOURNAL"
  /** この年度に取得した資産でない、または年度末日までに除却した */
  | "NOT_APPLICABLE"
  /** 償却の仕訳がすでに登録されている */
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
  return deps.uow.transaction((tx) => {
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
      { masters: tx.masters, closing: tx.closing, reports: deps.reports },
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
      { ledger: tx.journals, masters: tx.masters, ids: deps.ids, clock: deps.clock },
      proposal.journal,
    );
    if (!created.ok) return created;
    const ref: AdjustmentRef = {
      journalId: created.value.journal.id,
      kind: params.kind,
      allocationId: params.kind === "home_use" ? params.sourceId : null,
      assetId: params.kind === "depreciation" ? params.sourceId : null,
      fiscalYear: params.fiscalYear,
    };
    tx.closing.insertAdjustmentRef(ref);
    return ok({ journal: created.value.journal, ref, warnings: created.value.warnings });
  });
}
