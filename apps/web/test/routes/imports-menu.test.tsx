import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as ImportsRoute } from "@/routes/e/$entityId/imports/index";
import { Route as EntityHomeRoute } from "@/routes/e/$entityId/index";
import { Route as EntityRoute } from "@/routes/e/$entityId/route";
import { mockApi, ok } from "../mock-api";

const entity = {
  id: "e1",
  name: "個人事業A",
  kind: "individual",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

beforeEach(() => {
  mockApi({ "GET /api/entities": () => ok({ entities: [entity] }) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 事業体のレイアウトの下に、ホームと取込の画面を置いて描画する */
function renderEntity(url: string) {
  // jsdom は scrollTo を実装していない（ルーターが画面の切り替えで呼ぶ）
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute();
  // routeTree.gen.ts と同じく、ファイルルートに id・path・親を後から与える
  const entityRoute = EntityRoute.update({
    id: "/e/$entityId",
    path: "/e/$entityId",
    getParentRoute: () => rootRoute,
  } as never);
  rootRoute.addChildren([
    entityRoute.addChildren([
      EntityHomeRoute.update({ id: "/", path: "/", getParentRoute: () => entityRoute } as never),
      ImportsRoute.update({
        id: "/imports/",
        path: "/imports/",
        getParentRoute: () => entityRoute,
      } as never),
    ]),
  ]);
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

describe("事業体のメニューの「取込」（T017）", () => {
  it("メニューに「取込」があり、押すと取込の画面に移動する", async () => {
    const { router } = renderEntity("/e/e1");
    const nav = await screen.findByRole("navigation", { name: "事業体のメニュー" });
    const link = within(nav).getByRole("link", { name: "取込" });
    expect(link).toHaveAttribute("href", "/e/e1/imports");

    await userEvent.click(link);

    await waitFor(() => expect(router.state.location.pathname).toBe("/e/e1/imports"));
    expect(await screen.findByRole("heading", { level: 1, name: "取込" })).toBeInTheDocument();
    expect(screen.getByLabelText("仕訳帳のファイル")).toHaveAttribute("type", "file");
    expect(within(nav).getByRole("link", { name: "取込" })).toHaveAttribute("aria-current", "page");
  });
});
