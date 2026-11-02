import { createFileRoute, Link } from "@tanstack/react-router";
import { CaptureForm } from "@/features/receipts/CaptureForm";

export const Route = createFileRoute("/e/$entityId/receipts/capture")({
  component: CapturePage,
});

function CapturePage() {
  const { entityId } = Route.useParams();
  return (
    <main className="mx-auto grid max-w-xl gap-4">
      <h1 className="text-xl font-semibold">証憑を撮る</h1>
      <p className="text-sm text-muted-foreground">
        領収書・請求書を撮影するか、ファイルを選んで送ります。送信が終わるまで、この画面を閉じないでください。
      </p>
      <CaptureForm entityId={entityId} />
      <Link to="/e/$entityId/receipts" params={{ entityId }} className="text-sm underline">
        証憑の一覧へ
      </Link>
    </main>
  );
}
