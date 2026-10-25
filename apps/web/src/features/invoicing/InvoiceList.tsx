import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatYen } from "@/lib/format";
import { partnersQuery } from "@/lib/queries";
import { type InvoiceFilters, invoiceListQuery } from "./api";
import { INVOICE_LIST_STATUS_LABELS, INVOICE_LIST_STATUSES, INVOICE_STATUS_LABELS } from "./status";

/**
 * 請求書の一覧（FR-020・022）。番号・取引先・対象月・発行日・合計・状態・残額と、取引先・対象月・状態の絞り込み。
 * 期限切れの請求書には印を付け、取引先ごとの未回収の残額（うち期限切れ）を表で示す
 */
export function InvoiceList({
  entityId,
  filters,
  onFiltersChange,
}: {
  entityId: string;
  filters: InvoiceFilters;
  onFiltersChange: (filters: InvoiceFilters) => void;
}) {
  const partners = useQuery(partnersQuery(entityId));
  const invoices = useQuery(invoiceListQuery(entityId, filters));
  const error = invoices.error ?? partners.error;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-2">
          <Label htmlFor="invoice-filter-partner">取引先</Label>
          <NativeSelect
            id="invoice-filter-partner"
            value={filters.partnerId ?? ""}
            onChange={(e) =>
              onFiltersChange({ ...filters, partnerId: e.target.value || undefined })
            }
          >
            <option value="">すべて</option>
            {partners.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="invoice-filter-month">対象月</Label>
          <Input
            id="invoice-filter-month"
            type="month"
            value={filters.month ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, month: e.target.value || undefined })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="invoice-filter-status">状態</Label>
          <NativeSelect
            id="invoice-filter-status"
            value={filters.status ?? ""}
            onChange={(e) =>
              onFiltersChange({
                ...filters,
                status: INVOICE_LIST_STATUSES.find((s) => s === e.target.value),
              })
            }
          >
            <option value="">すべて</option>
            {INVOICE_LIST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {INVOICE_LIST_STATUS_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
        {(filters.partnerId !== undefined ||
          filters.month !== undefined ||
          filters.status !== undefined) && (
          <Button variant="ghost" onClick={() => onFiltersChange({})}>
            絞り込みを解除
          </Button>
        )}
      </div>
      <ApiErrorMessage error={error} />
      {invoices.isPending && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {invoices.data && invoices.data.outstandingByPartner.length > 0 && (
        <section className="grid gap-2" aria-label="未回収">
          <h2 className="text-base font-semibold">取引先ごとの未回収</h2>
          <Table aria-label="取引先ごとの未回収">
            <TableHeader>
              <TableRow>
                <TableHead>取引先</TableHead>
                <TableHead className="text-right">未回収の残額</TableHead>
                <TableHead className="text-right">うち期限切れ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.data.outstandingByPartner.map((o) => (
                <TableRow key={o.partnerId}>
                  <TableCell>{o.partnerName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatYen(o.outstanding)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatYen(o.overdue)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      {invoices.data &&
        (invoices.data.invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">請求書はありません。</p>
        ) : (
          <Table aria-label="請求書の一覧">
            <TableHeader>
              <TableRow>
                <TableHead>番号</TableHead>
                <TableHead>取引先</TableHead>
                <TableHead>対象月</TableHead>
                <TableHead>発行日</TableHead>
                <TableHead className="text-right">合計</TableHead>
                <TableHead>状態</TableHead>
                <TableHead className="text-right">残額</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.data.invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell>
                    <Link
                      to="/e/$entityId/invoices/$invoiceId"
                      params={{ entityId, invoiceId: invoice.id }}
                      className="text-primary underline underline-offset-4"
                    >
                      {invoice.invoiceNo}
                    </Link>
                  </TableCell>
                  <TableCell>{invoice.recipientName}</TableCell>
                  <TableCell className="tabular-nums">{invoice.targetMonth}</TableCell>
                  <TableCell className="tabular-nums">{invoice.issueDate}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatYen(invoice.total)}
                  </TableCell>
                  <TableCell>
                    {INVOICE_STATUS_LABELS[invoice.status]}
                    {invoice.overdue && (
                      <span className="ml-2 rounded-md border border-destructive/60 px-1.5 py-0.5 text-xs text-destructive">
                        期限切れ
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatYen(invoice.remaining)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </div>
  );
}
