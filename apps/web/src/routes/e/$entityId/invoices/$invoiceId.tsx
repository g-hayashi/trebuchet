import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { invoiceQuery } from "@/features/invoicing/api";
import { InvoiceDetail } from "@/features/invoicing/InvoiceDetail";

export const Route = createFileRoute("/e/$entityId/invoices/$invoiceId")({
  component: InvoiceDetailPage,
});

function InvoiceDetailPage() {
  const { entityId, invoiceId } = Route.useParams();
  const { data, isPending, error } = useQuery(invoiceQuery(entityId, invoiceId));

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">{data ? `請求書 ${data.invoiceNo}` : "請求書"}</h1>
        <Link
          to="/e/$entityId/invoices"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          請求書の一覧へ
        </Link>
      </div>
      <ApiErrorMessage error={error} />
      {isPending && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {data && <InvoiceDetail entityId={entityId} invoice={data} />}
    </main>
  );
}
