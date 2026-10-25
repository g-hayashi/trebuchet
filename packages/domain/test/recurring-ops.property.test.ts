import type { RecurringInput } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { dateInMonth, monthAtIndex, monthIndex } from "../src/dates.ts";
import { planRecurringRuns } from "../src/recurring/due.ts";
import { loadContext } from "../src/usecases/create-journal.ts";
import {
  createRecurring,
  pauseRecurring,
  postDueRecurring,
  resumeRecurring,
  skipRecurringRun,
  updateRecurring,
} from "../src/usecases/recurring.ts";
import { voidJournal } from "../src/usecases/void-journal.ts";
import {
  arbRecurringOps,
  arbToday,
  type DefSpec,
  type RecurringOp,
  toRecurring,
} from "./recurring-arbitraries.ts";
import { setupRecurring } from "./recurring-setup.ts";
import { MONTH_START_NOW } from "./test-dates.ts";

// INV-35: 任意の定期仕訳の定義の集合と、起動の日の列（同じ日の重複、停止・再開・変更・締め・締めの解除・取消を挟む）で
// postDueRecurring を繰り返しても、各（定期仕訳, 月）の posted は高々 1 件、最後の判定の後は active の定義の
// 対象の月がすべて posted・skipped・blocked のどれか 1 つ、仕訳の日付は dateInMonth、取り消しても再登録されない

const NOW = MONTH_START_NOW;

const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** 通った経路の数。末尾で、生成した列が実際に各経路を通ったことを表明する */
const stats = {
  created: 0,
  posted: 0,
  duplicateTicks: 0,
  paused: 0,
  resumed: 0,
  updated: 0,
  closed: 0,
  reopened: 0,
  voided: 0,
  skipped: 0,
  blockedPeriodClosed: 0,
};

function toInput(spec: DefSpec, t: ReturnType<typeof setupRecurring>): RecurringInput {
  const def = toRecurring(
    spec,
    {
      debitAccountId: t.accountId("地代家賃"),
      creditAccountId: t.accountId("普通預金"),
      activePartnerId: t.partner.id,
      inactivePartnerId: t.inactivePartner.id,
    },
    "tmp",
    NOW,
  );
  return {
    name: def.name,
    memo: "定期",
    dayOfMonth: def.dayOfMonth,
    startMonth: def.startMonth,
    ...(def.endMonth === null ? {} : { endMonth: def.endMonth }),
    confirm: true,
    lines: def.lines.map((l) => ({
      side: l.side,
      accountId: l.accountId,
      amount: l.amount,
      ...(l.partnerId === null ? {} : { partnerId: l.partnerId }),
    })),
  };
}

/** 定義の対象の月: 開始月〜（終了月、または今日の月）のうち予定日が今日以前 */
function targetMonths(
  def: { startMonth: string; endMonth: string | null; dayOfMonth: number },
  today: string,
): string[] {
  const out: string[] = [];
  const last = Math.min(
    def.endMonth === null ? Number.POSITIVE_INFINITY : monthIndex(def.endMonth),
    monthIndex(today.slice(0, 7)),
  );
  for (let i = monthIndex(def.startMonth); i <= last; i++) {
    const month = monthAtIndex(i);
    if (dateInMonth(month, def.dayOfMonth) <= today) out.push(month);
  }
  return out;
}

function runSequence(start: string, ops: RecurringOp[]) {
  const t = setupRecurring();
  let today = start;
  const voided = new Set<string>(); // `${recurringId}|${month}`

  const defs = () => t.recurring.listRecurring();
  const pick = <T>(list: T[], n: number): T | undefined =>
    list.length === 0 ? undefined : list[n % list.length];

  const tick = () => {
    const result = postDueRecurring(t.deps, today);
    expect(result.failed).toEqual([]);
    for (const p of result.posted) {
      const def = t.recurring.getRecurring(p.recurringId);
      expect(def).not.toBeNull();
      if (def === null) continue;
      stats.posted += 1;
      // 停止中の定義は登録しない。開始月以降・終了月以前、予定日が今日以前、日付は dateInMonth
      expect(def.status).toBe("active");
      expect(p.targetMonth >= def.startMonth).toBe(true);
      expect(def.endMonth === null || p.targetMonth <= def.endMonth).toBe(true);
      expect(p.journal.date).toBe(dateInMonth(p.targetMonth, def.dayOfMonth));
      expect(p.journal.date <= today).toBe(true);
      expect(p.journal.source).toBe("recurring");
    }
    const ctx = loadContext(t.masters);
    for (const d of defs()) {
      const blocked = planRecurringRuns({
        def: d,
        today,
        doneMonths: t.recurring.listRuns(d.id).map((r) => r.targetMonth),
        ctx,
      }).blocked;
      if (blocked.some((b) => b.reason === "PERIOD_CLOSED")) stats.blockedPeriodClosed += 1;
    }
  };

  for (const op of ops) {
    switch (op.kind) {
      case "tick": {
        if (op.dayStep === 0) stats.duplicateTicks += 1;
        today = addDays(today, op.dayStep);
        tick();
        break;
      }
      case "create": {
        const r = createRecurring(t.deps, toInput(op.spec, t), today);
        if (r.ok) stats.created += 1;
        break;
      }
      case "pause": {
        const def = pick(defs(), op.target);
        if (def === undefined) break;
        const wasActive = def.status === "active";
        const r = pauseRecurring(t.deps, def.id, { version: def.version });
        if (r.ok && wasActive) stats.paused += 1;
        break;
      }
      case "resume": {
        const def = pick(defs(), op.target);
        if (def === undefined) break;
        const fromMonth = monthAtIndex(monthIndex(today.slice(0, 7)) + op.fromOffset);
        const r = resumeRecurring(
          t.deps,
          def.id,
          { version: def.version, fromMonth, confirm: true },
          today,
        );
        if (r.ok) stats.resumed += 1;
        break;
      }
      case "update": {
        const def = pick(defs(), op.target);
        if (def === undefined) break;
        const r = updateRecurring(
          t.deps,
          def.id,
          {
            name: def.name,
            ...(def.memo === null ? {} : { memo: def.memo }),
            dayOfMonth: op.dayOfMonth,
            startMonth: def.startMonth,
            ...(def.endMonth === null ? {} : { endMonth: def.endMonth }),
            version: def.version,
            confirm: true,
            lines: def.lines.map((l) => ({
              side: l.side,
              accountId: l.accountId,
              amount: op.amount,
              ...(l.partnerId === null ? {} : { partnerId: l.partnerId }),
            })),
          },
          today,
        );
        if (r.ok) stats.updated += 1;
        break;
      }
      case "close": {
        const p = t.masters.getFiscalPeriodByYear(op.year);
        if (p !== undefined && p.status === "open") {
          t.masters.updateFiscalPeriod({ ...p, status: "closed", closedAt: NOW });
          stats.closed += 1;
        }
        break;
      }
      case "reopen": {
        const p = t.masters.getFiscalPeriodByYear(op.year);
        if (p !== undefined && p.status === "closed") {
          t.masters.updateFiscalPeriod({ ...p, status: "open", closedAt: null });
          stats.reopened += 1;
        }
        break;
      }
      case "voidPosted": {
        const posted = t.recurring.listRuns().filter((r) => r.status === "posted");
        const run = pick(posted, op.target);
        const journal = run?.journalId == null ? undefined : t.ledger.getJournal(run.journalId);
        if (run === undefined || journal === undefined || journal.status === "voided") break;
        const r = voidJournal(
          { ledger: t.ledger, masters: t.masters, ids: t.ids, clock: t.clock },
          journal.id,
          { reason: "取消", version: journal.version },
        );
        if (r.ok) {
          voided.add(`${run.recurringId}|${run.targetMonth}`);
          stats.voided += 1;
        }
        break;
      }
      case "skip": {
        const def = pick(defs(), op.target);
        if (def === undefined) break;
        const done = new Set(t.recurring.listRuns(def.id).map((r) => r.targetMonth));
        const pending = targetMonths(def, today).filter((m) => !done.has(m));
        const month = pick(pending, op.pick);
        if (month === undefined) break;
        const r = skipRecurringRun(t.deps, def.id, month, { reason: "不要" }, today);
        expect(r.ok).toBe(true);
        if (r.ok) stats.skipped += 1;
        break;
      }
    }
  }

  // 最後の判定（同じ日に 2 回走らせても同じ）
  tick();
  tick();

  // ---- 不変条件 ----
  const runs = t.recurring.listRuns();
  const key = (r: { recurringId: string; targetMonth: string }) =>
    `${r.recurringId}|${r.targetMonth}`;

  // 各（定期仕訳, 月）の回は高々 1 件、posted の仕訳は 1 回の登録につき 1 件
  expect(new Set(runs.map(key)).size).toBe(runs.length);
  const postedRuns = runs.filter((r) => r.status === "posted");
  const recurringJournals = t.journalsOf().filter((j) => j.source === "recurring");
  expect(recurringJournals).toHaveLength(postedRuns.length);
  expect(new Set(postedRuns.map((r) => r.journalId)).size).toBe(postedRuns.length);
  for (const r of postedRuns) {
    expect(recurringJournals.some((j) => j.id === r.journalId)).toBe(true);
  }
  for (const r of runs.filter((x) => x.status === "skipped")) {
    expect(r.journalId).toBeNull();
    expect(r.skipReason).not.toBeNull();
  }

  // 取り消した仕訳の回は残り、再登録されない
  for (const k of voided) {
    const mine = runs.filter((r) => key(r) === k);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.status).toBe("posted");
  }

  // 漏れなし: active の定義の対象の月は、posted・skipped・blocked のどれか 1 つ
  const ctx = loadContext(t.masters);
  for (const def of defs()) {
    if (def.status !== "active") continue;
    const plan = planRecurringRuns({
      def,
      today,
      doneMonths: runs.filter((r) => r.recurringId === def.id).map((r) => r.targetMonth),
      ctx,
    });
    expect(plan.post).toEqual([]);
    const done = new Set(runs.filter((r) => r.recurringId === def.id).map((r) => r.targetMonth));
    const blocked = new Set(plan.blocked.map((b) => b.month));
    for (const m of targetMonths(def, today)) {
      expect(Number(done.has(m)) + Number(blocked.has(m))).toBe(1);
    }
    for (const m of blocked) expect(done.has(m)).toBe(false);
  }
}

describe("INV-35: 定期仕訳の登録は重複なく漏れない", () => {
  it("任意の定義・起動の日の列・停止・再開・変更・締め・取消の後も、重複せず漏れず、日付は予定日", () => {
    fc.assert(
      fc.property(arbToday, arbRecurringOps, (start, ops) => {
        runSequence(start, ops);
      }),
      { numRuns: 300 },
    );

    // 生成した列が、各経路を実際に通った
    expect(stats.created).toBeGreaterThan(0);
    expect(stats.posted).toBeGreaterThan(0);
    expect(stats.duplicateTicks).toBeGreaterThan(0);
    expect(stats.paused).toBeGreaterThan(0);
    expect(stats.resumed).toBeGreaterThan(0);
    expect(stats.updated).toBeGreaterThan(0);
    expect(stats.closed).toBeGreaterThan(0);
    expect(stats.reopened).toBeGreaterThan(0);
    expect(stats.voided).toBeGreaterThan(0);
    expect(stats.skipped).toBeGreaterThan(0);
    expect(stats.blockedPeriodClosed).toBeGreaterThan(0);
  });
});
