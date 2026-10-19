import type { ErrorCode } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Journal, Result } from "../src/types.ts";
import { closePeriod, reopenPeriod } from "../src/usecases/close-period.ts";
import { correctJournal } from "../src/usecases/correct-journal.ts";
import { createJournal } from "../src/usecases/create-journal.ts";
import { voidJournal } from "../src/usecases/void-journal.ts";
import { balancedLinesArb, dateInPeriodArb } from "./arbitraries.ts";
import { setupLedger } from "./ledger-fixture.ts";

const template = setupLedger();
const accounts = template.masters.listAccounts().filter((a) => a.isActive);
const YEARS = [2025, 2026] as const;
type Year = (typeof YEARS)[number];

const yearArb = fc.constantFrom(...YEARS);
const dateArb = fc.oneof(...YEARS.map((y) => dateInPeriodArb(template.period(y))));
const linesArb = balancedLinesArb(accounts);
const reasonArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
/** 操作の対象の仕訳（既存の仕訳の数で割った余りで選ぶ） */
const pickArb = fc.nat();

const operationArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("create"), date: dateArb, lines: linesArb }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("correct"),
      pick: pickArb,
      date: dateArb,
      lines: linesArb,
      reason: reasonArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("void"), pick: pickArb, reason: reasonArb }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("close"), year: yearArb }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("reopen"), year: yearArb, reason: reasonArb }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("correcting"),
      pick: pickArb,
      date: dateArb,
      lines: linesArb,
    }),
  },
);
type Operation = typeof operationArb extends fc.Arbitrary<infer O> ? O : never;

const yearOf = (date: string) => Number(date.slice(0, 4)) as Year;

describe("仕訳の操作列（INV-7, INV-8, INV-1, Constitution I・V）", () => {
  it("登録・訂正・取消・締め・解除・訂正仕訳をどの順に行っても、締め済みの期間の仕訳は変わらず、仕訳番号は 1 から連続し、有効な仕訳は貸借一致する", () => {
    fc.assert(
      fc.property(fc.array(operationArb, { minLength: 10, maxLength: 40 }), (operations) => {
        const f = setupLedger();
        const masterDeps = { repo: f.masters, ids: f.ids, clock: f.clock };
        /** 締め済みの年度ごとの、締めた時点のその期間の仕訳 */
        const snapshots = new Map<Year, Journal[]>();
        const isClosed = (date: string) => snapshots.has(yearOf(date));
        const journalsOf = (year: Year) =>
          f.ledger.journals
            .filter((j) => j.fiscalPeriodId === f.period(year).id)
            .map((j) => structuredClone(j));
        const pick = (n: number) => {
          const all = f.ledger.journals;
          return all.length === 0 ? undefined : all[n % all.length];
        };

        /** 操作の結果を、モデル（締め済みの年度の集合）から予想できる結果と照らす */
        const expectOutcome = (result: Result<unknown>, expected: ErrorCode | "ok") => {
          expect(result.ok ? "ok" : result.error.code).toBe(expected);
        };

        const run = (op: Operation) => {
          switch (op.kind) {
            case "create": {
              const r = createJournal(f.deps, { date: op.date, lines: op.lines });
              expectOutcome(r, isClosed(op.date) ? "PERIOD_CLOSED" : "ok");
              return;
            }
            case "correct": {
              const target = pick(op.pick);
              if (target === undefined) return;
              const r = correctJournal(f.deps, target.id, {
                date: op.date,
                lines: op.lines,
                reason: op.reason,
                version: target.version,
              });
              expectOutcome(
                r,
                target.status === "voided"
                  ? "JOURNAL_VOIDED"
                  : isClosed(target.date) || isClosed(op.date)
                    ? "PERIOD_CLOSED"
                    : "ok",
              );
              return;
            }
            case "void": {
              const target = pick(op.pick);
              if (target === undefined) return;
              const r = voidJournal(f.deps, target.id, {
                reason: op.reason,
                version: target.version,
              });
              expectOutcome(
                r,
                target.status === "voided"
                  ? "JOURNAL_VOIDED"
                  : isClosed(target.date)
                    ? "PERIOD_CLOSED"
                    : "ok",
              );
              return;
            }
            case "close": {
              expectOutcome(closePeriod(masterDeps, op.year), "ok");
              if (!snapshots.has(op.year)) snapshots.set(op.year, journalsOf(op.year));
              return;
            }
            case "reopen": {
              expectOutcome(reopenPeriod(masterDeps, op.year, { reason: op.reason }), "ok");
              snapshots.delete(op.year);
              return;
            }
            case "correcting": {
              const target = pick(op.pick);
              if (target === undefined) return;
              const r = createJournal(f.deps, {
                date: op.date,
                lines: op.lines,
                correctsJournalId: target.id,
              });
              expectOutcome(
                r,
                isClosed(op.date) ? "PERIOD_CLOSED" : isClosed(target.date) ? "ok" : "VALIDATION",
              );
              return;
            }
          }
        };

        operations.forEach((op, i) => {
          f.clock.value = new Date(Date.UTC(2027, 0, 1, 0, i)).toISOString();
          run(op);

          // INV-7: 締め済みの期間の仕訳（内容・状態・version）が締めた時点と一致する
          for (const [year, snapshot] of snapshots) {
            expect(f.period(year).status).toBe("closed");
            expect(journalsOf(year)).toEqual(snapshot);
          }
          for (const year of YEARS) {
            if (!snapshots.has(year)) expect(f.period(year).status).toBe("open");
          }
          // INV-8: 仕訳番号は 1 から抜けなく増え、重複しない
          const numbers = f.ledger.journals.map((j) => j.journalNo).sort((a, b) => a - b);
          expect(numbers).toEqual(numbers.map((_, k) => k + 1));
          // INV-1: 有効な仕訳はすべて貸借一致する
          for (const j of f.ledger.journals.filter((x) => x.status === "active")) {
            const sum = (side: "debit" | "credit") =>
              j.lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);
            expect(sum("debit")).toBe(sum("credit"));
          }
        });
      }),
      { numRuns: 100 },
    );
  });
});
