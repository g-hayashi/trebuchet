import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PastedRow } from "../../src/statements/paste.ts";
import {
  type ExistingStatement,
  planStatementImport,
  type StatementImportPlan,
} from "../../src/statements/plan.ts";
import { accountsFor, pastedRowsArb, permutationOf } from "../statements-arbitraries.ts";

// 006 INV-40: 同じ入力を何回取り込んでも、2 回目以降に加わる明細は 0 件。行の順に依らない

const accounts = accountsFor();

/** 計画の new の行を取り込んだ後の既存の明細にする（確定の効果の写し） */
const afterCommit = (
  plan: StatementImportPlan,
  existing: ExistingStatement[],
): ExistingStatement[] => [
  ...existing,
  ...plan.rows
    .filter((r) => r.status === "new")
    .map((r) => ({
      id: `id-${r.key}`,
      stableKey: r.key,
      externalId: r.row.externalId ?? null,
      accountName: r.row.accountName,
      date: r.row.date,
      amount: r.row.amount,
      content: r.row.content,
      categoryMajor: r.row.categoryMajor ?? null,
      categoryMinor: r.row.categoryMinor ?? null,
      memo: r.row.memo ?? null,
    })),
];

const newKeys = (plan: StatementImportPlan) =>
  plan.rows
    .filter((r) => r.status === "new")
    .map((r) => r.key)
    .sort();

describe("INV-40 取込の冪等", () => {
  it("同じ入力の 2 回目は新規 0 件（何回でも）", () => {
    fc.assert(
      fc.property(pastedRowsArb, (rows) => {
        const first = planStatementImport(rows, [], accounts);
        const stored = afterCommit(first, []);
        for (let i = 0; i < 2; i++) {
          const again = planStatementImport(rows, stored, accounts);
          expect(again.countNew).toBe(0);
          expect(again.countExisting).toBe(rows.length);
        }
      }),
    );
  });

  it("1 回目に加わる件数は、入力の行数に等しい（空の帳簿）", () => {
    fc.assert(
      fc.property(pastedRowsArb, (rows) => {
        expect(planStatementImport(rows, [], accounts).countNew).toBe(rows.length);
      }),
    );
  });

  it("行の順を入れ替えても、加わる明細の集合は同じ", () => {
    fc.assert(
      fc.property(
        pastedRowsArb.chain((rows) => fc.tuple(fc.constant(rows), permutationOf(rows))),
        ([rows, shuffled]) => {
          expect(newKeys(planStatementImport(shuffled, [], accounts))).toEqual(
            newKeys(planStatementImport(rows, [], accounts)),
          );
        },
      ),
    );
  });

  it("一部が取込済みでも、入力全体を取り込めば最終的な明細の集合は同じ（行の順に依らない）", () => {
    fc.assert(
      fc.property(
        pastedRowsArb.chain((rows) =>
          fc.tuple(
            fc.constant(rows),
            fc.integer({ min: 0, max: rows.length }),
            permutationOf(rows),
          ),
        ),
        ([rows, split, shuffled]) => {
          const part: PastedRow[] = rows.slice(0, split);
          const stored = afterCommit(planStatementImport(part, [], accounts), []);
          const full = afterCommit(planStatementImport(shuffled, stored, accounts), stored);
          const direct = afterCommit(planStatementImport(rows, [], accounts), []);
          expect(full.map((e) => e.stableKey).sort()).toEqual(
            direct.map((e) => e.stableKey).sort(),
          );
        },
      ),
    );
  });
});
