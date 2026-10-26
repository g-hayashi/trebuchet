import { createFileRoute, Link } from "@tanstack/react-router";
import { EvalRuns } from "@/features/statements/EvalRuns";

export const Route = createFileRoute("/e/$entityId/statements/evals")({
  component: StatementEvalsPage,
});

function StatementEvalsPage() {
  const { entityId } = Route.useParams();

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">推定の評価</h1>
        <Link
          to="/e/$entityId/statements"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          明細の一覧へ
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        ルールと AI
        の推定が、どのくらい当たるかを測ります。ルールや設定を変えたあとに実行して、前回と比べてください。
      </p>
      <EvalRuns entityId={entityId} />
    </main>
  );
}
