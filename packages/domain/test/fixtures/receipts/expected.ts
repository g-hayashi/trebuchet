import type { ReceiptEvalExpected } from "../../../src/receipts/evals.ts";

/**
 * 証憑の読み取りの評価（`pnpm eval:receipts`、010/R17）の正解。キーは `eval/` の下の画像のファイル名。
 * 画像（合成のレシート・領収書・電子の PDF 20 枚。HEIC 2 枚、PDF 2 枚を含む）の用意は T042（利用者）。
 * 画像を足したら、同じファイル名でここに正解を足す（`README.md` の「評価用の画像」）。
 * 正解を決めない項目は null（その項目は集計しない）。実データの値・取引先名は書かない（合成のみ）。
 *
 * 例:
 *   "receipt-01.jpg": {
 *     transactionDate: "2026-10-20", amount: 1100, partnerName: "合成商店",
 *     accountCode: "6100", taxCategory: "TAXABLE_10",
 *   },
 */
export const RECEIPT_EVAL_EXPECTED: Readonly<Record<string, ReceiptEvalExpected>> = {};
