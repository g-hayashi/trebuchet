import { createFileRoute, redirect } from "@tanstack/react-router";
import { EntityListPage } from "@/features/entities/EntityListPage";
import { entityToRestore } from "@/features/entities/EntitySwitcher";

export const Route = createFileRoute("/")({
  // `?list=1`（ヘッダーの切替の「一覧・作成」。`true` も受ける）。1 件でも一覧と作成のフォームを出すための印
  validateSearch: (search: Record<string, unknown>): { list?: true } =>
    search.list === true || search.list === 1 || search.list === "1" || search.list === "true"
      ? { list: true }
      : {},
  // 事業体が 1 件ならそのホームを開く。2 件以上は一覧、0 件は作成の案内（011 FR-010）。
  // `list` があるときは開かない（1 件のとき 2 件目を作る画面へ行けなくなるため。2026-11-04 の E2E）
  beforeLoad: async ({ context, search }) => {
    if (search.list) return;
    const entityId = await entityToRestore(context.queryClient);
    if (entityId !== undefined) {
      throw redirect({ to: "/e/$entityId", params: { entityId }, replace: true });
    }
  },
  component: EntityListPage,
});
