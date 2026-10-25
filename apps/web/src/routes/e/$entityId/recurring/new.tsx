import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RecurringForm } from "@/features/recurring/RecurringForm";

export const Route = createFileRoute("/e/$entityId/recurring/new")({
  component: NewRecurringPage,
});

function NewRecurringPage() {
  const { entityId } = Route.useParams();
  const navigate = useNavigate();

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">定期仕訳を作る</h1>
        <Link
          to="/e/$entityId/recurring"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          定期仕訳の一覧へ
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        毎月の予定日に、ここで決めた仕訳を自動で登録します。開始月が今月以前のときは、予定日が今日以前の回をすぐに登録します。
      </p>
      <RecurringForm
        entityId={entityId}
        onSaved={(saved) =>
          void navigate({
            to: "/e/$entityId/recurring/$recurringId",
            params: { entityId, recurringId: saved.id },
          })
        }
      />
    </main>
  );
}
