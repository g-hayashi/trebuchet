import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/e/$entityId")({
  component: EntityLayout,
});

/** 事業体ごとの画面の共通レイアウト。ナビの項目は各画面を追加するときに足す（US1〜US5） */
const NAV: { label: string; to: "/e/$entityId" }[] = [{ label: "ホーム", to: "/e/$entityId" }];

function EntityLayout() {
  const { entityId } = Route.useParams();
  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <nav aria-label="事業体のメニュー" className="mb-4 flex gap-4 border-b pb-2 text-sm">
        {NAV.map((item) => (
          <Link
            key={item.label}
            to={item.to}
            params={{ entityId }}
            activeOptions={{ exact: true }}
            activeProps={{ className: "font-semibold underline" }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
