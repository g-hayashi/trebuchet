import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { WorkHoursQuery } from "@trebuchet/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type InvoiceDraftResult, postInvoiceDrafts } from "@/features/invoicing/api";
import { InvoiceDraftList } from "@/features/invoicing/InvoiceDraftList";
import { defaultTargetMonth } from "@/features/invoicing/months";
import { partnersQuery } from "@/lib/queries";

export const Route = createFileRoute("/e/$entityId/invoices/new")({
  validateSearch: WorkHoursQuery.partial(),
  component: NewInvoicesPage,
});

function NewInvoicesPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const month = search.month ?? defaultTargetMonth();
  const partners = useQuery(partnersQuery(entityId));
  // 案は対象月ごとに作る。月を変えたら、前の月の案は出さない
  const [made, setMade] = useState<{ month: string; result: InvoiceDraftResult }>();
  const create = useMutation({
    mutationFn: () => postInvoiceDrafts(entityId, month),
    onSuccess: (result) => setMade({ month, result }),
  });
  const partnerNames = new Map(partners.data?.map((p) => [p.id, p.name]));

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">請求書の発行</h1>
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
        <Button type="submit" disabled={create.isPending}>
          案を作る
        </Button>
      </form>
      <ApiErrorMessage error={create.error ?? partners.error} />
      {made && made.month === month && partners.data && (
        <InvoiceDraftList entityId={entityId} result={made.result} partnerNames={partnerNames} />
      )}
    </main>
  );
}
