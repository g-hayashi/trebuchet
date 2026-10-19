import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JOURNAL_COLUMNS, LEDGER_COLUMNS } from "../src/import/freee/columns.ts";
import { normalizeName, readFreeeFile } from "../src/import/freee/read.ts";
import { INDIVIDUAL_ACCOUNTS } from "../src/seed/accounts.individual.ts";
import {
  bookOpeningBalances,
  type FreeeModel,
  freeeLedgerTotals,
  freeeModelArb,
  OPENING_ROW_COUNTERPART,
  toFreeeJournalCsv,
  toFreeeLedgerCsv,
} from "./freee-arbitraries.ts";

const modelArb = freeeModelArb({ maxJournals: 15 });
const runs = { numRuns: 60 };

function rowsOf(bytes: Uint8Array, kind: "journal" | "ledger") {
  const result = readFreeeFile(bytes);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  expect(result.value.kind).toBe(kind);
  expect(result.value.encoding).toBe("utf-8");
  return result.value.rows;
}

const normalSideOf = (model: FreeeModel, name: string) =>
  model.accounts.find((a) => a.name === name)?.normalSide;

describe("freee-arbitraries", () => {
  it("仕訳帳: readFreeeFile で読め、仕訳ごとに貸借が一致し、行数が仕訳行数と一致する", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const rows = rowsOf(toFreeeJournalCsv(model), "journal");
        const byId = Map.groupBy(rows, (r) => r[JOURNAL_COLUMNS.journalId] ?? "");
        expect(byId.size).toBe(model.journals.length + 1);
        for (const group of byId.values()) {
          let debit = 0;
          let credit = 0;
          for (const r of group) {
            expect(Number(r[JOURNAL_COLUMNS.lineCount])).toBe(group.length);
            expect(
              r[JOURNAL_COLUMNS.debit.account] !== "" || r[JOURNAL_COLUMNS.credit.account] !== "",
            ).toBe(true);
            debit += Number(r[JOURNAL_COLUMNS.debit.amount] || 0);
            credit += Number(r[JOURNAL_COLUMNS.credit.amount] || 0);
          }
          expect(debit).toBe(credit);
        }
        // 期首日付の決算整理仕訳は、決算振替の1件だけ
        const start = `${model.fiscalYear}/01/01`;
        const closing = rows.filter(
          (r) => r[JOURNAL_COLUMNS.adjustment] === "1" && r[JOURNAL_COLUMNS.date] === start,
        );
        expect(closing.map((r) => r[JOURNAL_COLUMNS.entryMethod])).toEqual([
          "決算",
          "決算",
          "決算",
        ]);
        expect(new Set(closing.map((r) => r[JOURNAL_COLUMNS.journalId])).size).toBe(1);
      }),
      runs,
    );
  });

  it("元帳: 残高が行ごとに積み上がり、期末がモデルから計算した値と一致する", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const rows = rowsOf(toFreeeLedgerCsv(model), "ledger");
        const totals = freeeLedgerTotals(model);
        const byAccount = Map.groupBy(rows, (r) => r[LEDGER_COLUMNS.account] ?? "");
        for (const [name, group] of byAccount) {
          const sign = normalSideOf(model, name) === "debit" ? 1 : -1;
          const first = group[0];
          const hasOpening = first?.[LEDGER_COLUMNS.counterpart] === OPENING_ROW_COUNTERPART;
          expect(hasOpening).toBe((model.opening[name] ?? 0) !== 0);
          let balance = hasOpening ? Number(first?.[LEDGER_COLUMNS.balance]) : 0;
          for (const r of hasOpening ? group.slice(1) : group) {
            balance +=
              sign * (Number(r[LEDGER_COLUMNS.debit] || 0) - Number(r[LEDGER_COLUMNS.credit] || 0));
            expect(Number(r[LEDGER_COLUMNS.balance])).toBe(balance);
          }
          expect(balance).toBe(totals.get(name)?.closing);
        }
        // 開始行を除く元帳の行の数 = 仕訳の脚の数
        const legs = [model.closing, ...model.journals].flatMap((j) =>
          j.rows.flatMap((r) => [r.debit, r.credit].filter((l) => l !== undefined)),
        );
        const openingRows = rows.filter(
          (r) => r[LEDGER_COLUMNS.counterpart] === OPENING_ROW_COUNTERPART,
        );
        expect(rows.length - openingRows.length).toBe(legs.length);
      }),
      runs,
    );
  });

  it("期首: 振替前は前年の利益の分だけ貸借がずれ、振替後は一致し、事業主勘定は 0 になる（research R5）", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const totals = freeeLedgerTotals(model);
        let before = 0;
        let after = 0;
        for (const a of model.accounts) {
          const t = totals.get(a.name);
          if (!t) throw new Error(a.name);
          const sign = a.normalSide === "debit" ? 1 : -1;
          before += sign * t.opening;
          if (a.book !== null) after += sign * t.openingAfterClosing;
          expect(t.closing).toBe(t.openingAfterClosing + sign * (t.debit - t.credit));
        }
        expect(before).toBe(model.priorYearProfit);
        expect(after).toBe(0);
        expect(totals.get("事業主借")?.openingAfterClosing).toBe(0);
        expect(totals.get("事業主貸")?.openingAfterClosing).toBe(0);
        expect(totals.get("元入金")?.opening).toBeGreaterThan(0);
        expect(totals.get("元入金")?.openingAfterClosing).toBeGreaterThan(0);
      }),
      runs,
    );
  });

  it("帳簿の科目に合算した期首は貸借が一致し、対応先は seed の科目で通常残高の側が同じ", () => {
    const seed = new Map(INDIVIDUAL_ACCOUNTS.map((a) => [a.code, a]));
    fc.assert(
      fc.property(modelArb, (model) => {
        for (const a of model.accounts) {
          if (a.book === null) {
            expect(a.name).toBe("損益");
            continue;
          }
          expect(seed.get(a.book.code)?.normalSide).toBe(a.normalSide);
          if (normalizeName(a.name).endsWith("カード")) {
            expect(a.book).toEqual({ code: "2020", subAccountName: normalizeName(a.name) });
          }
        }
        const rows = bookOpeningBalances(model);
        const net = rows.reduce(
          (s, r) => s + (seed.get(r.code)?.normalSide === "debit" ? r.balance : -r.balance),
          0,
        );
        expect(net).toBe(0);
      }),
      runs,
    );
  });
});
