import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { EntityNav } from "@/components/layout/EntityNav";
import { entitiesQuery } from "@/features/entities/api";
import { RecurringNotice } from "@/features/recurring/RecurringNotice";

export const Route = createFileRoute("/e/$entityId")({
  component: EntityLayout,
});

/** 事業体ごとの画面の共通レイアウト。2 段のメニューは `EntityNav`（事業体の名前はヘッダーに出す） */
function EntityLayout() {
  const { entityId } = Route.useParams();
  const { data: entities } = useQuery(entitiesQuery());
  const notFound = entities !== undefined && !entities.some((e) => e.id === entityId);
  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      {notFound && <p className="mb-2 text-sm text-muted-foreground">（事業体が見つかりません）</p>}
      <EntityNav entityId={entityId} />
      {/* 自動で登録した定期仕訳の確認と、登録できなかった回の知らせ（005 FR-027・028） */}
      <RecurringNotice entityId={entityId} />
      <Outlet />
    </div>
  );
}
