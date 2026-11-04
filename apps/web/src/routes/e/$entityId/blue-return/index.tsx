import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { fiscalPeriodsQuery } from "@/features/periods/api";
import { currentPeriod } from "@/features/reports/periods";

export const Route = createFileRoute("/e/$entityId/blue-return/")({
  component: BlueReturnEntryPage,
});

/** 青色申告決算書の入口（FR-043）。今日を含む会計期間（なければ最新）の年の決算書へ転送する */
function BlueReturnEntryPage() {
  const { entityId } = Route.useParams();
  const { data: periods, error } = useQuery(fiscalPeriodsQuery(entityId));
  const period = periods && currentPeriod(periods);

  if (period) {
    return (
      <Navigate
        to="/e/$entityId/blue-return/$year"
        params={{ entityId, year: String(period.fiscalYear) }}
        replace
      />
    );
  }
  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">青色申告決算書</h1>
      <ApiErrorMessage error={error} />
      {periods?.length === 0 && (
        <p className="text-sm text-muted-foreground">会計期間がありません。</p>
      )}
      {periods === undefined && !error && (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      )}
    </main>
  );
}
