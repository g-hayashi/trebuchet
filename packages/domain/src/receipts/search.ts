import type { ReceiptLinkState, ReceiptQuery } from "@trebuchet/schema";
import type { ReceiptRow } from "../types.ts";

/**
 * 取引先の比較用の文字列（`partner_key`、research R4）。NFKC → 大文字 → 空白を除く。
 * 006 の `normalizeContent` から数字の `#` 置換を除いたもの
 */
export function normalizeReceiptText(text: string): string {
  return text.normalize("NFKC").toUpperCase().replace(/\s+/g, "");
}

/** `LIKE ... ESCAPE '\'` に渡す語の `%`・`_`・`\` を `\` で逃がす（db が使う） */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

/**
 * 検索条件（data-model §2.3）に合うか。db の SQL の検索の正解（INV-65 の素朴なフィルタ）。
 * `cursor`・`limit` はページの切り方なので見ない。`linkState` は有効な結びつきと仕訳の状態から
 * 導いた値を渡す（`linkStateOf`）
 */
export function matchesReceiptQuery(
  receipt: ReceiptRow,
  linkState: ReceiptLinkState,
  query: ReceiptQuery,
): boolean {
  if (!query.includeDeleted && receipt.deletedAt !== null) return false;
  if (query.dateFrom !== undefined) {
    if (receipt.transactionDate === null || receipt.transactionDate < query.dateFrom) return false;
  }
  if (query.dateTo !== undefined) {
    if (receipt.transactionDate === null || receipt.transactionDate > query.dateTo) return false;
  }
  if (query.amountMin !== undefined) {
    if (receipt.amount === null || receipt.amount < query.amountMin) return false;
  }
  if (query.amountMax !== undefined) {
    if (receipt.amount === null || receipt.amount > query.amountMax) return false;
  }
  if (query.partner !== undefined) {
    if (receipt.partnerKey === null) return false;
    if (!receipt.partnerKey.includes(normalizeReceiptText(query.partner))) return false;
  }
  if (query.category !== undefined && receipt.category !== query.category) return false;
  if (query.missing === true && !isMissingFields(receipt)) return false;
  if (query.link !== undefined && linkState !== query.link) return false;
  return true;
}

/** `FIELDS_MISSING`: 取引年月日・金額・取引先のどれかが未入力 */
const isMissingFields = (r: ReceiptRow): boolean =>
  r.transactionDate === null || r.amount === null || r.partnerName === null;
