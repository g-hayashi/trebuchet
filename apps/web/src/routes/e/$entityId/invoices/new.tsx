import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { WorkHoursQuery } from "@trebuchet/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type InvoiceDraftResult,
  invoiceListQuery,
  postInvoiceDrafts,
} from "@/features/invoicing/api";
import { InvoiceDraftList } from "@/features/invoicing/InvoiceDraftList";
import { partnersQuery } from "@/features/masters/api";
import { lastMonth } from "@/lib/dates";

export const Route = createFileRoute("/e/$entityId/invoices/new")({
  validateSearch: WorkHoursQuery.partial(),
  component: NewInvoicesPage,
});

function NewInvoicesPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const month = search.month ?? lastMonth();
  const partners = useQuery(partnersQuery(entityId));
  // 案は対象月ごとに作る。月を変えたら、前の月の案は出さない
  const [made, setMade] = useState<{ month: string; result: InvoiceDraftResult }>();
  const create = useMutation({
    mutationFn: () => postInvoiceDrafts(entityId, month),
    onSuccess: (result) => setMade({ month, result }),
  });
  const partnerNames = new Map(partners.data?.map((p) => [p.id, p.name]));
  const inactivePartnerIds = new Set(
    partners.data?.filter((p) => p.isActive === false).map((p) => p.id),
  );
  // 同じ取引先・対象月の発行済み（未取消）の請求書。あれば案の側で「発行済み」と示す
  const issuedList = useQuery({
    ...invoiceListQuery(entityId, { month }),
    enabled: made !== undefined,
  });
  const issuedInvoices = new Map(
    (issuedList.data?.invoices ?? [])
      .filter((inv) => inv.status !== "voided")
      .map((inv) => [
        `${inv.partnerId}-${inv.targetMonth}`,
        { id: inv.id, invoiceNo: inv.invoiceNo },
      ]),
  );
  // 案が出ている間の主な操作は案の「発行する」。案がなければ「内容を確認する」
  const draftsShown =
    made !== undefined &&
    made.month === month &&
    partners.data !== undefined &&
    made.result.drafts.length > 0;

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">請求書を作る</h1>
        <Link
          to="/e/$entityId/invoices"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          請求書の一覧へ
        </Link>
        <Link
          to="/e/$entityId/work-hours"
          params={{ entityId }}
          search={{ month }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          工数の入力へ
        </Link>
      </div>
      <form
        noValidate
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.reset();
          create.mutate();
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="invoice-month">対象月</Label>
          <Input
            id="invoice-month"
            type="month"
            value={month}
            onChange={(e) => {
              const next = WorkHoursQuery.safeParse({ month: e.target.value });
              if (next.success) void navigate({ search: { month: next.data.month } });
            }}
          />
        </div>
        <Button
          type="submit"
          variant={draftsShown ? "outline" : "default"}
          disabled={create.isPending}
        >
          内容を確認する
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        ここでは保存しません。発行すると請求書と仕訳ができます
      </p>
      <ApiErrorMessage error={create.error ?? partners.error} />
      {made && made.month === month && partners.data && (
        <InvoiceDraftList
          entityId={entityId}
          result={made.result}
          partnerNames={partnerNames}
          inactivePartnerIds={inactivePartnerIds}
          issuedInvoices={issuedInvoices}
        />
      )}
    </main>
  );
}
