import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { InvoiceDetail as InvoiceDetailData } from "@trebuchet/schema";
import { useState } from "react";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatYen } from "@/lib/format";
import { queryKeys } from "@/lib/queries";
import { invoiceKeys, postInvoiceVoid } from "./api";
import { quantityOf, recipientOf } from "./display";
import { INVOICE_STATUS_LABELS } from "./status";

const linkClass = "text-primary underline underline-offset-4";

/** 請求書の詳細（FR-010〜014）。発行時の写しの表示、売上の仕訳へのリンク、印刷、取消（理由つき） */
export function InvoiceDetail({
  entityId,
  invoice,
}: {
  entityId: string;
  invoice: InvoiceDetailData;
}) {
  const queryClient = useQueryClient();
  const [voiding, setVoiding] = useState(false);
  const voided = invoice.status === "voided";

  const voidInvoice = useMutation({
    mutationFn: (reason: string) => postInvoiceVoid(entityId, invoice.id, reason),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: invoiceKeys.invoices(entityId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.journals(entityId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.reports(entityId) }),
      ]);
    },
  });

  const confirmVoid = async (reason: string) => {
    await voidInvoice.mutateAsync(reason);
    setVoiding(false);
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>{recipientOf(invoice)}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border px-2 py-0.5 text-sm">
              {INVOICE_STATUS_LABELS[invoice.status]}
            </span>
            <Link
              to="/e/$entityId/invoices/$invoiceId/print"
              params={{ entityId, invoiceId: invoice.id }}
              className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium shadow-xs hover:bg-accent"
            >
              印刷・PDF に保存
            </Link>
            {!voided && (
              <Button variant="outline" onClick={() => setVoiding(true)}>
                取り消す
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1 text-sm">
            <p>{`対象月 ${invoice.targetMonth}`}</p>
            <p>{`発行日 ${invoice.issueDate}`}</p>
            <p>{`売上の計上日 ${invoice.salesDate}`}</p>
            <p>{`支払期限 ${invoice.dueDate}`}</p>
          </div>

          <Table aria-label="明細">
            <TableHeader>
              <TableRow>
                <TableHead>品名</TableHead>
                <TableHead className="text-right">数量</TableHead>
                <TableHead className="text-right">単価</TableHead>
                <TableHead className="text-right">金額</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.items.map((item) => (
                <TableRow key={item.lineNo}>
                  <TableCell>{item.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{quantityOf(item)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.unitPrice === null ? "" : formatYen(item.unitPrice)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatYen(item.amount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="grid justify-items-end gap-1 tabular-nums">
            <p className="text-base font-semibold">{`合計 ${formatYen(invoice.total)} 円`}</p>
            {invoice.taxDisplay === "separate" &&
              invoice.taxBreakdown.map((b) => (
                <p key={b.rate} className="text-sm text-muted-foreground">
                  {`${b.rate}% 対象 税抜 ${formatYen(b.exclusive)} 円 ／ 消費税 ${formatYen(b.tax)} 円`}
                </p>
              ))}
            <p className="text-sm">{`入金 ${formatYen(invoice.paid)} 円`}</p>
            <p className="text-sm">{`残額 ${formatYen(invoice.remaining)} 円`}</p>
          </div>

          <div className="flex flex-wrap gap-4 text-sm">
            <Link
              to="/e/$entityId/journals/$journalId"
              params={{ entityId, journalId: invoice.journalId }}
              className={linkClass}
            >
              売上の仕訳を開く
            </Link>
            {invoice.voidJournalId !== null && (
              <Link
                to="/e/$entityId/journals/$journalId"
                params={{ entityId, journalId: invoice.voidJournalId }}
                className={linkClass}
              >
                取消の仕訳を開く
              </Link>
            )}
          </div>

          {voided && (
            <div className="grid gap-1 rounded-md border px-3 py-2 text-sm">
              {invoice.voidedAt !== null && (
                <p>{`取り消した日時 ${formatDateTime(invoice.voidedAt)}`}</p>
              )}
              {invoice.voidReason !== null && <p>{`理由: ${invoice.voidReason}`}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <ReasonDialog
        open={voiding}
        title="請求書の取消"
        description="取り消すと、売上の仕訳も取り消されます。番号は再び使えません。理由は記録に残ります。"
        confirmLabel="取消を確定"
        onConfirm={confirmVoid}
        onCancel={() => setVoiding(false)}
      />
    </>
  );
}
