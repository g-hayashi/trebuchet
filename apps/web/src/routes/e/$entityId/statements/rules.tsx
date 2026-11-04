import { createFileRoute, Link } from "@tanstack/react-router";
import { RuleList } from "@/features/statements/RuleList";

export const Route = createFileRoute("/e/$entityId/statements/rules")({
  component: StatementRulesPage,
});

function StatementRulesPage() {
  const { entityId } = Route.useParams();

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">推定のルール</h1>
        <Link
          to="/e/$entityId/statements"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          明細の一覧へ
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        承認した明細から、「この内容の明細はこの科目」というルールを、承認のたびに自動で作る・更新します。直した・止めたルールは自動では変わりません（「利用者が直した」の印が付きます）。ルールは候補を作るのにだけ使い、承認するまで帳簿（仕訳）は変わりません。
      </p>
      <RuleList entityId={entityId} />
    </main>
  );
}
