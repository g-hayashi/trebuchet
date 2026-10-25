import { createFileRoute, Link } from "@tanstack/react-router";
import { RecurringList } from "@/features/recurring/RecurringList";

export const Route = createFileRoute("/e/$entityId/recurring/")({
  component: RecurringPage,
});

function RecurringPage() {
  const { entityId } = Route.useParams();

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">定期仕訳</h1>
        <Link
          to="/e/$entityId/recurring/new"
          params={{ entityId }}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          定期仕訳を作る
        </Link>
      </div>
      <RecurringList entityId={entityId} />
    </main>
  );
}
