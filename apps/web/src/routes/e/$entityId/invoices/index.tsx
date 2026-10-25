import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { InvoiceListQuery } from "@trebuchet/schema";
import { InvoiceList } from "@/features/invoicing/InvoiceList";

/** URL の絞り込み（取引先・対象月・状態） */
const InvoiceSearch = InvoiceListQuery;

export const Route = createFileRoute("/e/$entityId/invoices/")({
  validateSearch: InvoiceSearch,
  component: InvoicesPage,
});

const linkButton =
  "inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium shadow-xs hover:bg-accent";

function InvoicesPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">請求書</h1>
        <div className="flex flex-wrap gap-2">
          <Link to="/e/$entityId/work-hours" params={{ entityId }} className={linkButton}>
            工数の入力
          </Link>
          <Link
            to="/e/$entityId/invoices/new"
            params={{ entityId }}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
          >
            請求書を作る
          </Link>
          <Link to="/e/$entityId/invoice-settings" params={{ entityId }} className={linkButton}>
            請求の設定
          </Link>
        </div>
      </div>
      <InvoiceList
        entityId={entityId}
        filters={search}
        onFiltersChange={(next) =>
          void navigate({
            search: {
              ...(next.partnerId === undefined ? {} : { partnerId: next.partnerId }),
              ...(next.month === undefined ? {} : { month: next.month }),
              ...(next.status === undefined ? {} : { status: next.status }),
            },
          })
        }
      />
    </main>
  );
}
