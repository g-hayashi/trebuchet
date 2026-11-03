import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/e/$entityId/")({
  component: EntityHome,
});

/** 事業体のホーム。「今日やること」などの中身は US2（011 T0xx）。名前の変更は「事業体の設定 → 基本」へ移した */
function EntityHome() {
  return (
    <main className="grid gap-6">
      <p className="text-sm text-muted-foreground">メニューから操作を選んでください。</p>
    </main>
  );
}
