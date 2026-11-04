import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { InvoiceListStatus } from "@trebuchet/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { partnersQuery } from "@/features/masters/api";
import { formatYen } from "@/lib/format";
import { type InvoiceFilters, invoiceListQuery } from "./api";
import { PaymentForm } from "./PaymentForm";
import { INVOICE_LIST_STATUS_LABELS, INVOICE_LIST_STATUSES, INVOICE_STATUS_LABELS } from "./status";

/** URL の状態の絞り込み。省略は既定（未入金・一部入金 = 未回収。期限切れはこの中にある）、`all` はすべて */
export type ListStatus = InvoiceListStatus | "all";
export type ListFilters = Omit<InvoiceFilters, "status"> & { status?: ListStatus | undefined };

/** サーバーへ送る絞り込み（`all` は status を送らない） */
export const toQueryFilters = (filters: ListFilters): InvoiceFilters => ({
  ...filters,
  status: filters.status === "all" ? undefined : filters.status,
});

/**
 * 請求書の一覧（FR-020・022、011 FR-035）。番号・取引先・対象月・発行日・合計・状態・残額と、取引先・対象月・状態の絞り込み。
 * 既定の表示は未入金・期限切れ（未回収）。期限切れの請求書には印を付け、取引先ごとの未回収の残額（うち期限切れ）を表で示す。
 * 未回収の行から入金を記録できる（パネル）
 */
export function InvoiceList({
  entityId,
  filters,
  onFiltersChange,
}: {
  entityId: string;
  filters: ListFilters;
  onFiltersChange: (filters: ListFilters) => void;
}) {
  const partners = useQuery(partnersQuery(entityId));
  // 既定と「すべて」は status を送らず、既定のときだけ画面で未回収に絞る
  const invoices = useQuery(invoiceListQuery(entityId, toQueryFilters(filters)));
  const error = invoices.error ?? partners.error;
  const [paying, setPaying] = useState<{
    id: string;
    invoiceNo: string;
    remaining: number;
  } | null>(null);
  const rows =
    invoices.data?.invoices.filter(
      (i) => filters.status !== undefined || i.status === "unpaid" || i.status === "partial",
    ) ?? [];

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
                status:
                  e.target.value === "all"
                    ? "all"
                    : INVOICE_LIST_STATUSES.find((s) => s === e.target.value),
              })
            }
          >
            <option value="">未回収（未入金・期限切れ）</option>
            {INVOICE_LIST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {INVOICE_LIST_STATUS_LABELS[s]}
              </option>
            ))}
            <option value="all">すべて</option>
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
        (rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {filters.status === undefined
              ? "未入金・期限切れの請求書はありません。"
              : "請求書はありません。"}
          </p>
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
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((invoice) => (
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
                  <TableCell className="text-right">
                    {invoice.status !== "voided" && invoice.remaining > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`入金（${invoice.invoiceNo}）`}
                        onClick={() =>
                          setPaying({
                            id: invoice.id,
                            invoiceNo: invoice.invoiceNo,
                            remaining: invoice.remaining,
                          })
                        }
                      >
                        入金
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
      <Sheet open={paying !== null} onOpenChange={(open) => !open && setPaying(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{`入金の記録（${paying?.invoiceNo ?? ""}）`}</SheetTitle>
            <SheetDescription>
              入金先は前回使った科目が既定です。消し込むと請求書の残額と仕訳に反映されます。
            </SheetDescription>
          </SheetHeader>
          {paying !== null && (
            <PaymentForm
              key={paying.id}
              entityId={entityId}
              invoice={paying}
              onPaid={() => setPaying(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
