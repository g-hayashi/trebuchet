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
import { INVOICE_STATUS_LABELS } from "./status";

/**
 * 請求書の一覧（基本形。FR-020）。番号・取引先・対象月・発行日・合計・状態・残額と、取引先・対象月の絞り込み。
 * 状態の絞り込み・期限切れの印・取引先ごとの未回収は US2
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
        {(filters.partnerId !== undefined || filters.month !== undefined) && (
          <Button variant="ghost" onClick={() => onFiltersChange({})}>
            絞り込みを解除
          </Button>
        )}
      </div>
      <ApiErrorMessage error={error} />
      {invoices.isPending && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}
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
                  <TableCell>{INVOICE_STATUS_LABELS[invoice.status]}</TableCell>
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
