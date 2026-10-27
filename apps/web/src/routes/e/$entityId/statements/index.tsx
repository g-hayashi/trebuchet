import { createFileRoute } from "@tanstack/react-router";
import { Id } from "@trebuchet/schema";
import { z } from "zod";
import { StatementsWorkspace } from "@/features/statements/StatementsWorkspace";

/** `statementId` を付けて開くと、その明細に印を付ける（仕訳の詳細の「元の明細」から） */
const StatementsSearch = z.object({ statementId: Id.optional() });

export const Route = createFileRoute("/e/$entityId/statements/")({
  validateSearch: StatementsSearch,
  component: StatementsPage,
});

function StatementsPage() {
  const { entityId } = Route.useParams();
  const { statementId } = Route.useSearch();

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">明細</h1>
      <p className="text-sm text-muted-foreground">
        取り込んだ明細を確かめて、仕訳として登録します。候補を確認して承認するまで、帳簿（仕訳）は変わりません。
      </p>
      <StatementsWorkspace entityId={entityId} highlightId={statementId} />
    </main>
  );
}
