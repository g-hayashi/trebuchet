import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { InvoiceListQuery, InvoiceListStatus } from "@trebuchet/schema";
import { z } from "zod";
import { InvoiceFlow } from "@/features/invoicing/InvoiceFlow";
import { InvoiceList } from "@/features/invoicing/InvoiceList";

const primaryLink =
  "inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90";

const secondaryLink =
  "inline-flex h-9 items-center rounded-md border bg-background px-4 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground";

/** URL の絞り込み（取引先・対象月・状態）。状態の省略は既定（未回収）、`all` はすべて */
const InvoiceSearch = InvoiceListQuery.extend({
  status: z.union([InvoiceListStatus, z.literal("all")]).optional(),
});

export const Route = createFileRoute("/e/$entityId/invoices/")({
  validateSearch: InvoiceSearch,
  component: InvoicesPage,
});

function InvoicesPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">請求書</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/e/$entityId/invoices/withholding"
            params={{ entityId }}
            className={secondaryLink}
          >
            源泉徴収の一覧
          </Link>
          <Link to="/e/$entityId/invoices/new" params={{ entityId }} className={primaryLink}>
            請求書を作る
          </Link>
        </div>
      </div>
      <InvoiceFlow entityId={entityId} filters={search} />
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
      <p className="text-sm text-muted-foreground">
        取引先と請求の条件（単価・品名など）は取引先の画面で登録・編集します。{" "}
        <Link
          to="/e/$entityId/partners"
          params={{ entityId }}
          className="text-foreground underline underline-offset-4"
        >
          取引先の画面へ
        </Link>
      </p>
    </main>
  );
}
