import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import { AuthGate } from "@/features/auth/AuthGate";
import { BackupStatusBanner } from "@/features/backup/BackupStatusBanner";
import { EntitySwitcher } from "@/features/entities/EntitySwitcher";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
});

function RootLayout() {
  // 画面は、サインインしているときだけ描画する（FR-001・003）。帳簿のデータを含まない静的ファイルは常に配信される
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AuthGate>
        <BackupStatusBanner />
        <header className="border-b bg-card">
          <div className="mx-auto flex h-12 max-w-6xl items-center gap-6 px-4">
            <Link to="/" className="font-semibold">
              Trebuchet
            </Link>
            <div id="header-slot" className="flex flex-1 items-center gap-4">
              <EntitySwitcher />
            </div>
            <Link to="/settings/backup" className="text-sm underline-offset-4 hover:underline">
              バックアップ
            </Link>
            <Link to="/settings/ai" className="text-sm underline-offset-4 hover:underline">
              AI の設定
            </Link>
            <Link to="/settings/security" className="text-sm underline-offset-4 hover:underline">
              設定
            </Link>
          </div>
        </header>
        <Outlet />
      </AuthGate>
    </div>
  );
}
