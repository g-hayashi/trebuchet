import type { ReceiptCategory, ReceiptLinkState, ReceiptUpdateInput } from "@trebuchet/schema";
import type {
  JournalStatus,
  ReceiptAuditAction,
  ReceiptAuditEntry,
  ReceiptLinkRow,
  ReceiptRow,
} from "../types.ts";

/** 仕訳の取消で結びつきを自動で閉じるときの理由（research R5） */
export const RECEIPT_REASON_AUTO_VOIDED = "結びついた仕訳が取り消されたため";

/**
 * 結びつきの状態（保存しない。data-model §2.2）。有効な結びつきがなければ `none`、
 * あって仕訳が取り消されていれば `journal_voided`、そうでなければ `linked`
 */
export function linkStateOf(
  link: ReceiptLinkRow | undefined,
  journalStatus: JournalStatus | undefined,
): ReceiptLinkState {
  if (link === undefined || link.unlinkedAt !== null) return "none";
  return journalStatus === "voided" ? "journal_voided" : "linked";
}

/**
 * 値を更新するのに理由が要るか（FR-018、data-model §2.2）。取引年月日・金額・取引先・区分のどれかが、
 * NULL でない前の値から別の値（NULL を含む）に変わるときだけ。メモだけの変更・未入力の欄を埋めるだけなら要らない
 */
export function needsReason(
  before: Pick<ReceiptRow, "category" | "transactionDate" | "amount" | "partnerName">,
  input: ReceiptUpdateInput,
): boolean {
  const changed = <T>(prev: T | null, next: T | null | undefined): boolean =>
    prev !== null && next !== undefined && next !== prev;
  return (
    changed(before.transactionDate, input.transactionDate) ||
    changed(before.amount, input.amount) ||
    changed(before.partnerName, input.partnerName) ||
    changed<ReceiptCategory>(before.category, input.category)
  );
}

/** 履歴（`receipt_audit_log`）に書く証憑の値（data-model §2.5。`partnerKey` は含めない） */
export type ReceiptValues = {
  category: ReceiptCategory;
  transactionDate: string | null;
  amount: number | null;
  partnerName: string | null;
  memo: string | null;
  currentSha256: string;
  deletedAt: string | null;
};

export const receiptValuesOf = (row: ReceiptRow): ReceiptValues => ({
  category: row.category,
  transactionDate: row.transactionDate,
  amount: row.amount,
  partnerName: row.partnerName,
  memo: row.memo,
  currentSha256: row.currentSha256,
  deletedAt: row.deletedAt,
});

/** `replayReceiptHistory` の 1 点: 証憑の値を変えた操作の直後の値 */
export type ReceiptHistoryPoint = {
  occurredAt: string;
  action: Extract<ReceiptAuditAction, "create" | "update" | "replace_file" | "delete">;
  values: ReceiptValues;
};

const parse = (json: string | null): Record<string, unknown> => {
  if (json === null) return {};
  const value: unknown = JSON.parse(json);
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
};

/** 追加・更新の after から値を取り出す（追加は最初のファイルの `sha256` を `currentSha256` の代わりに持ってもよい） */
const valuesFrom = (after: Record<string, unknown>): ReceiptValues => ({
  category: after.category as ReceiptCategory,
  transactionDate: (after.transactionDate ?? null) as string | null,
  amount: (after.amount ?? null) as number | null,
  partnerName: (after.partnerName ?? null) as string | null,
  memo: (after.memo ?? null) as string | null,
  currentSha256: (after.currentSha256 ?? after.sha256) as string,
  deletedAt: (after.deletedAt ?? null) as string | null,
});

/**
 * 1 件の証憑の履歴（古い順）を順に当てて、値を変えた操作ごとに直後の値を返す（INV-63、SC-005）。
 * `create` の after から始め、`update` の after（全体の値）、`replace_file` の after の `sha256`、
 * `delete` の after の `deletedAt` を当てる。結びつき・読み取りの記録は値を変えないので飛ばす。
 * `create` より前の記録は無視する
 */
export function replayReceiptHistory(entries: readonly ReceiptAuditEntry[]): ReceiptHistoryPoint[] {
  const points: ReceiptHistoryPoint[] = [];
  let current: ReceiptValues | undefined;
  for (const entry of entries) {
    if (entry.targetType !== "receipt") continue;
    const after = parse(entry.afterJson);
    if (entry.action === "create" || entry.action === "update") {
      if (entry.action === "update" && current === undefined) continue;
      current = valuesFrom(after);
    } else if (current === undefined) {
      continue;
    } else if (entry.action === "replace_file") {
      current = { ...current, currentSha256: after.sha256 as string };
    } else if (entry.action === "delete") {
      current = { ...current, deletedAt: after.deletedAt as string };
    } else {
      continue;
    }
    points.push({
      occurredAt: entry.occurredAt,
      action: entry.action,
      values: structuredClone(current),
    });
  }
  return points;
}
