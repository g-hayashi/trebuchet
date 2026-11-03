import type { ReceiptEvalExpected } from "../../../src/receipts/evals.ts";

/**
 * 証憑の読み取りの評価（`pnpm eval:receipts`、010/R17）の正解。キーは `eval/` の下の画像のファイル名。
 * 画像は合成のレシート・領収書・電子の PDF 20 枚（JPEG 13・PNG 3・HEIC 2・PDF 2）。作り方と一覧は `README.md` の「評価用の画像」。
 * 画像を足したら、同じファイル名でここに正解を足す。
 * 正解を決めない項目は null（その項目は集計しない）。例: 8% と 10% が混在するレシートの科目・税区分。
 * 実データの値・取引先名は書かない（合成のみ）。
 */
export const RECEIPT_EVAL_EXPECTED: Readonly<Record<string, ReceiptEvalExpected>> = {
  // 感熱レシート風（10%）
  "receipt-01.jpg": {
    transactionDate: "2026-10-20",
    amount: 1100,
    partnerName: "合成商店",
    accountCode: "5170",
    taxCategory: "PURCHASE_10",
  },
  "receipt-02.jpg": {
    transactionDate: "2026-10-21",
    amount: 3278,
    partnerName: "テスト文具",
    accountCode: "5170",
    taxCategory: "PURCHASE_10",
  },
  // 軽減税率 8% のみ（持ち帰り）
  "receipt-03.jpg": {
    transactionDate: "2026-10-22",
    amount: 864,
    partnerName: "サンプル食堂",
    accountCode: "5260",
    taxCategory: "PURCHASE_8R",
  },
  // 8% と 10% の混在（科目・税区分は決めない）
  "receipt-04.jpg": {
    transactionDate: "2026-10-23",
    amount: 2374,
    partnerName: "見本スーパー",
    accountCode: null,
    taxCategory: null,
  },
  "receipt-05.jpg": {
    transactionDate: "2026-10-24",
    amount: 2350,
    partnerName: "架空タクシー",
    accountCode: "5110",
    taxCategory: "PURCHASE_10",
  },
  "receipt-06.png": {
    transactionDate: "2026-10-25",
    amount: 1540,
    partnerName: "合成コーヒー",
    accountCode: "5260",
    taxCategory: "PURCHASE_10",
  },
  "receipt-07.jpg": {
    transactionDate: "2026-10-26",
    amount: 12000,
    partnerName: "テスト事務機",
    accountCode: "5170",
    taxCategory: "PURCHASE_10",
  },
  "receipt-08.jpg": {
    transactionDate: "2026-10-27",
    amount: 33000,
    partnerName: "合成工房",
    accountCode: "5160",
    taxCategory: "PURCHASE_10",
  },
  "receipt-09.png": {
    transactionDate: "2026-10-28",
    amount: 5500,
    partnerName: "架空運輸",
    accountCode: "5090",
    taxCategory: "PURCHASE_10",
  },
  "receipt-10.jpg": {
    transactionDate: "2026-10-29",
    amount: 4400,
    partnerName: "架空テレコム",
    accountCode: "5120",
    taxCategory: "PURCHASE_10",
  },
  "receipt-11.jpg": {
    transactionDate: "2026-10-30",
    amount: 1200,
    partnerName: "見本パーキング",
    accountCode: "5110",
    taxCategory: "PURCHASE_10",
  },
  // 軽減税率 8%（新聞の購読料）
  "receipt-12.jpg": {
    transactionDate: "2026-11-01",
    amount: 3200,
    partnerName: "架空新聞",
    accountCode: "5270",
    taxCategory: "PURCHASE_8R",
  },
  "receipt-13.jpg": {
    transactionDate: "2026-11-02",
    amount: 12100,
    partnerName: "架空ホテル",
    accountCode: "5110",
    taxCategory: "PURCHASE_10",
  },
  "receipt-14.jpg": {
    transactionDate: "2026-10-31",
    amount: 18700,
    partnerName: "見本居酒屋",
    accountCode: "5140",
    taxCategory: "PURCHASE_10",
  },
  // 賃料（非課税）
  "receipt-15.png": {
    transactionDate: "2026-10-30",
    amount: 65000,
    partnerName: "架空不動産",
    accountCode: "5230",
    taxCategory: "NON_TAXABLE",
  },
  "receipt-16.jpg": {
    transactionDate: "2026-10-15",
    amount: 6820,
    partnerName: "架空電力",
    accountCode: "5100",
    taxCategory: "PURCHASE_10",
  },
  // HEIC（利用者が `sips` で変換して置く）
  "receipt-17.heic": {
    transactionDate: "2026-10-18",
    amount: 22000,
    partnerName: "テスト研修センター",
    accountCode: "5290",
    taxCategory: "PURCHASE_10",
  },
  "receipt-18.heic": {
    transactionDate: "2026-10-12",
    amount: 4950,
    partnerName: "合成プリント",
    accountCode: "5130",
    taxCategory: "PURCHASE_10",
  },
  // 電子の請求書・領収書（PDF）
  "receipt-19.pdf": {
    transactionDate: "2026-10-05",
    amount: 3300,
    partnerName: "合成クラウド株式会社",
    accountCode: "5120",
    taxCategory: "PURCHASE_10",
  },
  "receipt-20.pdf": {
    transactionDate: "2026-10-10",
    amount: 55000,
    partnerName: "架空デザイン",
    accountCode: "5210",
    taxCategory: "PURCHASE_10",
  },
};
