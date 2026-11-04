import { createFileRoute, Link } from "@tanstack/react-router";
import { SourceList } from "@/features/statements/SourceList";
import { StatementSettingsForm } from "@/features/statements/StatementSettingsForm";

export const Route = createFileRoute("/e/$entityId/statements/settings")({
  component: StatementSettingsPage,
});

function StatementSettingsPage() {
  const { entityId } = Route.useParams();

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">明細の設定</h1>
        <Link
          to="/e/$entityId/statements"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          明細の一覧へ
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        この事業体の、確信度のしきい値です。ここでだけ変えます（一覧・確認の画面には出ません）。まとめて承認（確認の画面の「まとめて承認」）と、外部の
        AI へ送るかどうかの判定に使います。
      </p>
      <StatementSettingsForm entityId={entityId} />
      <SourceList entityId={entityId} />
    </main>
  );
}
