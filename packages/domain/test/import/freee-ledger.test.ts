import { describe, expect, it } from "vitest";
import {
  type FreeeFile,
  type FreeeLedgerAccount,
  normalizeName,
  parseFreeeLedger,
  readFreeeFile,
} from "../../src/import/freee/read.ts";
import { EXPECTED_LEDGER, FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { FREEE_LEDGER_HEADER } from "../fixtures/freee/headers.ts";
import { readFixture } from "../fixtures/freee/load.ts";

function fixtureLedger(): FreeeLedgerAccount[] {
  const file = readFreeeFile(readFixture(FIXTURE_FILES.ledger));
  if (!file.ok) throw new Error(JSON.stringify(file.error));
  expect(file.value.encoding).toBe("shift_jis");
  const parsed = parseFreeeLedger(file.value);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

/** 元帳の列名 → 値 から FreeeFile を作る（指定しない列は空） */
function ledgerFile(rows: Record<string, string>[]): FreeeFile {
  return {
    kind: "ledger",
    encoding: "utf-8",
    header: [...FREEE_LEDGER_HEADER],
    rows: rows.map((r) => Object.fromEntries(FREEE_LEDGER_HEADER.map((h) => [h, r[h] ?? ""]))),
  };
}

const opening = (account: string, balance: string, counterpart = "前期繰越") => ({
  勘定科目: account,
  取引日: "2025-01-01",
  決算整理仕訳: "0",
  相手勘定科目: counterpart,
  残高: balance,
});

describe("parseFreeeLedger（T035, research R6）", () => {
  it("フィクスチャの元帳（CP932）を科目ごとにまとめる。タイトル行は読み飛ばす", () => {
    const ledger = fixtureLedger();
    const expectedNames = Object.keys(EXPECTED_LEDGER.accounts).map(normalizeName);
    expect(ledger.map((a) => a.accountName)).toEqual(expectedNames);
    // 開始行は rows に含めない
    const rowCount = ledger.reduce((s, a) => s + a.rows.length, 0);
    const openingRows = ledger.filter((a) => a.openingDate !== null).length;
    expect(openingRows).toBe(EXPECTED_LEDGER.openingRowCount);
    expect(rowCount + openingRows).toBe(EXPECTED_LEDGER.rowCount);
    expect(ledger.some((a) => a.accountName.startsWith("総勘定元帳"))).toBe(false);
  });

  it("科目ごとの開始行の残高（符号つき）・行数・借方・貸方・期末が expected.ts と一致する", () => {
    const ledger = new Map(fixtureLedger().map((a) => [a.accountName, a]));
    for (const [name, exp] of Object.entries(EXPECTED_LEDGER.accounts)) {
      const a = ledger.get(normalizeName(name));
      expect(a, name).toBeDefined();
      if (a === undefined) continue;
      expect(a.opening, name).toBe(exp.opening);
      expect(a.rows.length + (a.openingDate === null ? 0 : 1), name).toBe(exp.rows);
      const transfer = a.rows.filter((r) => r.adjustment && r.date === "2025-01-01");
      const others = a.rows.filter((r) => !(r.adjustment && r.date === "2025-01-01"));
      expect(
        {
          debit: transfer.reduce((s, r) => s + r.debit, 0),
          credit: transfer.reduce((s, r) => s + r.credit, 0),
        },
        name,
      ).toEqual(exp.closingTransfer);
      expect(
        others.reduce((s, r) => s + r.debit, 0),
        name,
      ).toBe(exp.debit);
      expect(
        others.reduce((s, r) => s + r.credit, 0),
        name,
      ).toBe(exp.credit);
      expect(a.rows.at(-1)?.balance ?? a.opening, name).toBe(exp.closing);
      expect(a.normalSide, name).toBe(exp.normalSide);
    }
  });

  it("マイナスの開始残高を符号つきで読む（売掛金 −20,000）", () => {
    const ar = fixtureLedger().find((a) => a.accountName === "売掛金");
    expect(ar?.opening).toBe(-20_000);
    expect(ar?.openingDate).toBe("2025-01-01");
  });

  it("取引の行は 日付・決算整理仕訳・相手科目（NFKC）・仕訳番号・借方・貸方・残高 をファイルの順に並べる", () => {
    const card = fixtureLedger().find((a) => a.accountName === "ABCカード");
    expect(card?.opening).toBe(15_000);
    expect(card?.rows[0]).toEqual({
      date: "2025-02-05",
      adjustment: false,
      counterpart: "消耗品費",
      journalNo: "5020501",
      debit: 0,
      credit: 5_500,
      balance: 20_500,
    });
    const bank = fixtureLedger().find((a) => a.accountName === "その他口座");
    expect(bank?.rows.find((r) => r.journalNo === "5052701")?.counterpart).toBe("ABCカード");
    const capital = fixtureLedger().find((a) => a.accountName === "元入金");
    expect(capital?.rows.map((r) => [r.adjustment, r.debit, r.credit, r.balance])).toEqual([
      [true, 0, 85_000, 985_000],
      [true, 0, 400_000, 1_385_000],
      [true, 350_000, 0, 1_035_000],
    ]);
  });

  it("開始行のない科目は opening = 0、openingDate = null（損益は決算振替の行だけ）", () => {
    const pl = fixtureLedger().find((a) => a.accountName === "損益");
    expect(pl).toMatchObject({ opening: 0, openingDate: null, normalSide: "credit" });
    expect(pl?.rows).toHaveLength(1);
  });

  it("初年の「開始残高」の行も開始行として読む", () => {
    const r = parseFreeeLedger(
      ledgerFile([
        opening("現金", "1000", "開始残高"),
        opening("元入金", "1000", "開始残高"),
        {
          勘定科目: "現金",
          取引日: "2025-02-01",
          決算整理仕訳: "0",
          相手勘定科目: "売上高",
          仕訳番号: "1",
          借方金額: "500",
          残高: "1500",
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((a) => [a.accountName, a.opening, a.openingDate, a.rows.length])).toEqual([
      ["現金", 1000, "2025-01-01", 1],
      ["元入金", 1000, "2025-01-01", 0],
    ]);
    expect(r.value[0]?.normalSide).toBe("debit");
    // 動きのない科目の通常の側は推定できない
    expect(r.value[1]?.normalSide).toBeUndefined();
  });

  it("科目名は NFKC で正規化し、全角と半角の同じ名前は1つの科目にまとめる", () => {
    const r = parseFreeeLedger(
      ledgerFile([opening("ＸＹＺカード", "100"), opening("XYZカード ", "0")]),
    );
    expect(r.ok && r.value.map((a) => a.accountName)).toEqual(["XYZカード"]);
  });

  it("金額・残高が数字でない → INVALID_AMOUNT、日付が読めない → MISSING_FIELD（データの行番号と列名つき）", () => {
    const bad = parseFreeeLedger(ledgerFile([opening("現金", "1000"), opening("元入金", "1,0x")]));
    expect(bad).toEqual({ ok: false, error: { code: "INVALID_AMOUNT", row: 2, column: "残高" } });
    const minus = parseFreeeLedger(
      ledgerFile([
        {
          勘定科目: "現金",
          取引日: "2025-02-01",
          決算整理仕訳: "0",
          相手勘定科目: "売上高",
          借方金額: "-5",
          残高: "-5",
        },
      ]),
    );
    expect(minus).toEqual({
      ok: false,
      error: { code: "INVALID_AMOUNT", row: 1, column: "借方金額" },
    });
    const date = parseFreeeLedger(ledgerFile([{ ...opening("現金", "1"), 取引日: "2025-13-01" }]));
    expect(date).toEqual({ ok: false, error: { code: "MISSING_FIELD", row: 1, column: "取引日" } });
    const name = parseFreeeLedger(ledgerFile([opening("　", "1")]));
    expect(name).toEqual({
      ok: false,
      error: { code: "MISSING_FIELD", row: 1, column: "勘定科目" },
    });
  });
});
