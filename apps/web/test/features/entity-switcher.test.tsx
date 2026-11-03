import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountKeys } from "@/features/accounts/api";
import { entityKeys } from "@/features/entities/api";
import { journalKeys } from "@/features/journals/api";
import { reportKeys } from "@/features/reports/api";
import { Route as RootRoute } from "@/routes/__root";
import { Route as EntityRoute } from "@/routes/e/$entityId/route";
import { Route as HomeRoute } from "@/routes/index";
import { type ApiCall, mockApi, ok } from "../mock-api";

const LAST_ENTITY_KEY = "trebuchet:lastEntityId";

const entityA = {
  id: "0190a000-0000-7000-8000-00000000000a",
  name: "個人事業A",
  kind: "individual",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;
const entityB = {
  id: "0190a000-0000-7000-8000-00000000000b",
  name: "株式会社B",
  kind: "corporation",
  createdAt: "2026-02-01T00:00:00.000Z",
} as const;

let calls: ApiCall[];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  calls = mockApi({
    "GET /api/entities": () => ok({ entities: [entityA, entityB] }),
    "POST /api/entities": (call) =>
      ok({ entity: { ...entityB, ...(call.body as object), id: entityB.id } }, 201),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 実際のルート（ヘッダーを持つルート・トップ画面・事業体のレイアウト）でアプリを描画する */
function renderApp(url: string) {
  // jsdom は scrollTo を実装していない（ルーターが画面の切り替えで呼ぶ）
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // routeTree.gen.ts と同じく、ファイルルートに id・path・親を後から与える
  const routeTree = RootRoute.addChildren([
    HomeRoute.update({ id: "/", path: "/", getParentRoute: () => RootRoute } as never),
    EntityRoute.update({
      id: "/e/$entityId",
      path: "/e/$entityId",
      getParentRoute: () => RootRoute,
    } as never),
  ]);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, queryClient, router };
}

const switcher = () => screen.findByRole("combobox", { name: "事業体" });
const entityNav = () => screen.findByRole("navigation", { name: "事業体のメニュー" });
const entitiesFetches = () =>
  calls.filter((c) => c.method === "GET" && c.path === "/api/entities").length;
const path = (router: ReturnType<typeof renderApp>["router"]) => router.state.location.pathname;

describe("EntitySwitcher（US6, T113）", () => {
  it("ヘッダーに事業体の一覧があり、選ぶとその事業体の画面に移動する", async () => {
    const { router } = renderApp(`/e/${entityA.id}`);
    const select = await switcher();
    await waitFor(() => expect(select).toHaveValue(entityA.id));
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["個人事業A", "株式会社B"]);

    await userEvent.selectOptions(select, "株式会社B");

    await waitFor(() => expect(path(router)).toBe(`/e/${entityB.id}`));
    expect(await switcher()).toHaveValue(entityB.id);
    expect(
      within(await screen.findByRole("banner")).getByRole("link", { name: "株式会社B" }),
    ).toHaveAttribute("href", `/e/${entityB.id}`);
  });

  it("トップ画面では未選択の状態で表示し、選ぶと移動する", async () => {
    const { router } = renderApp("/");
    const select = await switcher();
    expect(select).toHaveValue("");
    await userEvent.selectOptions(select, "個人事業A");
    await waitFor(() => expect(path(router)).toBe(`/e/${entityA.id}`));
  });

  it("最後に選んだ事業体を localStorage に保存する（トップ画面の一覧から開いた場合も）", async () => {
    renderApp("/");
    await userEvent.click(await screen.findByRole("link", { name: "株式会社B" }));
    await entityNav();
    await waitFor(() => expect(localStorage.getItem(LAST_ENTITY_KEY)).toBe(entityB.id));

    await userEvent.selectOptions(await switcher(), "個人事業A");
    await waitFor(() => expect(localStorage.getItem(LAST_ENTITY_KEY)).toBe(entityA.id));
  });

  it("切り替えると、前の事業体のクエリのキャッシュを破棄する（事業体の一覧は残す）", async () => {
    const { queryClient } = renderApp(`/e/${entityA.id}`);
    const select = await switcher();
    await waitFor(() => expect(select).toHaveValue(entityA.id));
    queryClient.setQueryData(accountKeys.list(entityA.id), [{ id: "cash-a", name: "現金" }]);
    queryClient.setQueryData(reportKeys.all(entityA.id), { kind: "trial-balance" });
    queryClient.setQueryData(journalKeys.detail(entityA.id, "j1"), { id: "j1" });

    await userEvent.selectOptions(select, "株式会社B");

    await waitFor(() => {
      expect(queryClient.getQueryData(accountKeys.list(entityA.id))).toBeUndefined();
      expect(queryClient.getQueryData(reportKeys.all(entityA.id))).toBeUndefined();
      expect(queryClient.getQueryData(journalKeys.detail(entityA.id, "j1"))).toBeUndefined();
    });
    expect(queryClient.getQueryData(entityKeys.all)).toHaveLength(2);
    expect(entitiesFetches()).toBe(1);
  });

  it("事業体がなければ表示しない", async () => {
    mockApi({ "GET /api/entities": () => ok({ entities: [] }) });
    renderApp("/");
    expect(await screen.findByText(/事業体がまだありません/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "事業体" })).not.toBeInTheDocument();
  });
});

describe("トップ画面の復元（011 FR-010。件数による分岐は entity-nav.test.tsx）", () => {
  it("前回の事業体が一覧にもうなければ、移動せずにトップ画面を表示する", async () => {
    localStorage.setItem(LAST_ENTITY_KEY, "0190a000-0000-7000-8000-00000000dead");
    const { router } = renderApp("/");
    expect(await screen.findByRole("link", { name: "個人事業A" })).toBeInTheDocument();
    expect(path(router)).toBe("/");
  });
});

describe("事業体の作成の種別（US6-2）", () => {
  it("種別「法人」を選んで作成できる", async () => {
    const { router } = renderApp("/");
    await userEvent.type(await screen.findByLabelText("名称"), "株式会社B");
    await userEvent.selectOptions(screen.getByLabelText("種別"), "corporation");
    await userEvent.click(screen.getByRole("button", { name: "作成する" }));

    await waitFor(() => expect(path(router)).toBe(`/e/${entityB.id}`));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/entities");
    expect(post?.body).toMatchObject({ name: "株式会社B", kind: "corporation" });
  });
});
