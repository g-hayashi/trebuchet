import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { recurringDetailQuery } from "@/features/recurring/api";
import { RecurringDetail } from "@/features/recurring/RecurringDetail";

export const Route = createFileRoute("/e/$entityId/recurring/$recurringId")({
  component: RecurringDetailPage,
});

function RecurringDetailPage() {
  const { entityId, recurringId } = Route.useParams();
  const { data, isPending, error } = useQuery(recurringDetailQuery(entityId, recurringId));

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">{data ? data.recurring.name : "定期仕訳"}</h1>
        <Link
          to="/e/$entityId/recurring"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          定期仕訳の一覧へ
        </Link>
      </div>
      <ApiErrorMessage error={error} />
      {isPending && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {data && <RecurringDetail entityId={entityId} detail={data} />}
    </main>
  );
}
