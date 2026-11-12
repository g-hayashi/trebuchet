import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";
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
        <Link to="/e/$entityId/recurring/new" params={{ entityId }} className={buttonVariants()}>
          定期仕訳を作る
        </Link>
      </div>
      <RecurringList entityId={entityId} />
    </main>
  );
}
