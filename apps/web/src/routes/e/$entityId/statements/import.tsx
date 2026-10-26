import { createFileRoute, Link } from "@tanstack/react-router";
import { ImportWorkspace } from "@/features/statements/ImportWorkspace";

export const Route = createFileRoute("/e/$entityId/statements/import")({
  component: StatementImportPage,
});

function StatementImportPage() {
  const { entityId } = Route.useParams();

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">明細の取込</h1>
        <Link
          to="/e/$entityId/statements"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          明細の一覧へ
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        MF ME
        の「入出金」の表をコピーして貼り付けると、内容を確かめてから明細として取り込めます。取り込むだけでは、帳簿（仕訳）は変わりません。
      </p>
      <ImportWorkspace entityId={entityId} />
    </main>
  );
}
