import { createFileRoute, redirect } from "@tanstack/react-router";
import { EntityListPage } from "@/features/entities/EntityListPage";
import { entityToRestore } from "@/features/entities/EntitySwitcher";

export const Route = createFileRoute("/")({
  // 事業体が 1 件ならそのホームを開く。2 件以上は一覧、0 件は作成の案内（011/FR-010）。
  // 1 件でも一覧と作成のフォームを出すときは `/list`
  beforeLoad: async ({ context }) => {
    const entityId = await entityToRestore(context.queryClient);
    if (entityId !== undefined) {
      throw redirect({ to: "/e/$entityId", params: { entityId }, replace: true });
    }
  },
  component: EntityListPage,
});
