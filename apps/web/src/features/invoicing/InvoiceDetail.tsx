import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { InvoiceDetail as InvoiceDetailData } from "@trebuchet/schema";
import { useEffect, useState } from "react";
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
import { invalidateLedger } from "@/lib/queries";
import { postInvoiceVoid, postPaymentVoid } from "./api";
import { invoiceTaxSummary, quantityOf, recipientOf } from "./display";
import { InvoicePrint } from "./InvoicePrint";
import { PaymentForm } from "./PaymentForm";
import { INVOICE_STATUS_LABELS } from "./status";

const linkClass = "text-primary underline underline-offset-4";

/**
 * 請求書の詳細（FR-010〜014、017〜021）。発行時の写しの表示、売上の仕訳へのリンク、印刷、取消（理由つき）、
 * 入金の消し込みの入力・一覧・取消
 */
export function InvoiceDetail({
  entityId,
  invoice,
}: {
  entityId: string;
  invoice: InvoiceDetailData;
}) {
  const queryClient = useQueryClient();
  const [voiding, setVoiding] = useState(false);
  const [voidingPayment, setVoidingPayment] = useState<string | null>(null);
  const voided = invoice.status === "voided";
  const summary = invoiceTaxSummary(invoice);
  // 源泉徴収のない請求書（005）では列を出さない
  const showWithholdingColumn =
    invoice.withholdingTax > 0 || invoice.payments.some((p) => p.withholdingAmount > 0);

  // 印刷（PDF に保存）のファイル名の既定になるので、開いている間だけ title を請求番号にする
  const invoiceNo = invoice.invoiceNo;
  useEffect(() => {
    const previous = document.title;
    document.title = invoiceNo;
    return () => {
      document.title = previous;
    };
  }, [invoiceNo]);
  const voidInvoice = useMutation({
    mutationFn: (reason: string) => postInvoiceVoid(entityId, invoice.id, reason),
    onSuccess: () => invalidateLedger(queryClient, entityId),
  });

  const confirmVoid = async (reason: string) => {
    await voidInvoice.mutateAsync(reason);
    setVoiding(false);
  };

  const voidPayment = useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) =>
      postPaymentVoid(entityId, invoice.id, paymentId, reason),
    onSuccess: () => invalidateLedger(queryClient, entityId),
  });

  const confirmVoidPayment = async (reason: string) => {
    if (voidingPayment === null) return;
    await voidPayment.mutateAsync({ paymentId: voidingPayment, reason });
    setVoidingPayment(null);
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
            {invoice.overdue && (
              <span className="rounded-md border border-destructive/60 px-2 py-0.5 text-sm text-destructive">
                期限切れ
              </span>
            )}
            <Button onClick={() => window.print()}>印刷・PDF に保存</Button>
            {!voided && (
              <Button variant="outline" onClick={() => setVoiding(true)}>
                取り消す
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-xs text-muted-foreground">
            ブラウザの印刷の設定でヘッダーとフッターを消せます
          </p>
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
                <TableHead className="text-right">{`単価（${summary.modeLabel}）`}</TableHead>
                <TableHead className="text-right">{`金額（${summary.modeLabel}）`}</TableHead>
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
            {summary.exclusive && (
              <>
                <p>{`小計（税抜）${formatYen(summary.subtotal)} 円`}</p>
                <p>{`${summary.taxLabel} ${formatYen(summary.tax)} 円`}</p>
              </>
            )}
            <p className="text-base font-semibold">{`合計 ${formatYen(invoice.total)} 円`}</p>
            {invoice.taxDisplay === "separate" &&
              invoice.taxBreakdown.map((b) => (
                <p key={b.rate} className="text-sm text-muted-foreground">
                  {`${b.rate}% 対象 税抜 ${formatYen(b.exclusive)} 円 ／ ${summary.taxLabel} ${formatYen(b.tax)} 円`}
                </p>
              ))}
            {invoice.withholdingTax > 0 && (
              <>
                <p>{`源泉徴収税額 ${formatYen(invoice.withholdingTax)} 円`}</p>
                <p className="text-base font-semibold">{`差引請求額 ${formatYen(invoice.netAmount)} 円`}</p>
              </>
            )}
            <p className="text-sm">{`入金 ${formatYen(invoice.paid)} 円`}</p>
            <p className="text-sm">{`残額 ${formatYen(invoice.remaining)} 円`}</p>
            {invoice.withholdingTax > 0 && (
              <p className="text-xs text-muted-foreground">
                残額は源泉徴収前の額です。入金の消し込みで、振り込まれた額と源泉徴収税額を合わせて充てます。
              </p>
            )}
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

          {invoice.payments.length > 0 && (
            <div className="grid gap-2">
              <h2 className="text-base font-semibold">入金の消し込み</h2>
              <Table aria-label="消し込みの一覧">
                <TableHeader>
                  <TableRow>
                    <TableHead>入金日</TableHead>
                    <TableHead className="text-right">入金額</TableHead>
                    <TableHead className="text-right">振込手数料</TableHead>
                    {showWithholdingColumn && (
                      <TableHead className="text-right">源泉徴収税額</TableHead>
                    )}
                    <TableHead>状態</TableHead>
                    <TableHead>仕訳</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoice.payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="tabular-nums">{p.receivedOn}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatYen(p.amount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatYen(p.feeAmount)}
                      </TableCell>
                      {showWithholdingColumn && (
                        <TableCell className="text-right tabular-nums">
                          {formatYen(p.withholdingAmount)}
                        </TableCell>
                      )}
                      <TableCell>
                        {p.voidedAt === null ? (
                          "有効"
                        ) : (
                          <>
                            取消済み
                            {p.voidReason !== null && (
                              <span className="ml-2 text-muted-foreground">{`（${p.voidReason}）`}</span>
                            )}
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-3">
                          <Link
                            to="/e/$entityId/journals/$journalId"
                            params={{ entityId, journalId: p.journalId }}
                            className={linkClass}
                          >
                            仕訳を開く
                          </Link>
                          {p.voidJournalId !== null && (
                            <Link
                              to="/e/$entityId/journals/$journalId"
                              params={{ entityId, journalId: p.voidJournalId }}
                              className={linkClass}
                            >
                              取消の仕訳を開く
                            </Link>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {p.voidedAt === null && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setVoidingPayment(p.id)}
                          >
                            消し込みを取り消す
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {!voided && invoice.remaining > 0 && (
            <PaymentForm entityId={entityId} invoice={invoice} />
          )}

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
      <ReasonDialog
        open={voidingPayment !== null}
        title="消し込みの取消"
        description="取り消すと、入金の仕訳も取り消され、請求書の残額が戻ります。理由は記録に残ります。"
        confirmLabel="取消を確定"
        onConfirm={confirmVoidPayment}
        onCancel={() => setVoidingPayment(null)}
      />

      {/* 印刷するもの。画面では inline の display: none で隠し、印刷では src/print.css の !important で出す（011 FR-036）。hidden 属性は使わない（preflight の [hidden] は layer 内の !important で上書きできず、印刷が空白になる） */}
      <div data-print-root style={{ display: "none" }}>
        <InvoicePrint invoice={invoice} />
      </div>
    </>
  );
}
