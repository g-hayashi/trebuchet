import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readStatementTable } from "../../src/statements/table.ts";
import {
  fixedAccountTableArb,
  type TableScenario,
  tableScenarioArb,
} from "../statement-table-arbitraries.ts";

// 007 INV-49（どの形の表でも、正しい対応で元の行を読む）、INV-50 の後半（1 つの口座の取込元は全行がその口座）

const readScenario = (s: TableScenario) => {
  const r = readStatementTable(s.text, s.mapping, {
    year: s.year,
    ...(s.fixedAccountName === undefined ? {} : { fixedAccountName: s.fixedAccountName }),
  });
  if (!r.ok) throw new Error(`${r.error.code}: ${JSON.stringify(r.error.details)}\n${s.text}`);
  return r.value;
};

const sums = (rows: { amount: number }[]) => ({
  inflow: rows.filter((r) => r.amount > 0).reduce((t, r) => t + r.amount, 0),
  outflow: rows.filter((r) => r.amount < 0).reduce((t, r) => t - r.amount, 0),
});

describe("INV-49: readStatementTable は、どの形の表でも元の行を返す", () => {
  it("件数・順・各行の日付・内容・金額・口座が元と同じ。入金・出金の合計も同じ", () => {
    fc.assert(
      fc.property(tableScenarioArb, (s) => {
        const { rows, unreadable } = readScenario(s);
        const got = rows.map(({ accountName, date, content, amount }) => ({
          accountName,
          date,
          content,
          amount,
        }));
        expect(got).toEqual(s.rows);
        expect(sums(rows)).toEqual(sums(s.rows));
        // 読めない行として混ぜた行は、明細として加わらず、数だけ報告される
        expect(unreadable).toHaveLength(s.junkCount);
        expect(rows).toHaveLength(s.rows.length);
      }),
      { numRuns: 300 },
    );
  });

  it("読んだ行は常に 0 でない整数の金額と、実在する日付を持つ", () => {
    fc.assert(
      fc.property(tableScenarioArb, (s) => {
        for (const r of readScenario(s).rows) {
          expect(Number.isInteger(r.amount) && r.amount !== 0).toBe(true);
          expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(r.content).toBe(r.content.trim());
          expect(r.content).not.toBe("");
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("INV-50（後半）: 1 つの口座の取込元で読んだ行の口座は、すべて fixedAccountName", () => {
  it("accountName の役割がない対応では、全行の口座が固定の口座", () => {
    fc.assert(
      fc.property(fixedAccountTableArb, (s) => {
        expect(s.mapping.columns.accountName).toBeUndefined();
        const { rows } = readScenario(s);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.accountName === s.fixedAccountName)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("固定の口座がなく accountName の役割もなければ、読まずに STATEMENT_MAPPING_INVALID", () => {
    fc.assert(
      fc.property(fixedAccountTableArb, (s) => {
        const r = readStatementTable(s.text, s.mapping, { year: s.year });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("STATEMENT_MAPPING_INVALID");
      }),
      { numRuns: 50 },
    );
  });
});
