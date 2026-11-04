import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { InvoiceListQuery, InvoiceListStatus } from "@trebuchet/schema";
import { z } from "zod";
import { InvoiceFlow } from "@/features/invoicing/InvoiceFlow";
import { InvoiceList } from "@/features/invoicing/InvoiceList";
import { InvoicePartners } from "@/features/invoicing/InvoicePartners";

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
      <h1 className="text-xl font-semibold">請求書</h1>
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
      <InvoicePartners entityId={entityId} />
    </main>
  );
}
