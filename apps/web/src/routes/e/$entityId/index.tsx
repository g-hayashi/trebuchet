import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/e/$entityId/")({
  component: () => (
    <p className="text-sm text-muted-foreground">メニューから操作を選んでください。</p>
  ),
});
