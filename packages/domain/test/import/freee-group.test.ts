import { describe, expect, it } from "vitest";
import { JOURNAL_COLUMNS } from "../../src/import/freee/columns.ts";
import {
  type FreeeFile,
  type FreeeJournal,
  groupFreeeJournals,
  readFreeeFile,
} from "../../src/import/freee/read.ts";
import { EXPECTED_JOURNAL, FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { readFixture } from "../fixtures/freee/load.ts";

const C = JOURNAL_COLUMNS;

function fixtureFile(): FreeeFile {
  const result = readFreeeFile(readFixture(FIXTURE_FILES.journal));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function journalOf(journals: readonly FreeeJournal[], id: string): FreeeJournal {
  const found = journals.find((j) => j.freeeJournalId === id);
  if (found === undefined) throw new Error(`仕訳がない: ${id}`);
  return found;
}

/** フィクスチャの行のうち、指定した仕訳ID の行の値を書き換えたファイル */
function patchRows(
  file: FreeeFile,
  id: string,
  patch: (row: Record<string, string>, index: number) => Record<string, string> | undefined,
): FreeeFile {
  let index = 0;
  const rows: Record<string, string>[] = [];
  for (const row of file.rows) {
    if (row[C.journalId] !== id) {
      rows.push(row);
      continue;
    }
    const patched = patch({ ...row }, index);
    index += 1;
    if (patched !== undefined) rows.push(patched);
  }
  return { ...file, rows };
}

describe("groupFreeeJournals（research R4）", () => {
  it("フィクスチャを仕訳ID でまとめ、取込不可なしで仕訳と行の数がそろう", () => {
    const { journals, rejected } = groupFreeeJournals(fixtureFile());
    expect(rejected).toEqual([]);
    expect(journals).toHaveLength(EXPECTED_JOURNAL.journalCount);
    expect(journals.reduce((n, j) => n + j.lines.length, 0)).toBe(EXPECTED_JOURNAL.legCount);
  });

  it("日付を YYYY-MM-DD にし、仕訳番号・決算整理仕訳・登録した方法を読む", () => {
    const { journals } = groupFreeeJournals(fixtureFile());
    const closing = journalOf(journals, "900000011");
    expect(closing).toMatchObject({
      freeeJournalNo: "5010101",
      date: "2025-01-01",
      adjustment: true,
      entryMethod: "決算",
    });
    expect(journalOf(journals, "900000022").adjustment).toBe(false);
    expect(journals.filter((j) => j.adjustment).map((j) => j.freeeJournalId)).toEqual(
      EXPECTED_JOURNAL.adjustmentIds,
    );
  });

  it("仕訳行番号の順に、各行の借方 → 貸方の順で仕訳行を作り、勘定科目が空の側は行にしない", () => {
    const { journals } = groupFreeeJournals(fixtureFile());
    const receipt = journalOf(journals, EXPECTED_JOURNAL.receiptWithWithholdingId);
    expect(receipt.lines.map((l) => [l.side, l.accountName, l.amount])).toEqual([
      ["debit", "その他口座", 298_710],
      ["credit", "売掛金", 330_000],
      ["debit", "支払手数料", 30_630],
      ["debit", "支払手数料", 660],
    ]);
    const creditOnly = journalOf(journals, "900000154");
    expect(creditOnly.lines.map((l) => [l.side, l.accountName, l.amount])).toEqual([
      ["debit", "現金", 10_000],
      ["credit", "売上高", 6_600],
      ["credit", "雑収入", 3_400],
    ]);
  });

  it("行の並びが入れ替わっていても、仕訳行番号の順に並べる", () => {
    const file = fixtureFile();
    const reversed = groupFreeeJournals({ ...file, rows: [...file.rows].reverse() });
    const original = groupFreeeJournals(file);
    for (const j of original.journals) {
      expect(journalOf(reversed.journals, j.freeeJournalId)).toEqual(j);
    }
  });

  it("名前は NFKC 済み、摘要（取引内容）は元の文字のまま", () => {
    const { journals } = groupFreeeJournals(fixtureFile());
    const usb = journalOf(journals, "900000044");
    expect(usb.lines.map((l) => l.description)).toEqual([
      "コンピュータ用ＵＳＢメモリ　２個",
      "コンピュータ用ＵＳＢメモリ　２個",
    ]);
    expect(usb.lines[1]).toMatchObject({ accountName: "ABCカード", subAccountName: "ABCカード" });
    expect(usb.lines[0]?.subAccountName).toBeUndefined();
    const meal = journalOf(journals, "900000066");
    expect(meal.lines[0]?.partnerName).toBe("(株)テスト飯店");
    const gift = journalOf(journals, "900000143");
    expect(gift.lines[0]).toMatchObject({ taxName: "課対仕入8%(軽)", taxAmount: 160 });
    expect(gift.lines.map((l) => l.description)).toEqual(["手土産", "手土産", "会食"]);
  });

  it("税区分・税金額・取引先・メモタグを側ごとに読む", () => {
    const { journals } = groupFreeeJournals(fixtureFile());
    const sale = journalOf(journals, "900000022");
    expect(sale.lines).toEqual([
      {
        side: "debit",
        accountName: "売掛金",
        amount: 330_000,
        taxName: "対象外",
        taxAmount: 0,
        partnerName: "株式会社サンプル",
        tagNames: [],
        description: "１月分　業務委託料",
      },
      {
        side: "credit",
        accountName: "売上高",
        amount: 330_000,
        taxName: "課税売上10%",
        taxAmount: 30_000,
        partnerName: "株式会社サンプル",
        tagNames: ["案件A"],
        description: "１月分　業務委託料",
      },
    ]);
  });

  it("備考は重複を除いて改行でつなぎ memo に入れる。備考がなければ memo はない", () => {
    const { journals } = groupFreeeJournals(fixtureFile());
    expect(journalOf(journals, EXPECTED_JOURNAL.receiptWithWithholdingId).memo).toBe(
      "源泉所得税\n振込手数料",
    );
    expect(journalOf(journals, "900000121").memo).toBe("個人の財布から支払");
    expect(journalOf(journals, "900000022").memo).toBeUndefined();

    const file = patchRows(fixtureFile(), "900000143", (row, i) => ({
      ...row,
      [C.debit.remarks]: i === 0 ? "同じ備考" : "同じ備考",
      [C.credit.remarks]: i === 0 ? "別の備考" : "",
    }));
    expect(journalOf(groupFreeeJournals(file).journals, "900000143").memo).toBe(
      "同じ備考\n別の備考",
    );
  });

  it("メモタグは区切り文字で分けず、列の値全体を1つのタグにする（T005）", () => {
    const file = patchRows(fixtureFile(), "900000022", (row) => ({
      ...row,
      [C.credit.memo]: " 案件Ａ,第２期 ",
    }));
    const sale = journalOf(groupFreeeJournals(file).journals, "900000022");
    expect(sale.lines[1]?.tagNames).toEqual(["案件A,第2期"]);
  });

  it("行数が仕訳行数と違う → LINE_COUNT_MISMATCH", () => {
    const file = patchRows(fixtureFile(), EXPECTED_JOURNAL.receiptWithWithholdingId, (row, i) =>
      i === 2 ? undefined : row,
    );
    const { journals, rejected } = groupFreeeJournals(file);
    expect(rejected).toEqual([
      {
        freeeJournalId: "900000033",
        freeeJournalNo: "5013101",
        date: "2025-01-31",
        adjustment: false,
        code: "LINE_COUNT_MISMATCH",
      },
    ]);
    expect(journals.map((j) => j.freeeJournalId)).not.toContain("900000033");
  });

  it("仕訳行番号が重複している → LINE_COUNT_MISMATCH", () => {
    const file = patchRows(fixtureFile(), "900000143", (row) => ({ ...row, [C.lineNo]: "1" }));
    expect(groupFreeeJournals(file).rejected.map((r) => r.code)).toEqual(["LINE_COUNT_MISMATCH"]);
  });

  it.each([
    ["空", ""],
    ["小数", "1.5"],
    ["マイナス", "-100"],
    ["0", "0"],
    ["数字以外", "1,000"],
  ])("勘定科目のある側の金額が%s → INVALID_AMOUNT", (_label, amount) => {
    const file = patchRows(fixtureFile(), "900000022", (row) => ({
      ...row,
      [C.debit.amount]: amount,
    }));
    const { rejected } = groupFreeeJournals(file);
    expect(rejected.map((r) => [r.freeeJournalId, r.code])).toEqual([
      ["900000022", "INVALID_AMOUNT"],
    ]);
  });

  it("税金額が整数でない → INVALID_AMOUNT。空なら 0", () => {
    const bad = patchRows(fixtureFile(), "900000022", (row) => ({
      ...row,
      [C.credit.taxAmount]: "abc",
    }));
    expect(groupFreeeJournals(bad).rejected.map((r) => r.code)).toEqual(["INVALID_AMOUNT"]);
    const empty = patchRows(fixtureFile(), "900000022", (row) => ({
      ...row,
      [C.credit.taxAmount]: "",
    }));
    const sale = journalOf(groupFreeeJournals(empty).journals, "900000022");
    expect(sale.lines[1]?.taxAmount).toBe(0);
  });

  it("日付が不正・税区分が空 → MISSING_FIELD", () => {
    const badDate = patchRows(fixtureFile(), "900000022", (row) => ({
      ...row,
      [C.date]: "2025/02/30",
    }));
    expect(groupFreeeJournals(badDate).rejected).toEqual([
      {
        freeeJournalId: "900000022",
        freeeJournalNo: "5011001",
        date: "2025/02/30",
        adjustment: false,
        code: "MISSING_FIELD",
      },
    ]);
    const noTax = patchRows(fixtureFile(), "900000022", (row) => ({
      ...row,
      [C.credit.taxCategory]: "",
    }));
    expect(groupFreeeJournals(noTax).rejected.map((r) => r.code)).toEqual(["MISSING_FIELD"]);
  });

  it("仕訳ID が空の行は、行ごとに MISSING_FIELD", () => {
    const file = patchRows(fixtureFile(), "900000022", (row) => ({ ...row, [C.journalId]: "" }));
    const { rejected } = groupFreeeJournals(file);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: "MISSING_FIELD", date: "2025-01-10" });
    expect(rejected[0]?.freeeJournalId).not.toBe("");
  });
});
