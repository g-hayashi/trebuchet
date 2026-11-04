import { createFileRoute } from "@tanstack/react-router";
import { ReceiptUpload } from "@/features/receipts/ReceiptUpload";

export const Route = createFileRoute("/e/$entityId/receipts/new")({
  component: NewReceiptPage,
});

function NewReceiptPage() {
  const { entityId } = Route.useParams();
  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">証憑を追加</h1>
      <ReceiptUpload key={entityId} entityId={entityId} />
    </main>
  );
}
