import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "@/components/layout/AppHeader";
import { isMobileRoute, MOBILE_ROUTES } from "@/components/layout/MobileNav";
import { Route as EntityRoute } from "@/routes/e/$entityId/route";
import { mockApi, ok } from "../mock-api";

const entity = {
  id: "e1",
  name: "個人事業A",
  kind: "individual",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

const MOBILE_QUERY = "(max-width: 767px)";

/** jsdom は matchMedia を持たない。スマホの幅（max-width: 767px）に当たるかどうかを固定した偽物を入れる */
function stubMatchMedia(mobile: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: query === MOBILE_QUERY ? mobile : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }) satisfies MediaQueryList,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockApi({ "GET /api/entities": () => ok({ entities: [entity] }) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** ヘッダー（ルートの上）と事業体のレイアウト・設定・トップの空の画面を描画する */
function renderAt(url: string) {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AppHeader />
        <Outlet />
      </>
    ),
  });
  const entityRoute = EntityRoute.update({
    id: "/e/$entityId",
    path: "/e/$entityId",
    getParentRoute: () => rootRoute,
  } as never);
  const anyChild = createRoute({
    getParentRoute: () => entityRoute,
    path: "$",
    component: () => null,
  });
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$",
    component: () => null,
  });
  const top = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  rootRoute.addChildren([entityRoute.addChildren([anyChild]), settings, top]);
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

// name に文字列を渡すと完全一致（Testing Library の既定）
const menuButton = () => screen.findByRole("button", { name: "メニュー" });
const note = () => screen.queryByRole("note");

describe("MOBILE_ROUTES / isMobileRoute（contracts/ui-shell.md §4）", () => {
  it("スマホの対象のパスだけが当たる", () => {
    expect(MOBILE_ROUTES.length).toBeGreaterThan(0);
    const inside = [
      "/",
      "/e/e1",
      "/e/e1/",
      "/e/e1/receipts",
      "/e/e1/receipts/new",
      "/e/e1/receipts/r1",
      "/e/e1/journals",
      "/e/e1/journals/j1",
      "/e/e1/reports",
      "/e/e1/reports/profit-and-loss",
      "/e/e1/reports/general-ledger",
      "/settings/security",
      "/settings/backup",
    ];
    for (const path of inside) expect(isMobileRoute(path), path).toBe(true);
    const outside = [
      "/e/e1/journals/new",
      "/e/e1/invoices",
      "/e/e1/invoices/i1",
      "/e/e1/statements",
      "/e/e1/statements/import",
      "/e/e1/blue-return",
      "/e/e1/accounts",
      "/e/e1/periods",
      "/e/e1/imports",
      "/e/e1/receipts/r1/extra",
      "/pair",
    ];
    for (const path of outside) expect(isMobileRoute(path), path).toBe(false);
  });
});

describe("PC の幅（既定）", () => {
  it("ヘッダーに設定とサインアウトが並び、メニューのボタンも PC の推奨も出ない", async () => {
    renderAt("/e/e1/invoices");
    expect(await screen.findByRole("link", { name: "設定" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "施錠してサインアウト" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "メニュー" })).toBeNull();
    expect(note()).toBeNull();
    expect(screen.getByRole("navigation", { name: "事業体のメニュー" })).toBeInTheDocument();
  });

  it("matchMedia が PC の幅を返しても同じ", async () => {
    stubMatchMedia(false);
    renderAt("/e/e1/invoices");
    expect(await screen.findByRole("link", { name: "設定" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "メニュー" })).toBeNull();
    expect(note()).toBeNull();
  });
});

describe("スマホの幅のヘッダーとメニュー（FR-059）", () => {
  beforeEach(() => stubMatchMedia(true));

  it("ヘッダーはロゴ・事業体の名前・メニューのボタンだけで、設定とサインアウトは出ない", async () => {
    renderAt("/e/e1/journals");
    const button = await menuButton();
    expect(button).toHaveAttribute("aria-expanded", "false");
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("link", { name: "Trebuchet" })).toBeVisible();
    expect(await within(header).findByRole("link", { name: "個人事業A" })).toBeVisible();
    expect(within(header).queryByRole("link", { name: "設定" })).toBeNull();
    expect(within(header).queryByRole("button", { name: "施錠してサインアウト" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("メニューを開かなくても、開いている事業体を「最後に開いた事業体」として覚える", async () => {
    renderAt("/e/e1/journals");
    await menuButton();
    await waitFor(() => expect(localStorage.getItem("trebuchet:lastEntityId")).toBe("e1"));
  });

  it("押すと Sheet が開き、対象の画面と設定・施錠してサインアウトだけが並ぶ", async () => {
    const user = userEvent.setup();
    renderAt("/e/e1/journals");
    const button = await menuButton();
    await user.click(button);
    const sheet = await screen.findByRole("dialog", { name: "メニュー" });
    expect(button).toHaveAttribute("aria-expanded", "true");

    const links = within(sheet)
      .getAllByRole("link")
      .map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["ホーム", "/e/e1"],
      ["仕訳の一覧", "/e/e1/journals"],
      ["証憑を追加", "/e/e1/receipts/new"],
      ["証憑の一覧", "/e/e1/receipts"],
      ["帳票", "/e/e1/reports/profit-and-loss"],
      ["設定", "/settings/security"],
    ]);
    expect(within(sheet).getByRole("button", { name: "施錠してサインアウト" })).toBeVisible();
    for (const hidden of ["請求の流れ", "明細", "取り込む", "決算書", "勘定科目", "入力する"]) {
      expect(within(sheet).queryByRole("link", { name: hidden })).toBeNull();
    }
  });

  it("項目を押すとその画面へ移り、Sheet が閉じる", async () => {
    const user = userEvent.setup();
    const { router } = renderAt("/e/e1/journals");
    await user.click(await menuButton());
    const sheet = await screen.findByRole("dialog", { name: "メニュー" });
    await user.click(within(sheet).getByRole("link", { name: "設定" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/security"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await menuButton()).toHaveAttribute("aria-expanded", "false");
  });

  it("Sheet の「施錠してサインアウト」は確認のダイアログを開く", async () => {
    const user = userEvent.setup();
    renderAt("/e/e1/journals");
    await user.click(await menuButton());
    const sheet = await screen.findByRole("dialog", { name: "メニュー" });
    await user.click(within(sheet).getByRole("button", { name: "施錠してサインアウト" }));
    expect(await screen.findByRole("heading", { name: "施錠してサインアウト" })).toBeVisible();
  });

  it("メニューの先頭に事業体の切替があり、選ぶと別の事業体のホームへ移って Sheet が閉じる", async () => {
    mockApi({
      "GET /api/entities": () =>
        ok({ entities: [entity, { ...entity, id: "e2", name: "法人B", kind: "corporation" }] }),
    });
    const user = userEvent.setup();
    const { router } = renderAt("/e/e1/journals");
    await user.click(await menuButton());
    const sheet = await screen.findByRole("dialog", { name: "メニュー" });
    const select = await within(sheet).findByLabelText("事業体");
    expect(select).toHaveValue("e1");
    // 先頭: 切替は、画面の一覧の nav より前にある
    const nav = within(sheet).getByRole("navigation", { name: "スマホのメニュー" });
    expect(select.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // PC 側の切替は描画されず、id は 1 つだけ
    expect(document.querySelectorAll("#entity-switcher")).toHaveLength(1);

    await user.selectOptions(select, "e2");
    await waitFor(() => expect(router.state.location.pathname).toBe("/e/e2"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("事業体の外（設定）でも、設定と施錠してサインアウトに届く", async () => {
    const user = userEvent.setup();
    renderAt("/settings/backup");
    await user.click(await menuButton());
    const sheet = await screen.findByRole("dialog", { name: "メニュー" });
    expect(within(sheet).getByRole("link", { name: "設定" })).toBeVisible();
    expect(within(sheet).getByRole("button", { name: "施錠してサインアウト" })).toBeVisible();
  });
});

describe("対象の外の PC の推奨（FR-059）", () => {
  beforeEach(() => stubMatchMedia(true));

  it.each([
    "/e/e1/invoices",
    "/e/e1/statements",
    "/e/e1/blue-return/2026",
    "/e/e1/accounts",
    "/e/e1/journals/new",
  ])("スマホの幅の %s には「PC での操作を推奨」を出す", async (url) => {
    renderAt(url);
    const found = await screen.findByRole("note");
    expect(found).toHaveTextContent("PC での操作を推奨");
    // 禁止はしない: 事業体のメニューで他の画面へ移れる
    expect(screen.getByRole("navigation", { name: "事業体のメニュー" })).toBeInTheDocument();
  });

  it.each([
    "/e/e1",
    "/e/e1/receipts",
    "/e/e1/receipts/new",
    "/e/e1/receipts/r1",
    "/e/e1/journals",
    "/e/e1/journals/j1",
    "/e/e1/reports/trial-balance",
  ])("スマホの幅の対象の %s には出さず、2 段のメニューも出さない", async (url) => {
    renderAt(url);
    await menuButton();
    await screen.findByRole("link", { name: "個人事業A" });
    expect(note()).toBeNull();
    expect(screen.queryByRole("navigation", { name: "事業体のメニュー" })).toBeNull();
  });

  it("PC の幅では、対象の外でも出さない", async () => {
    stubMatchMedia(false);
    renderAt("/e/e1/invoices");
    await screen.findByRole("link", { name: "設定" });
    expect(note()).toBeNull();
  });
});
