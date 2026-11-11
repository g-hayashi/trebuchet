import { Link } from "@tanstack/react-router";
import type { ReceiptSummary } from "@trebuchet/schema";
import { formatYen } from "@/lib/format";
import { linkClass } from "@/lib/styles";
import { CATEGORY_LABELS } from "./labels";

/**
 * 仕訳の詳細の「元の証憑」（010 FR-011。`GET /journals/:id` の `receipts`）。
 * 証憑の詳細を開くリンクを付ける。結びついた証憑がなければ何も出さない
 */
export function JournalReceipts({
  entityId,
  receipts,
}: {
  entityId: string;
  receipts: ReceiptSummary[];
}) {
  if (receipts.length === 0) return null;
  return (
    <ul aria-label="元の証憑" className="grid gap-1 text-sm">
      {receipts.map((r) => (
        <li key={r.id}>
          {CATEGORY_LABELS[r.category]}: {r.transactionDate ?? "取引年月日は未入力"}{" "}
          {r.amount === null ? "金額は未入力" : formatYen(r.amount)}{" "}
          {r.partnerName ?? "取引先は未入力"}{" "}
          <Link
            to="/e/$entityId/receipts/$receiptId"
            params={{ entityId, receiptId: r.id }}
            className={linkClass}
          >
            証憑を開く
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** 仕訳の一覧の証憑の印。結びついた証憑がなければ何も出さない */
export function ReceiptMark({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground">
      証憑 {count}
    </span>
  );
}
