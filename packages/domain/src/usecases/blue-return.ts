import type { BlueReturn } from "@trebuchet/schema";
import { buildBlueReturn } from "../blue-return/build.ts";
import {
  type BlueDeductionCap,
  blueDeductionCap,
  type DeductionRequirementAnswers,
} from "../blue-return/deduction.ts";
import type { Clock, ClosingStore, IdGenerator, MasterRepository } from "../ports.ts";
import {
  type DeductionAnswers,
  domainError,
  err,
  type FiscalPeriod,
  ok,
  type Result,
} from "../types.ts";
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
