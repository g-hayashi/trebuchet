import { createFileRoute } from "@tanstack/react-router";
import { ReceiptUpload } from "@/features/receipts/ReceiptUpload";

export const Route = createFileRoute("/e/$entityId/receipts/new")({
  component: NewReceiptPage,
});

/** 証憑の追加（メニューの「証憑 → 追加する」）。今は追加のフォームを描くだけ。作り直しは US4 */
function NewReceiptPage() {
  const { entityId } = Route.useParams();
  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">証憑を追加</h1>
      <ReceiptUpload entityId={entityId} />
    </main>
  );
}
