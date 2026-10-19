import { describe, expect, it } from "vitest";
import { decodeText, parseCsv } from "../../src/import/csv.ts";
import {
  JOURNAL_COLUMN_NAMES,
  JOURNAL_COLUMNS,
  LEDGER_COLUMN_NAMES,
} from "../../src/import/freee/columns.ts";
import { type FreeeFile, normalizeName, readFreeeFile } from "../../src/import/freee/read.ts";
import { encodeCsv } from "../../src/reports/csv.ts";
import { EXPECTED_JOURNAL, EXPECTED_LEDGER, FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { FREEE_JOURNAL_HEADER, FREEE_LEDGER_HEADER } from "../fixtures/freee/headers.ts";
import { readFixture } from "../fixtures/freee/load.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);

function readOk(bytes: Uint8Array): FreeeFile {
  const result = readFreeeFile(bytes);
  if (!result.ok) throw new Error(`読めない: ${JSON.stringify(result.error)}`);
  return result.value;
}

/** CSV の列を並べ替えたバイト列（encodeCsv は BOM 付き・CRLF） */
function permuteColumns(bytes: Uint8Array, headerIndex: number): Uint8Array {
  const rows = parseCsv(decodeText(bytes).text);
  const width = rows[headerIndex]?.length ?? 0;
  // 逆順にしてから、先頭と真ん中を入れ替える
  const order = Array.from({ length: width }, (_, i) => width - 1 - i);
  const mid = Math.floor(width / 2);
  [order[0], order[mid]] = [order[mid] as number, order[0] as number];
  const permuted = rows.map((row, i) => (i < headerIndex ? row : order.map((j) => row[j] ?? "")));
  return utf8(encodeCsv(permuted));
}

function withoutColumns(bytes: Uint8Array, headerIndex: number, names: string[]): Uint8Array {
  const rows = parseCsv(decodeText(bytes).text);
  const header = rows[headerIndex] ?? [];
  const keep = header.map((h, i) => (names.includes(h) ? -1 : i)).filter((i) => i >= 0);
  return utf8(
    encodeCsv(rows.map((row, i) => (i < headerIndex ? row : keep.map((j) => row[j] ?? "")))),
  );
}

describe("readFreeeFile: 仕訳帳", () => {
  const bytes = readFixture(FIXTURE_FILES.journal);

  it("UTF-8 の仕訳帳を kind: journal として読み、行を列名 → 値にする", () => {
    const file = readOk(bytes);
    expect(file.kind).toBe("journal");
    expect(file.encoding).toBe("utf-8");
    expect(file.header).toEqual(FREEE_JOURNAL_HEADER);
    expect(file.rows).toHaveLength(EXPECTED_JOURNAL.rowCount);

    const first = file.rows[0];
    expect(first?.[JOURNAL_COLUMNS.journalId]).toBe("900000011");
    expect(first?.[JOURNAL_COLUMNS.date]).toBe("2025/01/01");
    expect(first?.[JOURNAL_COLUMNS.adjustment]).toBe("1");
    expect(first?.[JOURNAL_COLUMNS.entryMethod]).toBe("決算");
    expect(first?.[JOURNAL_COLUMNS.debit.account]).toBe("事業主借");
    // 使わない列も、空の値として持つ
    expect(first?.借方決算書表示名).toBe("");
    for (const row of file.rows) expect(Object.keys(row)).toHaveLength(FREEE_JOURNAL_HEADER.length);
  });

  it("値は元の文字のまま（全角の英数字・空白を正規化しない）", () => {
    const file = readOk(bytes);
    const usb = file.rows.find((r) => r[JOURNAL_COLUMNS.description]?.includes("ＵＳＢ"));
    expect(usb?.[JOURNAL_COLUMNS.description]).toBe("コンピュータ用ＵＳＢメモリ　２個");
    expect(usb?.[JOURNAL_COLUMNS.credit.account]).toBe("ＡＢＣカード");
  });

  it("片側が空の行は、その側の列が空になる", () => {
    const file = readOk(bytes);
    const rows = file.rows.filter(
      (r) => r[JOURNAL_COLUMNS.journalId] === EXPECTED_JOURNAL.receiptWithWithholdingId,
    );
    expect(rows.map((r) => r[JOURNAL_COLUMNS.lineNo])).toEqual(["1", "2", "3"]);
    expect(rows[1]?.[JOURNAL_COLUMNS.debit.account]).toBe("支払手数料");
    expect(rows[1]?.[JOURNAL_COLUMNS.credit.account]).toBe("");
    expect(rows[1]?.[JOURNAL_COLUMNS.credit.amount]).toBe("");
  });

  it("ヘッダの列の順を入れ替えても、種類と行は同じ（BOM 付き・CRLF でも読める）", () => {
    const original = readOk(bytes);
    const permuted = readOk(permuteColumns(bytes, 0));
    expect(permuted.kind).toBe("journal");
    expect(permuted.encoding).toBe("utf-8");
    expect(permuted.header).not.toEqual(original.header);
    expect([...permuted.header].sort()).toEqual([...original.header].sort());
    expect(permuted.rows).toEqual(original.rows);
  });

  it("必須の列がないと IMPORT_UNKNOWN_FORMAT で、欠けている列名を返す", () => {
    const missing = [JOURNAL_COLUMNS.journalId, JOURNAL_COLUMNS.credit.memo];
    const result = readFreeeFile(withoutColumns(bytes, 0, missing));
    expect(result).toEqual({
      ok: false,
      error: { code: "IMPORT_UNKNOWN_FORMAT", missingColumns: missing },
    });
  });
});

describe("readFreeeFile: 総勘定元帳", () => {
  const bytes = readFixture(FIXTURE_FILES.ledger);

  it("CP932・タイトル行ありの元帳を kind: ledger、encoding: shift_jis として読む", () => {
    const file = readOk(bytes);
    expect(file.kind).toBe("ledger");
    expect(file.encoding).toBe("shift_jis");
    expect(file.header).toEqual(FREEE_LEDGER_HEADER);
    // タイトル行とヘッダは行に含めない
    expect(file.rows).toHaveLength(EXPECTED_LEDGER.rowCount);
    expect(file.rows[0]).toMatchObject({
      勘定科目: "現金",
      相手勘定科目: "前期繰越",
      借方金額: "",
      貸方金額: "",
      残高: "30000",
    });
  });

  it("CP932 の拡張文字と、2バイト目が 0x85 の文字を正しく読む", () => {
    const file = readOk(bytes);
    const descriptions = file.rows.map((r) => r.取引内容);
    expect(descriptions).toContain("コンピュータ用ＵＳＢメモリ　２個");
    expect(file.rows.map((r) => r.相手取引先)).toContain("㈱テスト飯店");
    expect(file.rows.find((r) => r.勘定科目 === "売掛金")?.残高).toBe("-20000");
  });

  it("同じ内容の UTF-8 の元帳と同じ行になる", () => {
    const fromUtf8 = readOk(readFixture(FIXTURE_FILES.ledgerUtf8));
    expect(fromUtf8.kind).toBe("ledger");
    expect(fromUtf8.encoding).toBe("utf-8");
    expect(fromUtf8.rows).toEqual(readOk(bytes).rows);
  });

  it("ヘッダの列の順を入れ替えても、種類と行は同じ", () => {
    const original = readOk(bytes);
    const permuted = readOk(permuteColumns(bytes, 1));
    expect(permuted.kind).toBe("ledger");
    expect(permuted.rows).toEqual(original.rows);
  });

  it("必須の列がないと IMPORT_UNKNOWN_FORMAT で、欠けている列名を返す", () => {
    const result = readFreeeFile(withoutColumns(bytes, 1, ["残高"]));
    expect(result).toEqual({
      ok: false,
      error: { code: "IMPORT_UNKNOWN_FORMAT", missingColumns: ["残高"] },
    });
  });
});

describe("readFreeeFile: 判別できないファイル", () => {
  it("空のファイルは IMPORT_UNKNOWN_FORMAT", () => {
    for (const bytes of [new Uint8Array(), utf8("\uFEFF"), utf8("\n\n")]) {
      const result = readFreeeFile(bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("IMPORT_UNKNOWN_FORMAT");
    }
  });

  it("関係のない CSV は IMPORT_UNKNOWN_FORMAT で、仕訳帳の必須の列をすべて欠けているとして返す", () => {
    const result = readFreeeFile(utf8('"日付","金額"\n"2025/01/01","100"\n'));
    expect(result).toEqual({
      ok: false,
      error: { code: "IMPORT_UNKNOWN_FORMAT", missingColumns: [...JOURNAL_COLUMN_NAMES] },
    });
  });

  it("ヘッダは先頭5行の中から探す（6行目より後のヘッダは見ない）", () => {
    const header = encodeCsv([[...LEDGER_COLUMN_NAMES]]).replace(/^\uFEFF/, "");
    expect(readOk(utf8(`"a"\n"b"\n"c"\n"d"\n${header}`)).kind).toBe("ledger");
    expect(readFreeeFile(utf8(`"a"\n"b"\n"c"\n"d"\n"e"\n${header}`)).ok).toBe(false);
  });

  it("短い行は足りない列を空にし、空の行は捨てる", () => {
    const header = LEDGER_COLUMN_NAMES.map((h) => `"${h}"`).join(",");
    const file = readOk(utf8(`${header}\n"現金","2025-01-01"\n\n`));
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]?.勘定科目).toBe("現金");
    expect(file.rows[0]?.残高).toBe("");
  });
});

describe("normalizeName", () => {
  it("NFKC で正規化し、前後の空白を除く", () => {
    expect(normalizeName("ＪＡＬカード ")).toBe("JALカード");
    expect(normalizeName("　事務用品費　")).toBe("事務用品費");
    expect(normalizeName("ＡＢＣ　カード")).toBe("ABC カード");
    expect(normalizeName("ｶｰﾄﾞ")).toBe("カード");
    expect(normalizeName("㈱テスト飯店")).toBe("(株)テスト飯店");
    expect(normalizeName("課対仕入8%（軽）")).toBe("課対仕入8%(軽)");
    expect(normalizeName("案件Ａ")).toBe(normalizeName("案件A"));
  });

  it("2回かけても変わらない", () => {
    for (const s of ["ＪＡＬカード ", "　Ａ　Ｂ　", "課税売上10%", ""]) {
      expect(normalizeName(normalizeName(s))).toBe(normalizeName(s));
    }
  });
});
