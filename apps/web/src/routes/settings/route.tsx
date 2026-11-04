import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

const SETTINGS_NAV = [
  { label: "セキュリティ", to: "/settings/security" },
  { label: "バックアップ", to: "/settings/backup" },
  { label: "AI", to: "/settings/ai" },
  { label: "リモート", to: "/settings/remote" },
] as const;

function SettingsLayout() {
  return (
    <div className="mx-auto max-w-4xl">
      <nav
        aria-label="設定のメニュー"
        className="mb-4 flex flex-wrap gap-4 border-b px-4 py-2 text-sm"
      >
        {SETTINGS_NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
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
