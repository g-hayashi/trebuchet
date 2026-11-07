import { createFileRoute } from "@tanstack/react-router";
import { Id, StatementStatusFilter } from "@trebuchet/schema";
import { z } from "zod";
import { StatementsWorkspace } from "@/features/statements/StatementsWorkspace";

/**
 * `statementId` を付けて開くと、その明細に印を付ける（仕訳の詳細の「元の明細」から）。
 * `status` を付けると、その状態で絞り込んで開く（ホームの「未処理の明細」から。011 T009）。省略は「未処理」
 */
const StatementsSearch = z.object({
  statementId: Id.optional(),
  status: StatementStatusFilter.optional(),
});

export const Route = createFileRoute("/e/$entityId/statements/")({
  validateSearch: StatementsSearch,
  component: StatementsPage,
});

function StatementsPage() {
  const { entityId } = Route.useParams();
  const { statementId, status } = Route.useSearch();

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">明細</h1>
      <StatementsWorkspace entityId={entityId} highlightId={statementId} initialStatus={status} />
    </main>
  );
}
