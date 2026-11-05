import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, useRouterState } from "@tanstack/react-router";
import { AppHeader } from "@/components/layout/AppHeader";
import { ToastProvider } from "@/components/ui/toast";
import { AuthGate } from "@/features/auth/AuthGate";
import { BackupStatusBanner } from "@/features/backup/BackupStatusBanner";
import { ManualHelp } from "@/features/manual/ManualHelp";

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
      <ManualHelp />
    </ToastProvider>
  );
}

function RootContent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (PUBLIC_PATHS.includes(pathname)) {
    return (
      <div className="min-h-screen bg-background pb-20 text-foreground print:pb-0">
        <Outlet />
      </div>
    );
  }
  // 画面は、解錠しているときだけ描画する（FR-001・003）。帳簿のデータを含まない静的ファイルは常に配信される
  return (
    <div className="min-h-screen bg-background pb-20 text-foreground print:pb-0">
      <AuthGate>
        <BackupStatusBanner />
        <AppHeader />
        <Outlet />
      </AuthGate>
    </div>
  );
}
