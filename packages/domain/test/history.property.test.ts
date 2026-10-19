import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Journal } from "../src/types.ts";
import { correctJournal } from "../src/usecases/correct-journal.ts";
import { getJournalHistory } from "../src/usecases/journal-queries.ts";
import { voidJournal } from "../src/usecases/void-journal.ts";
import { balancedLinesArb, dateInPeriodArb } from "./arbitraries.ts";
import { setupLedger } from "./ledger-fixture.ts";

const template = setupLedger();
const accounts = template.masters.listAccounts().filter((a) => a.isActive);
const period2026 = template.period(2026);

const reasonArb = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0);

const operationArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("correct" as const),
      reason: reasonArb,
      date: dateInPeriodArb(period2026),
      memo: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
      lines: balancedLinesArb(accounts),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("void" as const), reason: reasonArb }) },
);

describe("変更履歴（US3, SC-005）", () => {
  it("任意の訂正・取消の列の後、履歴の before_json をたどると、すべての過去の版と理由を復元できる", () => {
    fc.assert(
      fc.property(fc.array(operationArb, { maxLength: 12 }), (operations) => {
        const f = setupLedger();
        const created = f.create();
        /** 各版の仕訳（versions[0] が登録時） */
        const versions: Journal[] = [created];
        const reasons: string[] = [];
        const actions: string[] = [];

        operations.forEach((op, i) => {
          f.clock.value = new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
          const current = versions.at(-1);
          if (current === undefined) throw new Error("版がない");
          const result =
            op.kind === "correct"
              ? correctJournal(f.deps, created.id, {
                  date: op.date,
                  memo: op.memo,
                  lines: op.lines,
                  reason: op.reason,
                  version: current.version,
                })
              : voidJournal(f.deps, created.id, { reason: op.reason, version: current.version });
          if (current.status === "voided") {
            expect(!result.ok && result.error.code).toBe("JOURNAL_VOIDED");
            return;
          }
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          versions.push(result.value);
          reasons.push(op.reason.trim());
          actions.push(op.kind);
        });

        const history = getJournalHistory(f.deps, created.id);
        if (!history.ok) throw new Error(history.error.message);
        const entries = history.value;
        expect(entries.map((e) => e.action)).toEqual(["create", ...actions]);
        expect(entries[0]).toMatchObject({ before: null, reason: null, after: versions[0] });
        // 訂正・取消の各項目の before が、その時点の版（1 つ前の版）と一致する
        expect(entries.slice(1).map((e) => e.before)).toEqual(versions.slice(0, -1));
        expect(entries.slice(1).map((e) => e.reason)).toEqual(reasons);
        // 最後の項目の after が現在の仕訳と一致する
        expect(entries.at(-1)?.after).toEqual(f.ledger.getJournal(created.id));
        expect(versions.map((v) => v.version)).toEqual(versions.map((_, i) => i + 1));
        // 日時の順に並ぶ
        const times = entries.map((e) => e.occurredAt);
        expect(times).toEqual([...times].sort());
      }),
      { numRuns: 60 },
    );
  });

  it("ない仕訳の履歴は JOURNAL_NOT_FOUND", () => {
    const r = getJournalHistory(template.deps, "0000000e-0000-7000-8000-000000000001");
    expect(!r.ok && r.error.code).toBe("JOURNAL_NOT_FOUND");
  });
});
