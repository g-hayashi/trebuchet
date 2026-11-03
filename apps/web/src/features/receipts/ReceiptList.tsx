import { Link } from "@tanstack/react-router";
import type { ReceiptSummary } from "@trebuchet/schema";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatYen } from "@/lib/format";
import {
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  LINK_STATE_LABELS,
  MEDIA_TYPE_LABELS,
  warningLabel,
} from "./labels";

const MISSING = <span className="text-muted-foreground">未入力</span>;

/** 証憑の一覧（FR-008）。未入力の値は「未入力」と示し、詳細から入力する */
export function ReceiptList({
  entityId,
  receipts,
}: {
  entityId: string;
  receipts: ReceiptSummary[];
}) {
  return (
    <Table aria-label="証憑の一覧">
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">取引年月日</TableHead>
          <TableHead className="w-28 text-right">金額</TableHead>
          <TableHead>取引先</TableHead>
          <TableHead>区分・形式</TableHead>
          <TableHead>経路</TableHead>
          <TableHead>結びつき</TableHead>
          <TableHead>警告・状態</TableHead>
          <TableHead className="w-24">
            <span className="sr-only">操作</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {receipts.map((r) => (
          <ReceiptRow key={r.id} entityId={entityId} receipt={r} />
        ))}
      </TableBody>
    </Table>
  );
}

function ReceiptRow({ entityId, receipt: r }: { entityId: string; receipt: ReceiptSummary }) {
  const needsInput = !r.deleted && r.warnings.some((w) => w.code === "FIELDS_MISSING");
  return (
    <TableRow>
      <TableCell>{r.transactionDate ?? MISSING}</TableCell>
      <TableCell className="text-right tabular-nums">
        {r.amount === null ? MISSING : formatYen(r.amount)}
      </TableCell>
      <TableCell>{r.partnerName ?? MISSING}</TableCell>
      <TableCell>
        <div>{CATEGORY_LABELS[r.category]}</div>
        <div className="text-xs text-muted-foreground">{MEDIA_TYPE_LABELS[r.mediaType]}</div>
      </TableCell>
      <TableCell>{CHANNEL_LABELS[r.channel]}</TableCell>
      <TableCell>
        <div>{LINK_STATE_LABELS[r.linkState]}</div>
        {r.journal && (
          <Link
            to="/e/$entityId/journals/$journalId"
            params={{ entityId, journalId: r.journal.id }}
            className="text-xs underline"
          >
            仕訳 No.{r.journal.journalNo}
          </Link>
        )}
      </TableCell>
      <TableCell>
        {r.deleted && <div className="font-medium">削除済み</div>}
        {r.warnings.length > 0 && (
          <ul className="grid gap-1 text-xs">
            {r.warnings.map((w) => (
              <li key={w.code}>{warningLabel(w)}</li>
            ))}
          </ul>
        )}
      </TableCell>
      <TableCell>
        <Link
          to="/e/$entityId/receipts/$receiptId"
          params={{ entityId, receiptId: r.id }}
          className="underline"
        >
          {needsInput ? "入力する" : "開く"}
        </Link>
      </TableCell>
    </TableRow>
  );
}
