import type { BlockedReason, Recurring } from "@trebuchet/schema";
import { dateInMonth, monthAtIndex, monthIndex, monthOfDate } from "../dates.ts";
import { checkPeriod, type JournalContext, validateJournal } from "../journal.ts";
import type { JournalDraft, LineDraft, Partner } from "../types.ts";

/** 回の計画に使うマスタ。001 の検証の文脈に、取引先の使用停止の情報を足す（`validateJournal` は見ない） */
export type RecurringContext = Omit<JournalContext, "partners"> & {
  partners: readonly Pick<Partner, "id" | "isActive">[];
};

/** 登録する回: 対象月・予定日・仕訳の案 */
export type PlannedRun = { month: string; date: string; draft: JournalDraft };

/** 登録できない回（保存しない計算上の値。data-model §1.9）。`details.code` は `JOURNAL_INVALID` のとき元のコード */
export type BlockedPlan = {
  month: string;
  date: string;
  reason: BlockedReason;
  details?: { code: string };
};

export type RecurringPlan = { post: PlannedRun[]; blocked: BlockedPlan[] };

/** 定義の行を仕訳の行の案にする（`null` は省略。税区分の省略は各回の予定日の既定で決まる。R16） */
export function recurringLineDrafts(lines: Recurring["lines"]): LineDraft[] {
  return lines.map((l) => ({
    side: l.side,
    accountId: l.accountId,
    ...(l.subAccountId === null ? {} : { subAccountId: l.subAccountId }),
    amount: l.amount,
    ...(l.taxCategory === null ? {} : { taxCategory: l.taxCategory }),
    ...(l.partnerId === null ? {} : { partnerId: l.partnerId }),
    ...(l.description === null ? {} : { description: l.description }),
  }));
}

/** 定義から、ある月の仕訳の案を作る */
export function recurringJournalDraft(
  def: Pick<Recurring, "memo" | "dayOfMonth" | "lines">,
  month: string,
): JournalDraft {
  return {
    date: dateInMonth(month, def.dayOfMonth),
    ...(def.memo === null ? {} : { memo: def.memo }),
    lines: recurringLineDrafts(def.lines),
  };
}

/** `validateJournal` が返したエラーのうち、`blocked` の専用の理由になるコード（優先順） */
const SPECIFIC_REASONS = [
  "PERIOD_CLOSED",
  "OUT_OF_PERIOD",
  "ACCOUNT_INACTIVE",
  "ACCOUNT_NOT_FOUND",
] as const;

/**
 * ある月の仕訳の案が登録できない理由。登録できるなら undefined。
 * 001 の `checkPeriod`・`validateJournal` を通し、専用の理由（期間・科目）→ 取引先の使用停止 →
 * それ以外（税設定の空白、未対応の計算方法、補助科目の停止など）は `JOURNAL_INVALID`（元のコードを `details.code` に）
 */
export function blockedReason(
  draft: JournalDraft,
  ctx: RecurringContext,
): Pick<BlockedPlan, "reason" | "details"> | undefined {
  const period = checkPeriod(draft.date, ctx.periods);
  if (!period.ok) {
    const code = period.error.code as BlockedReason;
    return { reason: code };
  }
  const validated = validateJournal(draft, ctx);
  const errors = validated.ok ? [] : validated.error;
  for (const code of SPECIFIC_REASONS) {
    if (errors.some((e) => e.code === code)) return { reason: code };
  }
  const inactive = new Set(ctx.partners.filter((p) => !p.isActive).map((p) => p.id));
  if (draft.lines.some((l) => l.partnerId !== undefined && inactive.has(l.partnerId))) {
    return { reason: "PARTNER_INACTIVE" };
  }
  if (validated.ok) return undefined;
  const first = errors[0];
  return { reason: "JOURNAL_INVALID", details: { code: first?.code ?? "VALIDATION" } };
}

/**
 * どの回を登録するかを決める純関数（005 R17、INV-35）。
 * 対象の月は `start_month` 〜 `min(end_month, 今日の月)` のうち、予定日が今日以前で `doneMonths`
 * （登録済み・飛ばした月）にない月。`paused` は空。登録できない回は `blocked`（保存しない）
 */
export function planRecurringRuns(input: {
  def: Recurring;
  today: string;
  doneMonths: Iterable<string>;
  ctx: RecurringContext;
}): RecurringPlan {
  const { def, today, ctx } = input;
  const plan: RecurringPlan = { post: [], blocked: [] };
  if (def.status === "paused") return plan;

  const done = new Set(input.doneMonths);
  const todayIndex = monthIndex(monthOfDate(today));
  const last = def.endMonth === null ? todayIndex : Math.min(monthIndex(def.endMonth), todayIndex);
  for (let i = monthIndex(def.startMonth); i <= last; i++) {
    const month = monthAtIndex(i);
    const date = dateInMonth(month, def.dayOfMonth);
    if (date > today || done.has(month)) continue;
    const draft = recurringJournalDraft(def, month);
    const blocked = blockedReason(draft, ctx);
    if (blocked === undefined) plan.post.push({ month, date, draft });
    else plan.blocked.push({ month, date, ...blocked });
  }
  return plan;
}
