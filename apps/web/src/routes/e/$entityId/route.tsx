import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { entitiesQuery } from "@/lib/queries";

export const Route = createFileRoute("/e/$entityId")({
  component: EntityLayout,
});

type NavTo =
  | "/e/$entityId"
  | "/e/$entityId/journals"
  | "/e/$entityId/accounts"
  | "/e/$entityId/partners"
  | "/e/$entityId/tags"
  | "/e/$entityId/tax-settings"
  | "/e/$entityId/periods";

/** 事業体ごとの画面の共通レイアウト。ナビの項目は各画面を追加するときに足す（US1〜US5） */
const NAV: { label: string; to: NavTo }[] = [
  { label: "ホーム", to: "/e/$entityId" },
  { label: "仕訳", to: "/e/$entityId/journals" },
  { label: "勘定科目", to: "/e/$entityId/accounts" },
  { label: "取引先", to: "/e/$entityId/partners" },
  { label: "タグ", to: "/e/$entityId/tags" },
  { label: "消費税", to: "/e/$entityId/tax-settings" },
  { label: "会計期間", to: "/e/$entityId/periods" },
];

function EntityLayout() {
  const { entityId } = Route.useParams();
  const { data: entities } = useQuery(entitiesQuery());
  const entity = entities?.find((e) => e.id === entityId);
  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <p className="mb-2 text-sm text-muted-foreground">
        {entity?.name ?? (entities ? "（事業体が見つかりません）" : "読み込み中…")}
      </p>
      <nav
        aria-label="事業体のメニュー"
        className="mb-4 flex flex-wrap gap-4 border-b pb-2 text-sm"
      >
        {NAV.map((item) => (
          <Link
            key={item.label}
            to={item.to}
            params={{ entityId }}
            activeOptions={{ exact: item.to === "/e/$entityId" }}
            activeProps={{ className: "font-semibold underline", "aria-current": "page" }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
