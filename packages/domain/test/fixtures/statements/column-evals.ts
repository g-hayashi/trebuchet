import type { StatementAmountSign, StatementColumnIndexes } from "@trebuchet/schema";
import type { ColumnEvalCase } from "../../../src/usecases/statement-columns.ts";

/**
 * 列の案の評価の例（007/R15、Constitution IV）。`pnpm eval:columns` と `evaluateColumnSuggestions` の入力。
 * 見出しと先頭の行は **合成** の値（README の匿名化の方針。実データから作らない）。
 * 構成: T001 の各形（MF ME の貼り付け、銀行の 2 列、カード、和暦、見出しなし、独自の見出し）、
 * 独自の見出し、英語の見出し、見出しなし。`expected.columns` は正しい列の対応（列の番号は 0 起点）。
 * `amountSign` は金額 1 列で、見本の値の符号から向きが決まる例だけに付ける
 */

function make(
  name: string,
  header: string[] | null,
  sampleRows: string[][],
  columns: StatementColumnIndexes,
  amountSign?: StatementAmountSign,
): ColumnEvalCase {
  const columnCount = (header ?? sampleRows[0] ?? []).length;
  return {
    name,
    header,
    sampleRows,
    columnCount,
    expected: amountSign === undefined ? { columns } : { columns, amountSign },
  };
}

export const COLUMN_EVAL_CASES: readonly ColumnEvalCase[] = [
  // T001 の各形
  make(
    "mfme-paste",
    [
      "計算対象",
      "日付",
      "内容",
      "金額（円）",
      "保有金融機関",
      "大項目",
      "中項目",
      "メモ",
      "振替",
      "ID",
    ],
    [
      [
        "1",
        "10/01(木)",
        "ショップ001",
        "-1,200",
        "サンプル銀行",
        "食費",
        "食料品",
        "",
        "0",
        "mf-0001",
      ],
      [
        "1",
        "10/02(金)",
        "売上入金 テスト商事",
        "330,000",
        "サンプル銀行",
        "収入",
        "事業売上",
        "請求書払い",
        "0",
        "mf-0002",
      ],
      ["1", "10/03(土)", "ATM 引出", "-20,000", "サンプル銀行", "現金", "引出", "", "1", "mf-0003"],
    ],
    {
      date: 1,
      content: 2,
      amount: 3,
      accountName: 4,
      categoryMajor: 5,
      categoryMinor: 6,
      memo: 7,
      transferFlag: 8,
      externalId: 9,
    },
    "inflow_positive",
  ),
  make(
    "bank-two-columns",
    ["取引日", "摘要", "出金額", "入金額", "残高"],
    [
      ["2026/10/01", "カード引落 テストカードA", "45,000", "", "1,255,000"],
      ["2026/10/02", "振込 テスト商事", "", "330,000", "1,585,000"],
      ["2026/10/03", "ATM 引出", "20,000", "", "1,565,000"],
    ],
    { date: 0, content: 1, outflow: 2, inflow: 3 },
  ),
  make(
    "card-outflow-positive",
    ["ご利用日", "ご利用店名", "ご利用金額", "支払区分", "備考"],
    [
      ["2026/10/02", "ショップ001, 本店", "1,200", "1回払い", ""],
      ["2026/10/03", "ショップ002", "¥3,300", "1回払い", ""],
      ["2026/10/05", "ショップ003 返品", "-980", "1回払い", "返金"],
    ],
    { date: 0, content: 1, amount: 2, memo: 4 },
    "outflow_positive",
  ),
  make(
    "bank-wareki",
    ["お取引日", "お取引内容", "取引金額"],
    [
      ["令和8年10月1日", "振込 テスト商事", "330,000"],
      ["令和8年10月3日", "ＡＴＭ引出", "△20,000"],
      ["R8.10.05", "カード引落 テストカードA", "▲45,000"],
    ],
    { date: 0, content: 1, amount: 2 },
    "inflow_positive",
  ),
  make(
    "no-header-balance",
    null,
    [
      ["2026/10/01", "振込 テスト商事", "330000", "1330000"],
      ["2026/10/03", "ATM 引出", "-20000", "1310000"],
      ["2026/10/05", "カード引落 テストカードA", "-45000", "1265000"],
    ],
    { date: 0, content: 1, amount: 2 },
    "inflow_positive",
  ),
  make(
    "custom-header",
    ["発生日", "取引の内容", "増減額", "整理番号"],
    [
      ["2026/10/02", "テスト商事 入金", "220,000", "N0001"],
      ["2026/10/04", "オフィス用品 ショップ006", "-4,950", "N0002"],
      ["2026/10/06", "通信費 サンプル通信", "-8,800", "N0003"],
    ],
    { date: 0, content: 1, amount: 2, externalId: 3 },
    "inflow_positive",
  ),
  // 独自の見出し
  make(
    "custom-use-amount",
    ["年月日", "ご利用先", "お支払い金額"],
    [
      ["2026/10/02", "ショップ011", "2,400"],
      ["2026/10/09", "ショップ012", "15,800"],
      ["2026/10/12", "ショップ013 返品", "-3,000"],
    ],
    { date: 0, content: 1, amount: 2 },
    "outflow_positive",
  ),
  make(
    "custom-deposit-withdrawal",
    ["日時", "相手先・用途", "お預入れ", "お引出し", "差引残高"],
    [
      ["2026/10/01", "テスト商事", "330,000", "", "1,330,000"],
      ["2026/10/03", "サンプル電力", "", "9,800", "1,320,200"],
      ["2026/10/05", "サンプル通信", "", "8,800", "1,311,400"],
    ],
    { date: 0, content: 1, inflow: 2, outflow: 3 },
  ),
  make(
    "custom-out-in",
    ["計上日", "テキスト", "支出", "収入"],
    [
      ["2026/10/01", "文具 ショップ021", "1,100", ""],
      ["2026/10/04", "売上 テスト商事", "", "88,000"],
      ["2026/10/07", "交通費 サンプル鉄道", "640", ""],
    ],
    { date: 0, content: 1, outflow: 2, inflow: 3 },
  ),
  make(
    "custom-with-id-and-account",
    ["No.", "取引日", "取引先", "入出金", "口座", "勘定科目", "備考"],
    [
      ["1", "2026/10/01", "テスト商事", "330000", "サンプル銀行", "売上高", "請求書払い"],
      ["2", "2026/10/03", "ショップ031", "-1200", "サンプル銀行", "消耗品費", ""],
      ["3", "2026/10/04", "サンプル通信", "-8800", "テストカードA", "通信費", "月額"],
    ],
    { externalId: 0, date: 1, content: 2, amount: 3, accountName: 4, categoryMajor: 5, memo: 6 },
    "inflow_positive",
  ),
  make(
    "custom-transfer-flag",
    ["支払日", "支払先", "金額", "振替"],
    [
      ["2026/10/01", "テストカードA 引落", "45000", "1"],
      ["2026/10/03", "ショップ041", "1200", "0"],
      ["2026/10/08", "ショップ042", "3300", "0"],
    ],
    { date: 0, content: 1, amount: 2, transferFlag: 3 },
    "outflow_positive",
  ),
  make(
    "custom-card-fees",
    ["利用日", "利用店名・商品名", "支払金額", "手数料", "大分類", "小分類"],
    [
      ["2026/10/02", "ショップ051", "4,400", "0", "仕入", "材料"],
      ["2026/10/08", "ショップ052", "9,900", "0", "会議", "飲食"],
      ["2026/10/15", "ショップ053", "2,200", "0", "仕入", "梱包"],
    ],
    { date: 0, content: 1, amount: 2, categoryMajor: 4, categoryMinor: 5 },
    "outflow_positive",
  ),
  make(
    "japanese-standard-seven",
    ["日付", "内容", "出金", "入金", "口座名", "カテゴリ", "メモ"],
    [
      ["2026/10/01", "ショップ061", "1,500", "", "サンプル銀行", "消耗品", ""],
      ["2026/10/02", "売上入金 テスト商事", "", "110,000", "サンプル銀行", "売上", "10月分"],
      ["2026/10/06", "ショップ062", "3,000", "", "テスト現金", "会議", ""],
    ],
    { date: 0, content: 1, outflow: 2, inflow: 3, accountName: 4, categoryMajor: 5, memo: 6 },
  ),
  // 英語の見出し
  make(
    "english-amount",
    ["Date", "Description", "Amount", "Balance"],
    [
      ["2026-10-01", "TRANSFER TEST SHOJI", "330000", "1330000"],
      ["2026-10-03", "ATM WITHDRAWAL", "-20000", "1310000"],
      ["2026-10-05", "CARD SETTLEMENT", "-45000", "1265000"],
    ],
    { date: 0, content: 1, amount: 2 },
    "inflow_positive",
  ),
  make(
    "english-debit-credit",
    ["Date", "Payee", "Debit", "Credit", "Balance"],
    [
      ["2026-10-01", "Shop 071", "1200", "", "1328800"],
      ["2026-10-02", "Test Shoji", "", "330000", "1658800"],
      ["2026-10-04", "Sample Telecom", "8800", "", "1650000"],
    ],
    { date: 0, content: 1, outflow: 2, inflow: 3 },
  ),
  make(
    "english-withdrawal-deposit",
    ["Transaction Date", "Details", "Withdrawal", "Deposit", "Balance"],
    [
      ["10/01/2026", "Shop 081", "2,500.00", "", "997,500"],
      ["10/02/2026", "Invoice Test Shoji", "", "440,000", "1,437,500"],
      ["10/05/2026", "Sample Rail", "1,280", "", "1,436,220"],
    ],
    { date: 0, content: 1, outflow: 2, inflow: 3 },
  ),
  make(
    "english-with-category",
    ["Posted", "Merchant", "Amount", "Category", "Note"],
    [
      ["2026-10-02", "Shop 091", "-1,980", "Supplies", ""],
      ["2026-10-05", "Test Shoji", "99,000", "Sales", "October"],
      ["2026-10-09", "Sample Telecom", "-8,800", "Utilities", "monthly"],
    ],
    { date: 0, content: 1, amount: 2, categoryMajor: 3, memo: 4 },
    "inflow_positive",
  ),
  make(
    "english-with-id-first",
    ["ID", "Date", "Narrative", "Amount", "Account"],
    [
      ["T-0001", "2026-10-01", "Shop 101", "-3,300", "Sample Bank"],
      ["T-0002", "2026-10-02", "Test Shoji", "165,000", "Sample Bank"],
      ["T-0003", "2026-10-04", "Sample Rail", "-640", "Test Cash"],
    ],
    { externalId: 0, date: 1, content: 2, amount: 3, accountName: 4 },
    "inflow_positive",
  ),
  make(
    "english-type-column",
    ["Date", "Name", "Value", "Type"],
    [
      ["2026-10-01", "Shop 111", "1200", "debit"],
      ["2026-10-02", "Test Shoji", "55000", "credit"],
      ["2026-10-06", "Shop 112", "980", "debit"],
    ],
    { date: 0, content: 1, amount: 2 },
  ),
  make(
    "english-booking-reference",
    ["Tx ID", "Booking date", "Counterparty", "Reference", "Amount (JPY)"],
    [
      ["B001", "2026-10-01", "Test Shoji", "INV-2026-10", "220000"],
      ["B002", "2026-10-03", "Shop 121", "ORDER 55", "-7700"],
      ["B003", "2026-10-06", "Sample Telecom", "MONTHLY", "-8800"],
    ],
    { externalId: 0, date: 1, content: 2, memo: 3, amount: 4 },
    "inflow_positive",
  ),
  make(
    "english-out-in-short",
    ["Booking", "Text", "Out", "In"],
    [
      ["2026-10-01", "Shop 131", "2,000", ""],
      ["2026-10-02", "Test Shoji", "", "66,000"],
      ["2026-10-07", "Shop 132", "500", ""],
    ],
    { date: 0, content: 1, outflow: 2, inflow: 3 },
  ),
  // 見出しなし
  make(
    "no-header-two-columns-out-in",
    null,
    [
      ["2026/10/01", "振込 テスト商事", "", "330000", "1330000"],
      ["2026/10/03", "ATM 引出", "20000", "", "1310000"],
      ["2026/10/05", "カード引落 テストカードA", "45000", "", "1265000"],
    ],
    { date: 0, content: 1, outflow: 2, inflow: 3 },
  ),
  make(
    "no-header-five-columns",
    null,
    [
      ["2026/10/01", "ショップ141", "-1500", "サンプル銀行", "文具"],
      ["2026/10/02", "テスト商事 入金", "275000", "サンプル銀行", "10月分"],
      ["2026/10/09", "ショップ142", "-980", "テスト現金", ""],
    ],
    { date: 0, content: 1, amount: 2, accountName: 3, memo: 4 },
    "inflow_positive",
  ),
  make(
    "no-header-account-second",
    null,
    [
      ["2026/10/01", "サンプル銀行", "ショップ151", "1,500", "", "備考なし"],
      ["2026/10/02", "サンプル銀行", "テスト商事 入金", "", "165,000", "10月分"],
      ["2026/10/06", "テスト現金", "ショップ152", "800", "", ""],
    ],
    { date: 0, accountName: 1, content: 2, outflow: 3, inflow: 4, memo: 5 },
  ),
  make(
    "no-header-slash-dates",
    null,
    [
      ["10/01", "売上 テスト商事", "110,000"],
      ["10/04", "交通費 サンプル鉄道", "-640"],
      ["10/09", "消耗品 ショップ161", "-2,640"],
    ],
    { date: 0, content: 1, amount: 2 },
    "inflow_positive",
  ),
];
