import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ToastProvider } from "@/components/ui/toast";
import { AuthGate } from "@/features/auth/AuthGate";
import { BackupStatusBanner } from "@/features/backup/BackupStatusBanner";
import { EntitySwitcher } from "@/features/entities/EntitySwitcher";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
});

/**
 * サインインなしで開く画面（AuthGate の例外）。ペアリングの URL を開いたスマホは、まだパスキーがない。
 * 帳簿のデータは読まない（API はペアリングの手続きだけを呼び、server が検査する）
 */
const PUBLIC_PATHS: readonly string[] = ["/pair"];

function RootLayout() {
  return (
    <ToastProvider>
      <RootContent />
    </ToastProvider>
  );
}

function RootContent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (PUBLIC_PATHS.includes(pathname)) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Outlet />
      </div>
    );
  }
  // 画面は、解錠しているときだけ描画する（FR-001・003）。帳簿のデータを含まない静的ファイルは常に配信される
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
            <Link to="/settings/remote" className="text-sm underline-offset-4 hover:underline">
              リモート
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
