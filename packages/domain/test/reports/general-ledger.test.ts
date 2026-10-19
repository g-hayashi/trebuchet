import { describe, expect, it } from "vitest";
import { buildGeneralLedger } from "../../src/reports/general-ledger.ts";
import type { OpeningBalance, PostedLine } from "../../src/types.ts";
import {
  ACCOUNTS,
  accountOf,
  EXPECTED_BANK_LEDGER,
  journal,
  LINES,
  OPENING,
  PERIOD,
} from "../fixtures/sample-year.ts";

const ledger = (
  name: string,
  range: { from: string; to: string } = { from: PERIOD.startDate, to: PERIOD.endDate },
  lines: PostedLine[] = LINES,
  opening: OpeningBalance[] = OPENING,
) =>
  buildGeneralLedger({
    accounts: ACCOUNTS,
    opening,
    lines,
    periodStart: PERIOD.startDate,
    accountId: accountOf(name).id,
    subAccount: null,
    ...range,
  });

const rows = (gl: ReturnType<typeof buildGeneralLedger>) =>
  gl.entries.map((e) => [e.date, e.journalNo, e.counterpart, e.debit, e.credit, e.balance]);

describe("総勘定元帳（FR-027）", () => {
  it("US4-1: 普通預金は前期繰越から始まり、日付順に取引と残高の推移を表示する（フィクスチャと一致）", () => {
    const gl = ledger("普通預金");
    expect(gl.account).toMatchObject({ name: "普通預金", normalSide: "debit" });
    expect(gl.broughtForward).toBe(EXPECTED_BANK_LEDGER.broughtForward);
    expect(rows(gl)).toEqual(EXPECTED_BANK_LEDGER.entries);
    expect(gl.totals).toEqual({
      debit: EXPECTED_BANK_LEDGER.debit,
      credit: EXPECTED_BANK_LEDGER.credit,
    });
    expect(gl.closing).toBe(EXPECTED_BANK_LEDGER.closing);
  });

  it("前期繰越 = 期首残高 + 会計期間の開始日から期間の開始日の前日までの累計", () => {
    const gl = ledger("普通預金", { from: "2026-03-01", to: "2026-03-31" });
    // 1,000,000 + 329,560 − 80,000 − 30,000 − 80,000 + 329,560（1〜2月）
    expect(gl.broughtForward).toBe(1_469_120);
    expect(rows(gl)).toEqual([
      ["2026-03-25", 9, "地代家賃", 0, 80_000, 1_389_120],
      ["2026-03-31", 10, "売掛金", 329_560, 0, 1_718_680],
    ]);
    expect(gl.closing).toBe(1_718_680);
  });

  it("貸方が通常の側の科目は、貸方を正として残高を計算する", () => {
    const gl = ledger("未払金");
    expect(gl.broughtForward).toBe(30_000);
    expect(rows(gl)).toEqual([
      ["2026-02-10", 4, "普通預金", 30_000, 0, 0],
      ["2026-06-20", 20, "消耗品費", 0, 12_000, 12_000],
      ["2026-07-10", 24, "普通預金", 12_000, 0, 0],
    ]);
  });

  it("同じ日付の仕訳は仕訳番号の順に並べる（入力の順によらない）", () => {
    const lines = [
      ...journal(5, "2026-01-10", [
        ["debit", "現金", 500],
        ["credit", "売上高", 500],
      ]),
      ...journal(3, "2026-01-20", [
        ["debit", "現金", 300],
        ["credit", "売上高", 300],
      ]),
      ...journal(4, "2026-01-10", [
        ["debit", "現金", 400],
        ["credit", "売上高", 400],
      ]),
    ];
    const gl = ledger("現金", undefined, lines, []);
    expect(gl.entries.map((e) => [e.date, e.journalNo, e.balance])).toEqual([
      ["2026-01-10", 4, 400],
      ["2026-01-10", 5, 900],
      ["2026-01-20", 3, 1_200],
    ]);
  });

  it("相手科目: 相手側が1科目ならその科目、複数の科目（複合仕訳）なら「諸口」", () => {
    const gl = ledger("売掛金", { from: "2026-01-01", to: "2026-01-31" });
    expect(rows(gl)).toEqual([
      ["2026-01-05", 1, "諸口", 0, 330_000, 0],
      ["2026-01-31", 3, "売上高", 330_000, 0, 330_000],
    ]);
  });

  it("摘要は行の摘要、なければ仕訳のメモ", () => {
    const lines = [
      ...journal(
        1,
        "2026-01-10",
        [
          ["debit", "現金", 500],
          ["credit", "売上高", 500],
        ],
        { memo: "仕訳のメモ" },
      ).map((l, i) => (i === 0 ? { ...l, description: "行の摘要" } : l)),
      ...journal(
        2,
        "2026-01-11",
        [
          ["debit", "現金", 300],
          ["credit", "売上高", 300],
        ],
        { memo: "仕訳のメモ" },
      ),
    ];
    const gl = ledger("現金", undefined, lines, []);
    expect(gl.entries.map((e) => e.description)).toEqual(["行の摘要", "仕訳のメモ"]);
  });

  it("取消済みの仕訳は含まない", () => {
    const gl = ledger("通信費");
    expect(gl.entries.map((e) => e.journalNo)).toEqual([12]);
    expect(gl.closing).toBe(8_800);
  });

  it("補助科目を指定すると、その補助科目の期首残高と行だけで計算する", () => {
    const bank = accountOf("普通預金");
    const sub = (id: string) => (l: PostedLine) =>
      l.accountId === bank.id ? { ...l, subAccountId: id, subAccountName: id } : l;
    const lines = [
      ...journal(1, "2026-01-10", [
        ["debit", "普通預金", 10_000],
        ["credit", "売上高", 10_000],
      ]).map(sub("bank-a")),
      ...journal(2, "2026-01-11", [
        ["debit", "普通預金", 20_000],
        ["credit", "売上高", 20_000],
      ]).map(sub("bank-b")),
      ...journal(3, "2026-02-01", [
        ["debit", "地代家賃", 1_000],
        ["credit", "普通預金", 1_000],
      ]).map(sub("bank-a")),
    ];
    const opening: OpeningBalance[] = [
      { ...OPENING[1], subAccountId: "bank-a", amount: 600_000 } as OpeningBalance,
      { ...OPENING[1], id: "opening-b", subAccountId: "bank-b", amount: 400_000 } as OpeningBalance,
      { ...OPENING[4], amount: 1_000_000 } as OpeningBalance,
    ];
    const gl = buildGeneralLedger({
      accounts: ACCOUNTS,
      opening,
      lines,
      periodStart: PERIOD.startDate,
      accountId: bank.id,
      subAccount: { id: "bank-a", name: "A銀行" },
      from: "2026-01-11",
      to: "2026-12-31",
    });
    expect(gl.subAccount).toEqual({ id: "bank-a", name: "A銀行" });
    expect(gl.broughtForward).toBe(610_000);
    expect(rows(gl)).toEqual([["2026-02-01", 3, "地代家賃", 0, 1_000, 609_000]]);

    const all = buildGeneralLedger({
      accounts: ACCOUNTS,
      opening,
      lines,
      periodStart: PERIOD.startDate,
      accountId: bank.id,
      subAccount: null,
      from: "2026-01-11",
      to: "2026-12-31",
    });
    expect(all.broughtForward).toBe(1_010_000);
    expect(all.closing).toBe(1_029_000);
  });

  it("収益・費用の科目は会計期間ごとに 0 から始まる（前年度の仕訳を含めない）", () => {
    const lines = [
      ...journal(1, "2025-12-31", [
        ["debit", "売掛金", 99_000],
        ["credit", "売上高", 99_000],
      ]),
      ...LINES,
    ];
    const gl = ledger("売上高", { from: "2026-03-01", to: "2026-03-31" }, lines);
    // 1〜2月の売上のみ
    expect(gl.broughtForward).toBe(660_000);
    expect(gl.closing).toBe(990_000);
  });
});
