import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { dateInMonth } from "../src/dates.ts";
import { validateJournal } from "../src/journal.ts";
import { planRecurringRuns, type RecurringContext } from "../src/recurring/due.ts";
import { loadContext } from "../src/usecases/create-journal.ts";
import { setupInvoicing } from "./invoicing-setup.ts";
import {
  arbCtxSpec,
  arbDefSpec,
  arbDoneMonths,
  arbToday,
  type CtxSpec,
  indexOfMonth,
  monthFromIndex,
  toRecurring,
} from "./recurring-arbitraries.ts";

// INV-35 の純関数の部分（R17）: post と blocked は互いに素で doneMonths と重ならず、
// 予定日はすべて今日以前、post ∪ blocked ∪ doneMonths が対象の月をすべて覆う

const base = setupInvoicing({ taxable: true });
const activePartner = base.addPartner();
const inactivePartner = base.addPartner({ isActive: false });
const baseCtx = loadContext(base.masters);
const parts = {
  debitAccountId: base.accountId("地代家賃"),
  creditAccountId: base.accountId("普通預金"),
  activePartnerId: activePartner.id,
  inactivePartnerId: inactivePartner.id,
};
const NOW = "2026-10-01T00:00:00.000Z";

function ctxOf(spec: CtxSpec): RecurringContext {
  return {
    ...baseCtx,
    periods: baseCtx.periods.map((p) =>
      (p.fiscalYear === 2025 && spec.closed2025) || (p.fiscalYear === 2026 && spec.closed2026)
        ? { ...p, status: "closed" as const }
        : p,
    ),
    accounts: baseCtx.accounts.map((a) =>
      spec.debitInactive && a.id === parts.debitAccountId ? { ...a, isActive: false } : a,
    ),
  };
}

/** 独立に求めた対象の月: 開始月〜（終了月、なければ十分先）のうち予定日が今日以前の月 */
function targetMonths(
  def: { startMonth: string; endMonth: string | null; dayOfMonth: number },
  today: string,
): string[] {
  const out: string[] = [];
  const last = def.endMonth === null ? indexOfMonth("2030-12") : indexOfMonth(def.endMonth);
  for (let i = indexOfMonth(def.startMonth); i <= last; i++) {
    const month = monthFromIndex(i);
    if (dateInMonth(month, def.dayOfMonth) <= today) out.push(month);
  }
  return out;
}

describe("planRecurringRuns (INV-35 の純関数)", () => {
  it("post と blocked は互いに素で doneMonths と重ならず、予定日は今日以前、対象の月をすべて覆う", () => {
    fc.assert(
      fc.property(arbDefSpec, arbToday, arbDoneMonths, arbCtxSpec, (spec, today, done, ctxSpec) => {
        const def = toRecurring(spec, parts, "rec-1", NOW);
        const result = planRecurringRuns({
          def,
          today,
          doneMonths: new Set(done),
          ctx: ctxOf(ctxSpec),
        });
        const postMonths = result.post.map((p) => p.month);
        const blockedMonths = result.blocked.map((b) => b.month);
        const doneSet = new Set(done);

        if (def.status === "paused") {
          expect(result).toEqual({ post: [], blocked: [] });
          return;
        }

        // 互いに素で、登録済み・飛ばした月と重ならない
        expect(new Set(postMonths).size).toBe(postMonths.length);
        expect(new Set(blockedMonths).size).toBe(blockedMonths.length);
        for (const m of postMonths) expect(blockedMonths).not.toContain(m);
        for (const m of [...postMonths, ...blockedMonths]) expect(doneSet.has(m)).toBe(false);

        // 予定日はすべて今日以前で、dateInMonth と一致する
        for (const p of result.post) {
          expect(p.date).toBe(dateInMonth(p.month, def.dayOfMonth));
          expect(p.date <= today).toBe(true);
          expect(p.draft.date).toBe(p.date);
        }
        for (const b of result.blocked) {
          expect(b.date).toBe(dateInMonth(b.month, def.dayOfMonth));
          expect(b.date <= today).toBe(true);
        }

        // 覆う: 対象の月はすべて post・blocked・doneMonths のどれか。対象の外の月は post・blocked にない
        const target = targetMonths(def, today);
        const covered = new Set([...postMonths, ...blockedMonths, ...done]);
        for (const m of target) expect(covered.has(m)).toBe(true);
        const targetSet = new Set(target);
        for (const m of [...postMonths, ...blockedMonths]) expect(targetSet.has(m)).toBe(true);

        // 月の昇順
        expect(postMonths).toEqual([...postMonths].sort());
        expect(blockedMonths).toEqual([...blockedMonths].sort());
      }),
    );
  });

  it("post の案は 001 の validateJournal を通り、blocked は post に入らない", () => {
    fc.assert(
      fc.property(arbDefSpec, arbToday, arbCtxSpec, (spec, today, ctxSpec) => {
        const def = toRecurring(spec, parts, "rec-1", NOW);
        const ctx = ctxOf(ctxSpec);
        const result = planRecurringRuns({ def, today, doneMonths: [], ctx });
        for (const p of result.post) {
          expect(validateJournal(p.draft, ctx).ok).toBe(true);
          // 使用停止の取引先の行は post に入らない
          for (const line of p.draft.lines) {
            if (line.partnerId !== undefined) {
              expect(ctx.partners.find((x) => x.id === line.partnerId)?.isActive).toBe(true);
            }
          }
        }
      }),
    );
  });

  it("doneMonths に月を足しても、残りの月の計画は変わらない（月ごとに独立）", () => {
    fc.assert(
      fc.property(arbDefSpec, arbToday, arbDoneMonths, arbCtxSpec, (spec, today, done, ctxSpec) => {
        const def = toRecurring(spec, parts, "rec-1", NOW);
        const ctx = ctxOf(ctxSpec);
        const all = planRecurringRuns({ def, today, doneMonths: [], ctx });
        const some = planRecurringRuns({ def, today, doneMonths: done, ctx });
        const skip = new Set(done);
        expect(some.post).toEqual(all.post.filter((p) => !skip.has(p.month)));
        expect(some.blocked).toEqual(all.blocked.filter((b) => !skip.has(b.month)));
      }),
    );
  });
});
