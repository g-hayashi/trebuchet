import { createFileRoute } from "@tanstack/react-router";
import { AiSettingsForm } from "@/features/ai-settings/AiSettingsForm";

export const Route = createFileRoute("/settings/ai")({
  component: AiSettingsPage,
});

function AiSettingsPage() {
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6">
      <h1 className="text-xl font-semibold">AI の設定</h1>
      <p className="text-sm text-muted-foreground">
        明細の推定に使う AI
        の設定です。この端末の設定で、事業体によりません。外へ送るかどうかを決める確信度のしきい値は、事業体ごとの「明細の設定」にあります。
        推定は候補を作るだけで、承認するまで帳簿（仕訳）は変わりません。
      </p>
      <AiSettingsForm />
    </main>
  );
}
