import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildBlueReturn } from "../../src/blue-return/build.ts";
import { blueReturnToCsv } from "../../src/blue-return/csv.ts";
import { formForYear } from "../../src/blue-return/form.ts";
import { parseCsv } from "../../src/import/csv.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { DeductionAnswers } from "../../src/types.ts";
import { yearLedgerArb } from "../blue-return-arbitraries.ts";

const answers: DeductionAnswers = {
  fiscalYear: 2025,
  doubleEntry: true,
  statementsAttached: true,
  filedOnTime: true,
  eTax: true,
  electronicBooks: false,
  updatedAt: "2026-01-10T00:00:00.000Z",
};

/** BOM を除いて読み戻す */
const read = (csv: string) => {
  expect(csv.startsWith("﻿")).toBe(true);
  return parseCsv(csv.slice(1));
};

const unusedNos = new Set(
  formForYear(2025)
    .pl.filter((l) => l.kind === "unused")
    .map((l) => l.no),
);

describe("blueReturnToCsv（R14）", () => {
  it("見出しは ページ,欄番号,欄名,金額。CRLF で終える", () => {
    const csv = blueReturnToCsv(
      buildBlueReturn({
        period: { ...yearPeriod(), status: "open" },
        accounts: [],
        lines: [],
        deductionAnswers: answers,
        taxParameters: TAX_PARAMETERS,
      }),
      { blankUnused: false },
    );
    expect(read(csv)[0]).toEqual(["ページ", "欄番号", "欄名", "金額"]);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("読み戻した金額が blueReturn の1ページの欄と一致する（回答なしの null は空）", () => {
    fc.assert(
      fc.property(
        yearLedgerArb,
        fc.option(fc.constant(answers), { nil: null }),
        (ledger, deductionAnswers) => {
          const r = buildBlueReturn({
            period: ledger.period,
            accounts: ledger.accounts,
            lines: ledger.lines,
            deductionAnswers,
            taxParameters: TAX_PARAMETERS,
          });
          const rows = read(blueReturnToCsv(r, { blankUnused: false })).slice(1);
          const page1 = rows.filter((row) => row[0] === "1");
          expect(page1).toHaveLength(r.page1.lines.length);
          for (const [i, l] of r.page1.lines.entries()) {
            const row = page1[i] as string[];
            expect(row[1]).toBe(String(l.no));
            expect(row[2]).toBe(l.label);
            expect(row[3]).toBe(l.amount === null ? "" : String(l.amount));
          }
        },
      ),
    );
  });

  it("blankUnused で unused の欄の金額だけが空になる", () => {
    const ledger = fc.sample(yearLedgerArb, { numRuns: 1, seed: 1 })[0];
    if (ledger === undefined) throw new Error("no ledger");
    const r = buildBlueReturn({
      period: ledger.period,
      accounts: ledger.accounts,
      lines: ledger.lines,
      deductionAnswers: answers,
      taxParameters: TAX_PARAMETERS,
    });
    const shown = read(blueReturnToCsv(r, { blankUnused: false })).slice(1);
    const blank = read(blueReturnToCsv(r, { blankUnused: true })).slice(1);
    expect(blank).toHaveLength(shown.length);
    for (const [i, row] of blank.entries()) {
      const before = shown[i] as string[];
      const no = Number(row[1]);
      if (row[0] === "1" && unusedNos.has(no)) {
        expect(before[3], `欄${no}`).toBe("0");
        expect(row[3], `欄${no}`).toBe("");
      } else {
        expect(row, `欄${no}`).toEqual(before);
      }
    }
    // unused 以外の 0 は空にならない（任意欄の 0 など）
    const optional = blank.find((row) => row[0] === "1" && row[1] === "30");
    expect(optional?.[3]).toBe("0");
  });

  it("blankUnused は各欄の kind で判定する（kind が unused の欄だけ空になる）", () => {
    const base = buildBlueReturn({
      period: yearPeriod(),
      accounts: [],
      lines: [],
      deductionAnswers: answers,
      taxParameters: TAX_PARAMETERS,
    });
    const r = {
      ...base,
      page1: {
        lines: base.page1.lines.map((l) =>
          l.no === 8
            ? { ...l, kind: "unused" as const }
            : l.no === 2
              ? { ...l, kind: "account" as const }
              : l,
        ),
      },
    };
    const rows = read(blueReturnToCsv(r, { blankUnused: true }));
    expect(rows.find((row) => row[1] === "8")?.[3]).toBe("");
    expect(rows.find((row) => row[1] === "2")?.[3]).toBe("0");
  });

  it("欄名のカンマ・引用符は引用される", () => {
    const base = buildBlueReturn({
      period: yearPeriod(),
      accounts: [],
      lines: [],
      deductionAnswers: answers,
      taxParameters: TAX_PARAMETERS,
    });
    const r = {
      ...base,
      page1: {
        lines: base.page1.lines.map((l) => (l.no === 25 ? { ...l, label: 'A,"B"' } : l)),
      },
    };
    const rows = read(blueReturnToCsv(r, { blankUnused: false }));
    expect(rows.find((row) => row[1] === "25")?.[2]).toBe('A,"B"');
  });
});

function yearPeriod() {
  return {
    id: "p",
    fiscalYear: 2025,
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    status: "open" as const,
    closedAt: null,
  };
}
