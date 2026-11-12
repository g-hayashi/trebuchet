import { describe, expect, it } from "vitest";
import { buildBalanceSheet } from "../../src/reports/balance-sheet.ts";
import { encodeCsv, toCsv } from "../../src/reports/csv.ts";
import { buildGeneralLedger } from "../../src/reports/general-ledger.ts";
import { buildJournalBook } from "../../src/reports/journal-book.ts";
import { buildProfitAndLoss, compareProfitAndLoss } from "../../src/reports/profit-and-loss.ts";
import { buildTrialBalance } from "../../src/reports/trial-balance.ts";
import { accountSetArb, balancedOpeningArb, fc } from "../arbitraries.ts";
import { ACCOUNTS, accountOf, LINES, OPENING, PERIOD } from "../fixtures/sample-year.ts";
import { PERIOD_2026, postedLinesArb } from "./generators.ts";

const BOM = "\uFEFF";

/** RFC 4180 の CSV を読む（テスト用）。BOM を除き、CRLF を行の区切りとする */
function parseCsv(text: string): string[][] {
  expect(text.startsWith(BOM)).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  expect(row).toEqual([]);
  expect(field).toBe("");
  return rows;
}

const num = (s: string | undefined) => Number(s);

const inputArb = accountSetArb.chain((accounts) =>
  fc.tuple(
    fc.constant(accounts),
    balancedOpeningArb(accounts.filter((a) => a.reportSection.startsWith("BS_"))),
    postedLinesArb(accounts, PERIOD_2026, { maxLength: 20 }),
  ),
);

describe("CSV の出力（FR-032）", () => {
  describe("encodeCsv", () => {
    it("UTF-8 の BOM で始まり、各行は CRLF で終わる", () => {
      expect(encodeCsv([["a", "b"], ["c"]])).toBe(`${BOM}a,b\r\nc\r\n`);
    });

    it("カンマ・引用符・改行を含む値は引用符で囲み、引用符は二重にする", () => {
      expect(encodeCsv([["a,b", 'say "hi"', "line\nbreak", "cr\rx", "plain", 123, -5, null]])).toBe(
        `${BOM}"a,b","say ""hi""","line\nbreak","cr\rx",plain,123,-5,\r\n`,
      );
    });

    it("文字列のセルが = + - @ タブ CR で始まるとき、先頭に ' を付ける（数式として実行させない）", () => {
      expect(encodeCsv([["=SUM(A1)", "+1", "-1", "@x", "\tx", "\rx", "ok", "a=b", ""]])).toBe(
        `${BOM}'=SUM(A1),'+1,'-1,'@x,'\tx,"'\rx",ok,a=b,\r\n`,
      );
    });

    it("数値のセルには ' を付けない（負の金額は -100 のまま）", () => {
      expect(encodeCsv([[-100, 0, 5, "-100"]])).toBe(`${BOM}-100,0,5,'-100\r\n`);
    });

    it("任意の文字列の表を、読み戻すと元に戻る（数式の先頭だけ ' が付く）", () => {
      const neutralized = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
      fc.assert(
        fc.property(
          fc.array(fc.array(fc.string({ unit: "grapheme" }), { minLength: 2, maxLength: 5 }), {
            maxLength: 10,
          }),
          (table) => {
            expect(parseCsv(encodeCsv(table))).toEqual(table.map((r) => r.map(neutralized)));
          },
        ),
      );
    });
  });

  describe("toCsv: CSV の数値が帳票オブジェクトの数値と一致する", () => {
    it("試算表", () => {
      fc.assert(
        fc.property(inputArb, ([accounts, opening, lines]) => {
          const tb = buildTrialBalance({
            accounts,
            opening,
            lines,
            periodStart: "2026-01-01",
            from: "2026-04-01",
            to: "2026-09-30",
          });
          const [header, ...rest] = parseCsv(toCsv(tb));
          expect(header).toEqual(["コード", "勘定科目", "期首残高", "借方", "貸方", "期末残高"]);
          const body = rest.slice(0, -1);
          expect(body.map((r) => [r[0], r[1], ...r.slice(2).map(num)])).toEqual(
            tb.rows.map((r) => [r.code, r.name, r.opening, r.debit, r.credit, r.closing]),
          );
          expect(rest.at(-1)).toEqual([
            "",
            "合計",
            "",
            String(tb.totals.debit),
            String(tb.totals.credit),
            "",
          ]);
        }),
      );
    });

    it("損益計算書（前年比較あり）", () => {
      fc.assert(
        fc.property(inputArb, inputArb, ([accounts, , lines], [, , prevLines]) => {
          const shift = prevLines.map((l) => ({ ...l, date: l.date.replace("2026", "2025") }));
          const cur = buildProfitAndLoss({ accounts, lines, from: "2026-01-01", to: "2026-12-31" });
          const prev = buildProfitAndLoss({
            accounts,
            lines: shift,
            from: "2025-01-01",
            to: "2025-12-31",
          });
          const pl = compareProfitAndLoss(cur, prev, accounts);
          const [header, ...rest] = parseCsv(toCsv(pl));
          expect(header).toEqual(["区分", "欄", "勘定科目", "金額", "前年", "増減"]);
          const expected = pl.sections.flatMap((s) => [
            ...s.rows.map((r) => [r.name, r.amount, r.previous, r.change]),
            ["計", s.total.amount, s.total.previous, s.total.change],
          ]);
          expected.push([
            "差引金額",
            pl.netIncome.amount,
            pl.netIncome.previous,
            pl.netIncome.change,
          ]);
          expect(rest.map((r) => [r[2], num(r[3]), num(r[4]), num(r[5])])).toEqual(expected);
        }),
      );
    });

    it("貸借対照表", () => {
      fc.assert(
        fc.property(inputArb, ([accounts, opening, lines]) => {
          const bs = buildBalanceSheet({
            accounts,
            opening,
            lines,
            periodStart: "2026-01-01",
            asOf: "2026-06-30",
          });
          const [header, ...rest] = parseCsv(toCsv(bs));
          expect(header).toEqual(["区分", "勘定科目", "金額"]);
          const expected = bs.sections.flatMap((s) => [
            ...s.rows.map((r) => [r.name, r.amount]),
            ...(s.section === "BS_EQUITY" ? [["当期利益", bs.netIncome.amount]] : []),
            [
              "計",
              s.section === "BS_EQUITY" ? s.total.amount + bs.netIncome.amount : s.total.amount,
            ],
          ]);
          expected.push(["資産合計", bs.totalAssets.amount]);
          expected.push(["負債・純資産合計", bs.totalLiabilitiesAndEquity.amount]);
          expect(rest.map((r) => [r[1], num(r[2])])).toEqual(expected);
        }),
      );
    });

    it("総勘定元帳", () => {
      const gl = buildGeneralLedger({
        accounts: ACCOUNTS,
        opening: OPENING,
        lines: LINES,
        periodStart: PERIOD.startDate,
        from: PERIOD.startDate,
        to: PERIOD.endDate,
        accountId: accountOf("売掛金").id,
        subAccount: null,
      });
      const [header, first, ...rest] = parseCsv(toCsv(gl));
      expect(header).toEqual(["日付", "仕訳番号", "相手科目", "摘要", "借方", "貸方", "残高"]);
      expect(first).toEqual(["", "", "前期繰越", "", "", "", String(gl.broughtForward)]);
      expect(rest.slice(0, -1)).toEqual(
        gl.entries.map((e) => [
          e.date,
          String(e.journalNo),
          e.counterpart,
          e.description ?? "",
          e.debit === 0 ? "" : String(e.debit),
          e.credit === 0 ? "" : String(e.credit),
          String(e.balance),
        ]),
      );
      expect(rest.at(-1)).toEqual([
        "",
        "",
        "合計",
        "",
        String(gl.totals.debit),
        String(gl.totals.credit),
        String(gl.closing),
      ]);
    });

    it("仕訳帳", () => {
      const book = buildJournalBook({ lines: LINES, from: "2026-01-01", to: "2026-01-31" });
      const [header, ...rest] = parseCsv(toCsv(book));
      expect(header).toEqual([
        "日付",
        "仕訳番号",
        "貸借",
        "勘定科目",
        "補助科目",
        "取引先",
        "金額",
        "税区分",
        "消費税額",
        "摘要",
        "メモ",
      ]);
      expect(rest.slice(0, 3)).toEqual([
        ["2026-01-05", "1", "借方", "普通預金", "", "", "329560", "OUT_OF_SCOPE", "0", "", ""],
        ["2026-01-05", "1", "借方", "支払手数料", "", "", "440", "OUT_OF_SCOPE", "0", "", ""],
        ["2026-01-05", "1", "貸方", "売掛金", "", "", "330000", "OUT_OF_SCOPE", "0", "", ""],
      ]);
      expect(rest.slice(-2)).toEqual([
        ["", "", "借方合計", "", "", "", String(book.totals.debit), "", "", "", ""],
        ["", "", "貸方合計", "", "", "", String(book.totals.credit), "", "", "", ""],
      ]);
      expect(rest).toHaveLength(7 + 2);
    });
  });
});
