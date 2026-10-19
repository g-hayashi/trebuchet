import { describe, expect, it } from "vitest";
import {
  JOURNAL_COLUMN_NAMES,
  JOURNAL_COLUMNS,
  LEDGER_COLUMN_NAMES,
  LEDGER_COLUMNS,
} from "../../src/import/freee/columns.ts";

describe("freee の列名", () => {
  it("仕訳帳の借方と貸方は同じ項目を持ち、列名は「借方」「貸方」で始まる", () => {
    expect(Object.keys(JOURNAL_COLUMNS.debit)).toEqual(Object.keys(JOURNAL_COLUMNS.credit));
    for (const name of Object.values(JOURNAL_COLUMNS.debit)) expect(name).toMatch(/^借方/);
    for (const name of Object.values(JOURNAL_COLUMNS.credit)) expect(name).toMatch(/^貸方/);
  });

  it("列名の一覧は重複がなく、すべての定数を含む", () => {
    expect(JOURNAL_COLUMN_NAMES).toHaveLength(8 + 8 * 2);
    expect(new Set(JOURNAL_COLUMN_NAMES).size).toBe(JOURNAL_COLUMN_NAMES.length);
    expect(JOURNAL_COLUMN_NAMES).toContain(JOURNAL_COLUMNS.journalId);
    expect(JOURNAL_COLUMN_NAMES).toContain(JOURNAL_COLUMNS.credit.memo);

    expect(LEDGER_COLUMN_NAMES).toHaveLength(8);
    expect(new Set(LEDGER_COLUMN_NAMES).size).toBe(LEDGER_COLUMN_NAMES.length);
    expect(LEDGER_COLUMN_NAMES).toEqual(Object.values(LEDGER_COLUMNS));
  });
});
