import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";

/**
 * 組み立て済みのルートの木（`rootRoute.addChildren(...)` の後）で url を開き、描画する。
 * ルートの組み立ては呼び出し側が行う（ヘッダーを持つルート、事業体のレイアウトの下の空の子など、テストごとに違う）
 */
export function renderTree(rootRoute: AnyRoute, url: string) {
  // jsdom は scrollTo を実装していない（ルーターが画面の切り替えで呼ぶ）
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createRouter({
    routeTree: rootRoute,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient, router };
}

/**
 * 画面のルート 1 つだけを持つルーターで url を開き、描画する。
 * 他の画面（routeTree 全体）を読み込まないよう、ファイルルートを空のルートの子にする
 */
export function renderRoute(route: AnyRoute, { path, url }: { path: string; url: string }) {
  const rootRoute = createRootRoute();
  // routeTree.gen.ts と同じく、ファイルルートに id・path・親を後から与える（型は生成コードと同様に緩める）
  const options = { id: path, path, getParentRoute: () => rootRoute };
  rootRoute.addChildren([route.update(options as Parameters<AnyRoute["update"]>[0])]);
  return renderTree(rootRoute, url);
}
