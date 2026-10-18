import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-6 px-4">
          <Link to="/" className="font-semibold">
            Trebuchet
          </Link>
          <div id="header-slot" className="flex flex-1 items-center gap-4" />
        </div>
      </header>
      <Outlet />
    </div>
  );
}
