import { createFileRoute } from "@tanstack/react-router";
import { JournalDetailContent } from "@/features/journals/JournalDetailContent";

export const Route = createFileRoute("/e/$entityId/journals/$journalId")({
  component: JournalDetailPage,
});

function JournalDetailPage() {
  const { entityId, journalId } = Route.useParams();
  return (
    <main>
      <JournalDetailContent entityId={entityId} journalId={journalId} />
    </main>
  );
}
