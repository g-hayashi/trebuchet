import { INDIVIDUAL_ACCOUNTS } from "../../src/seed/accounts.individual.ts";
import type { Account, OpeningBalance, PostedLine, Side } from "../../src/types.ts";

/**
 * 帳票のテスト用の合成データ（T084）: 2026 年度（1/1〜12/31）の個人事業。
 * 期首残高と 31 件の仕訳（うち 1 件は取消済み）。期待値はすべて手計算。
 */

export const PERIOD = {
  id: "period-2026",
  fiscalYear: 2026,
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  status: "open",
  closedAt: null,
} as const;

/** 初期セットの科目。ID は「account-コード」 */
export const ACCOUNTS: Account[] = INDIVIDUAL_ACCOUNTS.map((a) => ({
  ...a,
  id: `account-${a.code}`,
  isSystem: true,
  isActive: true,
}));

export function accountOf(name: string): Account {
  const a = ACCOUNTS.find((x) => x.name === name);
  if (a === undefined) throw new Error(`科目がない: ${name}`);
  return a;
}

const opening = (name: string, side: Side, amount: number): OpeningBalance => ({
  id: `opening-${name}`,
  fiscalPeriodId: PERIOD.id,
  accountId: accountOf(name).id,
  subAccountId: null,
  side,
  amount,
});

/** 期首残高（借方 1,380,000 = 貸方 1,380,000） */
export const OPENING: OpeningBalance[] = [
  opening("現金", "debit", 50_000),
  opening("普通預金", "debit", 1_000_000),
  opening("売掛金", "debit", 330_000),
  opening("未払金", "credit", 30_000),
  opening("元入金", "credit", 1_350_000),
];

export type LineSpec = [side: Side, account: string, amount: number];

/** 仕訳を PostedLine にする */
export function journal(
  journalNo: number,
  date: string,
  specs: LineSpec[],
  options: { voided?: boolean; memo?: string } = {},
): PostedLine[] {
  return specs.map(([side, name, amount], i) => ({
    journalId: `journal-${journalNo}`,
    journalNo,
    date,
    memo: options.memo ?? null,
    status: options.voided === true ? "voided" : "active",
    lineNo: i + 1,
    side,
    accountId: accountOf(name).id,
    accountName: name,
    subAccountId: null,
    subAccountName: null,
    amount,
    taxCategory: "OUT_OF_SCOPE",
    taxAmount: 0,
    partnerId: null,
    partnerName: null,
    description: null,
  }));
}

const simple = (no: number, date: string, debit: string, credit: string, amount: number) =>
  journal(no, date, [
    ["debit", debit, amount],
    ["credit", credit, amount],
  ]);

/** 売掛金の入金（振込手数料 440 円を差し引かれる） */
const collect = (no: number, date: string) =>
  journal(no, date, [
    ["debit", "普通預金", 329_560],
    ["debit", "支払手数料", 440],
    ["credit", "売掛金", 330_000],
  ]);

const rent = (no: number, date: string) => simple(no, date, "地代家賃", "普通預金", 80_000);
const sale = (no: number, date: string, amount = 330_000) =>
  simple(no, date, "売掛金", "売上高", amount);

export const LINES: PostedLine[] = [
  ...collect(1, "2026-01-05"),
  ...rent(2, "2026-01-25"),
  ...sale(3, "2026-01-31"),
  ...simple(4, "2026-02-10", "未払金", "普通預金", 30_000),
  ...rent(5, "2026-02-25"),
  ...collect(6, "2026-02-27"),
  ...sale(7, "2026-02-28"),
  ...simple(8, "2026-03-05", "消耗品費", "現金", 5_500),
  ...rent(9, "2026-03-25"),
  ...collect(10, "2026-03-31"),
  ...sale(11, "2026-03-31"),
  ...simple(12, "2026-04-10", "通信費", "普通預金", 8_800),
  ...rent(13, "2026-04-25"),
  ...collect(14, "2026-04-30"),
  ...sale(15, "2026-04-30"),
  ...simple(16, "2026-05-15", "事業主貸", "普通預金", 100_000),
  ...rent(17, "2026-05-25"),
  ...collect(18, "2026-05-29"),
  ...sale(19, "2026-05-31"),
  ...simple(20, "2026-06-20", "消耗品費", "未払金", 12_000),
  ...rent(21, "2026-06-25"),
  ...collect(22, "2026-06-30"),
  ...sale(23, "2026-06-30"),
  ...simple(24, "2026-07-10", "未払金", "普通預金", 12_000),
  ...simple(25, "2026-07-15", "現金", "事業主借", 20_000),
  ...rent(26, "2026-07-25"),
  ...collect(27, "2026-07-31"),
  ...sale(28, "2026-08-31", 165_000),
  // 二重に登録して取り消した仕訳（集計に含めない）
  ...journal(
    29,
    "2026-09-01",
    [
      ["debit", "通信費", 8_800],
      ["credit", "普通預金", 8_800],
    ],
    { voided: true },
  ),
  ...simple(30, "2026-09-10", "普通預金", "雑収入", 1_200),
  ...simple(31, "2026-12-31", "消耗品費", "現金", 3_300),
];

/** 試算表の期待値（期首・借方・貸方・期末。期首・期末は科目の通常の側を正とする） */
export const EXPECTED_TRIAL_BALANCE: Record<
  string,
  { opening: number; debit: number; credit: number; closing: number }
> = {
  現金: { opening: 50_000, debit: 20_000, credit: 8_800, closing: 61_200 },
  普通預金: { opening: 1_000_000, debit: 2_308_120, credit: 710_800, closing: 2_597_320 },
  売掛金: { opening: 330_000, debit: 2_145_000, credit: 2_310_000, closing: 165_000 },
  事業主貸: { opening: 0, debit: 100_000, credit: 0, closing: 100_000 },
  未払金: { opening: 30_000, debit: 42_000, credit: 12_000, closing: 0 },
  事業主借: { opening: 0, debit: 0, credit: 20_000, closing: 20_000 },
  元入金: { opening: 1_350_000, debit: 0, credit: 0, closing: 1_350_000 },
  売上高: { opening: 0, debit: 0, credit: 2_145_000, closing: 2_145_000 },
  雑収入: { opening: 0, debit: 0, credit: 1_200, closing: 1_200 },
  通信費: { opening: 0, debit: 8_800, credit: 0, closing: 8_800 },
  消耗品費: { opening: 0, debit: 20_800, credit: 0, closing: 20_800 },
  地代家賃: { opening: 0, debit: 560_000, credit: 0, closing: 560_000 },
  支払手数料: { opening: 0, debit: 3_080, credit: 0, closing: 3_080 },
};

export const EXPECTED_TRIAL_BALANCE_TOTALS = {
  debit: 5_207_800,
  credit: 5_207_800,
  closingDebit: 3_516_200,
  closingCredit: 3_516_200,
};

/** 損益計算書の期待値（1/1〜12/31） */
export const EXPECTED_PROFIT_AND_LOSS = {
  sales: { 売上高: 2_145_000, 雑収入: 1_200 },
  salesTotal: 2_146_200,
  expenses: { 通信費: 8_800, 消耗品費: 20_800, 地代家賃: 560_000, 支払手数料: 3_080 },
  expensesTotal: 592_680,
  netIncome: 1_553_520,
};

/** 貸借対照表の期待値（12/31） */
export const EXPECTED_BALANCE_SHEET = {
  assets: { 現金: 61_200, 普通預金: 2_597_320, 売掛金: 165_000, 事業主貸: 100_000 },
  totalAssets: 2_923_520,
  liabilities: { 未払金: 0 },
  liabilitiesTotal: 0,
  equity: { 事業主借: 20_000, 元入金: 1_350_000 },
  equityTotal: 1_370_000,
  netIncome: 1_553_520,
  totalLiabilitiesAndEquity: 2_923_520,
};

/** 普通預金の元帳の期待値（1/1〜12/31）: [日付, 仕訳番号, 相手科目, 借方, 貸方, 残高] */
export const EXPECTED_BANK_LEDGER = {
  broughtForward: 1_000_000,
  entries: [
    ["2026-01-05", 1, "売掛金", 329_560, 0, 1_329_560],
    ["2026-01-25", 2, "地代家賃", 0, 80_000, 1_249_560],
    ["2026-02-10", 4, "未払金", 0, 30_000, 1_219_560],
    ["2026-02-25", 5, "地代家賃", 0, 80_000, 1_139_560],
    ["2026-02-27", 6, "売掛金", 329_560, 0, 1_469_120],
    ["2026-03-25", 9, "地代家賃", 0, 80_000, 1_389_120],
    ["2026-03-31", 10, "売掛金", 329_560, 0, 1_718_680],
    ["2026-04-10", 12, "通信費", 0, 8_800, 1_709_880],
    ["2026-04-25", 13, "地代家賃", 0, 80_000, 1_629_880],
    ["2026-04-30", 14, "売掛金", 329_560, 0, 1_959_440],
    ["2026-05-15", 16, "事業主貸", 0, 100_000, 1_859_440],
    ["2026-05-25", 17, "地代家賃", 0, 80_000, 1_779_440],
    ["2026-05-29", 18, "売掛金", 329_560, 0, 2_109_000],
    ["2026-06-25", 21, "地代家賃", 0, 80_000, 2_029_000],
    ["2026-06-30", 22, "売掛金", 329_560, 0, 2_358_560],
    ["2026-07-10", 24, "未払金", 0, 12_000, 2_346_560],
    ["2026-07-25", 26, "地代家賃", 0, 80_000, 2_266_560],
    ["2026-07-31", 27, "売掛金", 329_560, 0, 2_596_120],
    ["2026-09-10", 30, "雑収入", 1_200, 0, 2_597_320],
  ] as const,
  debit: 2_308_120,
  credit: 710_800,
  closing: 2_597_320,
};
