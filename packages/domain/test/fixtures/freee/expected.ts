/**
 * freee のフィクスチャ（journal-2025.csv、journal-2025-v2.csv、ledger-2025.csv）の期待値。
 * 値は CSV から検算した（README.md の「検算」）。金額はすべて合成の値。
 *
 * 元帳の金額は「科目の通常残高の側を正」とする符号つきの値（freee の元帳の残高と同じ規則）。
 * - opening: 元帳の開始行（前期繰越。年初付の決算振替の前の値）。開始行のない科目は 0
 * - closingTransfer: 2025-01-01 付の前年分の決算振替（research R5）の行の借方・貸方の合計
 * - openingAfterClosing: opening に決算振替を繰り込んだ期首（research R6, R7）
 * - debit / credit: 決算振替の行を除いた借方・貸方の合計（research R7）
 * - closing: 最後の行の残高
 * - rows: 元帳のその科目の行数（開始行を含む）
 */

export type Side = "debit" | "credit";

export type ExpectedLedgerAccount = {
  normalSide: Side;
  opening: number;
  closingTransfer: { debit: number; credit: number };
  openingAfterClosing: number;
  debit: number;
  credit: number;
  closing: number;
  rows: number;
};

export const FIXTURE_FILES = {
  journal: "journal-2025.csv",
  journalV2: "journal-2025-v2.csv",
  ledger: "ledger-2025.csv",
  ledgerUtf8: "ledger-2025.utf8.csv",
} as const;

/** 仕訳帳 journal-2025.csv（v1） */
export const EXPECTED_JOURNAL = {
  /** 仕訳ID の数 */
  journalCount: 15,
  /** データの行数（ヘッダを除く） */
  rowCount: 21,
  /** 勘定科目が入っている側の数（= 001 の仕訳行の数） */
  legCount: 38,
  /** 2025-01-01 付の前年分の決算振替（3行の複合仕訳） */
  priorYearClosingIds: ["900000011"],
  /** 決算整理仕訳 = 1 の仕訳（決算振替と 2025-12-31 の減価償却） */
  adjustmentIds: ["900000011", "900000165"],
  /** 登録した方法ごとの仕訳の数 */
  methods: { 決算: 1, 手動: 7, 自動で経理: 6, 減価償却: 1 },
  /** 売掛金の入金が普通預金（その他口座）と支払手数料（源泉所得税・振込手数料）に分かれる3行の仕訳 */
  receiptWithWithholdingId: "900000033",
  /** 片側が空の行を含む複合仕訳（借方だけの行: 900000033・900000143、貸方だけの行: 900000154） */
  oneSidedRowIds: ["900000033", "900000143", "900000154"],
  /** 費用（通信費）に「課税売上10%」が付いた仕訳（TAX_CATEGORY_SUSPICIOUS） */
  suspiciousTaxId: "900000077",
  /** ファイルに出てくる勘定科目名（NFKC 後、出てくる順） */
  accountNames: [
    "事業主借",
    "元入金",
    "損益",
    "事業主貸",
    "売掛金",
    "売上高",
    "その他口座",
    "支払手数料",
    "消耗品費",
    "ABCカード",
    "事務用品費",
    "交際費",
    "現金",
    "通信費",
    "雑収入",
    "減価償却費",
    "工具器具備品",
  ],
  /** ファイルに出てくる税区分名 */
  taxNames: ["対象外", "課税売上10%", "課対仕入10%", "課対仕入8%（軽）"],
} as const;

/** journal-2025-v2.csv（US5）。v1 との違い */
export const EXPECTED_JOURNAL_V2 = {
  journalCount: 16,
  rowCount: 22,
  /** 追加した仕訳（2025-12-15 通信費 3,300、2025-12-22 売上 220,000） */
  addedIds: ["900000176", "900000187"],
  /** 金額を変えた仕訳（通信費 4,400 → 5,500） */
  changedIds: ["900000077"],
  /** 削除した仕訳（2025-09-01 事業主貸 50,000） */
  deletedIds: ["900000132"],
} as const;

/** 総勘定元帳 ledger-2025.csv。キーは元帳の勘定科目名（ファイルの表記のまま） */
export const EXPECTED_LEDGER = {
  title: "総勘定元帳 (2025年01月~2025年12月）",
  /** データの行数（タイトルとヘッダを除く） */
  rowCount: 46,
  /** 開始行（相手勘定科目 = 前期繰越）の数 */
  openingRowCount: 8,
  /** 開始行の合計。借方側 − 貸方側 = 前年の利益（損益の振替の額 400,000） */
  openingTotals: { debit: 1_400_000, credit: 1_000_000 },
  /** 決算振替を繰り込んだ期首の合計（損益を除く）。貸借が一致する */
  openingAfterClosingTotals: { debit: 1_050_000, credit: 1_050_000 },
  accounts: {
    現金: {
      normalSide: "debit",
      opening: 30_000,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 30_000,
      debit: 10_000,
      credit: 8_800,
      closing: 31_200,
      rows: 3,
    },
    その他口座: {
      normalSide: "debit",
      opening: 800_000,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 800_000,
      debit: 388_710,
      credit: 69_400,
      closing: 1_119_310,
      rows: 6,
    },
    売掛金: {
      normalSide: "debit",
      opening: -20_000,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: -20_000,
      debit: 440_000,
      credit: 420_000,
      closing: 0,
      rows: 5,
    },
    工具器具備品: {
      normalSide: "debit",
      opening: 240_000,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 240_000,
      debit: 0,
      credit: 60_000,
      closing: 180_000,
      rows: 2,
    },
    事業主貸: {
      normalSide: "debit",
      opening: 350_000,
      closingTransfer: { debit: 0, credit: 350_000 },
      openingAfterClosing: 0,
      debit: 50_000,
      credit: 0,
      closing: 50_000,
      rows: 3,
    },
    ＡＢＣカード: {
      normalSide: "credit",
      opening: 15_000,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 15_000,
      debit: 15_000,
      credit: 12_060,
      closing: 12_060,
      rows: 5,
    },
    事業主借: {
      normalSide: "credit",
      opening: 85_000,
      closingTransfer: { debit: 85_000, credit: 0 },
      openingAfterClosing: 0,
      debit: 0,
      credit: 3_300,
      closing: 3_300,
      rows: 3,
    },
    元入金: {
      normalSide: "credit",
      opening: 900_000,
      closingTransfer: { debit: 350_000, credit: 485_000 },
      openingAfterClosing: 1_035_000,
      debit: 0,
      credit: 0,
      closing: 1_035_000,
      rows: 4,
    },
    // 開始行がなく、決算振替の行だけを持つ。通常残高の側は貸方として残高を書いた（取込・照合では使わない）
    損益: {
      normalSide: "credit",
      opening: 0,
      closingTransfer: { debit: 400_000, credit: 0 },
      openingAfterClosing: -400_000,
      debit: 0,
      credit: 0,
      closing: -400_000,
      rows: 1,
    },
    売上高: {
      normalSide: "credit",
      opening: 0,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 0,
      debit: 0,
      credit: 446_600,
      closing: 446_600,
      rows: 3,
    },
    雑収入: {
      normalSide: "credit",
      opening: 0,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 0,
      debit: 0,
      credit: 3_400,
      closing: 3_400,
      rows: 1,
    },
    通信費: {
      normalSide: "debit",
      opening: 0,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 0,
      debit: 4_400,
      credit: 0,
      closing: 4_400,
      rows: 1,
    },
    交際費: {
      normalSide: "debit",
      opening: 0,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 0,
      debit: 14_260,
      credit: 0,
      closing: 14_260,
      rows: 3,
    },
    消耗品費: {
      normalSide: "debit",
      opening: 0,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 0,
      debit: 8_800,
      credit: 0,
      closing: 8_800,
      rows: 2,
    },
    事務用品費: {
      normalSide: "debit",
      opening: 0,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 0,
      debit: 1_100,
      credit: 0,
      closing: 1_100,
      rows: 1,
    },
    減価償却費: {
      normalSide: "debit",
      opening: 0,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 0,
      debit: 60_000,
      credit: 0,
      closing: 60_000,
      rows: 1,
    },
    支払手数料: {
      normalSide: "debit",
      opening: 0,
      closingTransfer: { debit: 0, credit: 0 },
      openingAfterClosing: 0,
      debit: 31_290,
      credit: 0,
      closing: 31_290,
      rows: 2,
    },
  } satisfies Record<string, ExpectedLedgerAccount>,
} as const;

/**
 * freee の科目名（NFKC 後）から帳簿の科目（seed のコード）への対応。research R13 の初期案で決まる。
 * 「損益」は対応なし
 */
export const EXPECTED_ACCOUNT_MAPPING: Record<
  string,
  { code: string; subAccountName?: string | undefined }
> = {
  現金: { code: "1010" },
  その他口座: { code: "1020" },
  売掛金: { code: "1030" },
  工具器具備品: { code: "1060" },
  事業主貸: { code: "3090" },
  ABCカード: { code: "2020", subAccountName: "ABCカード" },
  事業主借: { code: "3010" },
  元入金: { code: "3020" },
  売上高: { code: "4010" },
  雑収入: { code: "4020" },
  通信費: { code: "5120" },
  交際費: { code: "5140" },
  消耗品費: { code: "5170" },
  事務用品費: { code: "5170" },
  減価償却費: { code: "5180" },
  支払手数料: { code: "5250" },
};

export type ExpectedBookAccount = {
  opening: number;
  debit: number;
  credit: number;
  closing: number;
};

/**
 * 帳簿の科目（seed のコード、補助科目は合算）にまとめた元帳の側の値（research R7）。
 * 符号は帳簿の科目の通常残高の側を正とする。opening は決算振替を繰り込んだ期首
 */
export const EXPECTED_BOOK_ACCOUNTS: Record<string, ExpectedBookAccount> = {
  "1010": { opening: 30_000, debit: 10_000, credit: 8_800, closing: 31_200 },
  "1020": { opening: 800_000, debit: 388_710, credit: 69_400, closing: 1_119_310 },
  "1030": { opening: -20_000, debit: 440_000, credit: 420_000, closing: 0 },
  "1060": { opening: 240_000, debit: 0, credit: 60_000, closing: 180_000 },
  "3090": { opening: 0, debit: 50_000, credit: 0, closing: 50_000 },
  "2020": { opening: 15_000, debit: 15_000, credit: 12_060, closing: 12_060 },
  "3010": { opening: 0, debit: 0, credit: 3_300, closing: 3_300 },
  "3020": { opening: 1_035_000, debit: 0, credit: 0, closing: 1_035_000 },
  "4010": { opening: 0, debit: 0, credit: 446_600, closing: 446_600 },
  "4020": { opening: 0, debit: 0, credit: 3_400, closing: 3_400 },
  "5120": { opening: 0, debit: 4_400, credit: 0, closing: 4_400 },
  "5140": { opening: 0, debit: 14_260, credit: 0, closing: 14_260 },
  "5170": { opening: 0, debit: 9_900, credit: 0, closing: 9_900 },
  "5180": { opening: 0, debit: 60_000, credit: 0, closing: 60_000 },
  "5250": { opening: 0, debit: 31_290, credit: 0, closing: 31_290 },
};

/**
 * 元帳から作る期首残高の案（research R5, R6）。損益を捨て、マイナスの売掛金は貸方にする（NEGATIVE_OPENING）。
 * 借方 1,070,000 = 貸方 1,070,000
 */
export const EXPECTED_OPENING_PROPOSAL: {
  code: string;
  subAccountName?: string | undefined;
  side: Side;
  amount: number;
}[] = [
  { code: "1010", side: "debit", amount: 30_000 },
  { code: "1020", side: "debit", amount: 800_000 },
  { code: "1030", side: "credit", amount: 20_000 },
  { code: "1060", side: "debit", amount: 240_000 },
  { code: "2020", subAccountName: "ABCカード", side: "credit", amount: 15_000 },
  { code: "3020", side: "credit", amount: 1_035_000 },
];
