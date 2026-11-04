import { createFileRoute } from "@tanstack/react-router";
import { ReviewQueue } from "@/features/statements/ReviewQueue";

export const Route = createFileRoute("/e/$entityId/statements/review")({
  component: ReviewPage,
});

function ReviewPage() {
  const { entityId } = Route.useParams();
  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">明細の確認</h1>
      <p className="text-sm text-muted-foreground">
        未処理の明細を 1 件ずつ確かめて承認します。承認するまで、帳簿（仕訳）は変わりません。
      </p>
      <ReviewQueue entityId={entityId} />
    </main>
  );
}
