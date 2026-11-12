import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { WithholdingList } from "@/features/invoicing/WithholdingList";
import { thisYear } from "@/lib/dates";
import { YearSearch } from "@/lib/year-search";

/** 年は暦年（入金日の年） */
export const Route = createFileRoute("/e/$entityId/invoices/withholding")({
  validateSearch: YearSearch,
  component: WithholdingPage,
});

/** 源泉徴収の一覧（013 US3）。申告の「源泉徴収税額」と、取引先の支払調書の確認に使う */
function WithholdingPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">源泉徴収の一覧</h1>
        <Link
          to="/e/$entityId/invoices"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          請求書の一覧へ
        </Link>
      </div>
      <WithholdingList
        entityId={entityId}
        year={search.year ?? thisYear()}
        onYearChange={(year) => void navigate({ search: { year } })}
      />
    </main>
  );
}
