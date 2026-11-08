import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { DemoBanner } from "@/components/layout/DemoBanner";
import { EntityNav } from "@/components/layout/EntityNav";
import { isMobileRoute } from "@/components/layout/MobileNav";
import { PcRecommended } from "@/components/layout/PcRecommended";
import { entitiesQuery } from "@/features/entities/api";
import { RecurringNotice } from "@/features/recurring/RecurringNotice";
import { useIsMobile } from "@/lib/use-media-query";

export const Route = createFileRoute("/e/$entityId")({
  component: EntityLayout,
});

/** 事業体ごとの画面の共通レイアウト。2 段のメニューは `EntityNav`（事業体の名前はヘッダーに出す） */
function EntityLayout() {
  const { entityId } = Route.useParams();
  const { data: entities } = useQuery(entitiesQuery());
  const mobile = useIsMobile();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const notFound = entities !== undefined && !entities.some((e) => e.id === entityId);
  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      {notFound && <p className="mb-2 text-sm text-muted-foreground">（事業体が見つかりません）</p>}
      <DemoBanner entityId={entityId} />
      <PcRecommended />
      {/* スマホの幅の対象の画面は、2 段のメニューを出さず、ヘッダーのメニューに絞る（FR-059）。対象の外では出して、他の画面へ移れるようにする */}
      {mobile && isMobileRoute(pathname) ? null : <EntityNav entityId={entityId} />}
      {/* 自動で登録した定期仕訳の確認と、登録できなかった回の知らせ（005 FR-027・028） */}
      <RecurringNotice entityId={entityId} />
      <Outlet />
    </div>
  );
}
