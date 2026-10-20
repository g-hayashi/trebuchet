import type {
  AdjustmentProposal,
  BlueReturn,
  HomeUseAllocationInput,
  RentDetailInput,
} from "@trebuchet/schema";
import { buildBlueReturn } from "../blue-return/build.ts";
import {
  type BlueDeductionCap,
  blueDeductionCap,
  type DeductionRequirementAnswers,
} from "../blue-return/deduction.ts";
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
import {
  type AdjustmentKind,
  type AdjustmentRef,
  type DeductionAnswers,
  type DomainWarning,
  domainError,
  err,
  type FiscalPeriod,
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

/**
 * 個人の事業体でなければ ENTITY_KIND_UNSUPPORTED。年度がなければ 001 の締め・解除と同じ
 * VALIDATION（会計期間が見つかりません）。種別の判定が先
 */
function resolveYear(masters: MasterRepository, fiscalYear: number): Result<FiscalPeriod> {
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
  const period = masters.getFiscalPeriodByYear(fiscalYear);
  return period === undefined
    ? err(domainError("VALIDATION", "会計期間が見つかりません", { fiscalYear }))
    : ok(period);
}

/**
 * 青色申告決算書を帳簿から導出する（US1）。仕訳は年度の期間の有効なもの（取消済みを除く。
 * 001 の帳票と同じ読み方）、控除の回答と税制の値は ClosingStore から読む
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
    }),
  );
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

// ---- 決算整理の仕訳の案と確定（R4〜R6） ----

/** 案の作り直しに使う読み取り（トランザクションの中でも外でも同じ形） */
type ProposalSources = {
  masters: Pick<MasterRepository, "listAccounts">;
  closing: Pick<ClosingStore, "listHomeUseAllocations" | "listAdjustmentRefs">;
  reports: Pick<ReportRepository, "linesInRange">;
};

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
 * 決算整理の仕訳の案の一覧（差があるものだけ。FR-014・FR-016）。按分の登録の順。
 * 減価償却の案は US3 で足す
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
  return ok(proposals);
}

type RebuiltProposal = {
  proposal: AdjustmentProposal | null;
  reason: HomeUseNoProposalReason | null;
};

/** 種別ごとに案を作り直す。depreciation は US3（T026 以降）で足す */
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
    case "depreciation":
      return err(
        domainError("VALIDATION", "減価償却の仕訳の案はまだ登録できません", {
          field: "kind",
          kind,
        }),
      );
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
