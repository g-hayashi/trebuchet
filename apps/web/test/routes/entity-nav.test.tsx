import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as RootRoute } from "@/routes/__root";
import { Route as EntityRoute } from "@/routes/e/$entityId/route";
import { Route as HomeRoute } from "@/routes/index";
import { Route as ListRoute } from "@/routes/list";
import { type ApiCall, DEFAULT_AUTH_STATUS, mockApi, ok } from "../mock-api";

const entity = {
  id: "e1",
  name: "個人事業A",
  kind: "individual",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockApi({ "GET /api/entities": () => ok({ entities: [entity] }) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 事業体のレイアウトの下に、どのパスにも一致する空の子を置いて描画する（メニューだけを確かめる） */
function renderAt(url: string) {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute();
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
  rootRoute.addChildren([entityRoute.addChildren([anyChild])]);
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

const groupNav = () => screen.findByRole("navigation", { name: "事業体のメニュー" });
const subNav = () => screen.queryByRole("navigation", { name: "事業体のサブメニュー" });
const linkNames = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole("link")
    .map((a) => a.textContent);
const current = (nav: HTMLElement, name: string) =>
  expect(within(nav).getByRole("link", { name })).toHaveAttribute("aria-current", "page");
const notCurrent = (nav: HTMLElement, name: string) =>
  expect(within(nav).getByRole("link", { name })).not.toHaveAttribute("aria-current");

describe("事業体の 2 段のメニュー（contracts/ui-shell.md §2）", () => {
  it("1 段目は 8 つで、グループのリンクは 2 段目の最初の項目へ進む（1 項目のグループは直接のリンク）", async () => {
    renderAt("/e/e1");
    const nav = await groupNav();
    expect(linkNames(nav)).toEqual([
      "ホーム",
      "仕訳",
      "明細",
      "証憑",
      "請求",
      "帳票",
      "決算・申告",
      "事業体の設定",
    ]);
    const href = (name: string) => within(nav).getByRole("link", { name }).getAttribute("href");
    expect(href("ホーム")).toBe("/e/e1");
    expect(href("仕訳")).toBe("/e/e1/journals/new");
    expect(href("明細")).toBe("/e/e1/statements/import");
    expect(href("証憑")).toBe("/e/e1/receipts/new");
    expect(href("請求")).toBe("/e/e1/invoices");
    expect(href("帳票")).toBe("/e/e1/reports/profit-and-loss");
    expect(href("決算・申告")).toBe("/e/e1/blue-return");
    expect(href("事業体の設定")).toBe("/e/e1/settings");
  });

  it("仕訳の画面では「仕訳」が強調され、2 段目に入力する・一覧・定期仕訳が出る", async () => {
    renderAt("/e/e1/journals");
    const nav = await groupNav();
    await waitFor(() => current(nav, "仕訳"));
    notCurrent(nav, "明細");
    // 親のパス（/e/e1）を Link が「今の画面」と見なしても、ホームは強調しない
    notCurrent(nav, "ホーム");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(linkNames(sub)).toEqual(["入力する", "一覧", "定期仕訳"]);
    current(sub, "一覧");
    notCurrent(sub, "入力する");
    expect(within(sub).getByRole("link", { name: "入力する" })).toHaveAttribute(
      "href",
      "/e/e1/journals/new",
    );
  });

  it("仕訳の入力の画面では「入力する」だけが強調され、仕訳の詳細は「一覧」に属し、定期仕訳は「定期仕訳」", async () => {
    const { router } = renderAt("/e/e1/journals/new");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    current(sub, "入力する");
    notCurrent(sub, "一覧");

    router.history.push("/e/e1/journals/j1");
    await waitFor(() =>
      current(screen.getByRole("navigation", { name: "事業体のサブメニュー" }), "一覧"),
    );

    router.history.push("/e/e1/recurring");
    await waitFor(() =>
      current(screen.getByRole("navigation", { name: "事業体のサブメニュー" }), "定期仕訳"),
    );
    current(await groupNav(), "仕訳");
  });

  it("明細の画面では「明細」が強調され、2 段目に取り込む・一覧と確認・ルール・明細の設定が出る", async () => {
    renderAt("/e/e1/statements/rules");
    const nav = await groupNav();
    await waitFor(() => current(nav, "明細"));
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(linkNames(sub)).toEqual(["取り込む", "一覧と確認", "ルール", "明細の設定"]);
    current(sub, "ルール");
    expect(within(sub).getByRole("link", { name: "一覧と確認" })).toHaveAttribute(
      "href",
      "/e/e1/statements",
    );
    expect(within(sub).getByRole("link", { name: "明細の設定" })).toHaveAttribute(
      "href",
      "/e/e1/statements/settings",
    );
  });

  it("証憑の画面（詳細も）では「証憑」が強調され、2 段目の「一覧」が強調される", async () => {
    renderAt("/e/e1/receipts/00000000-0000-4000-8000-0000000000a1");
    const nav = await groupNav();
    await waitFor(() => current(nav, "証憑"));
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(linkNames(sub)).toEqual(["追加する", "一覧"]);
    current(sub, "一覧");
    expect(within(sub).getByRole("link", { name: "追加する" })).toHaveAttribute(
      "href",
      "/e/e1/receipts/new",
    );
    expect(within(sub).getByRole("link", { name: "一覧" })).toHaveAttribute(
      "href",
      "/e/e1/receipts",
    );
  });

  it("工数の画面（invoices の下にない）でも「請求」が強調され、2 段目に請求の流れ・工数・請求の設定が出る", async () => {
    renderAt("/e/e1/work-hours");
    const nav = await groupNav();
    await waitFor(() => current(nav, "請求"));
    notCurrent(nav, "仕訳");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(linkNames(sub)).toEqual(["請求の流れ", "工数", "請求の設定"]);
    current(sub, "工数");
  });

  it("請求書の画面では「請求の流れ」だけが強調される", async () => {
    renderAt("/e/e1/invoices/new");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    current(sub, "請求の流れ");
    notCurrent(sub, "請求の設定");
  });

  it("ホーム・帳票では 2 段目が出ない。帳票は損益計算書へ進み、帳票のどの画面でも強調される", async () => {
    const { router } = renderAt("/e/e1");
    const nav = await groupNav();
    current(nav, "ホーム");
    expect(subNav()).toBeNull();

    await userEvent.click(within(nav).getByRole("link", { name: "帳票" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/e/e1/reports/profit-and-loss"),
    );
    await waitFor(() => current(nav, "帳票"));
    expect(subNav()).toBeNull();

    router.history.push("/e/e1/reports/trial-balance");
    await waitFor(() => current(nav, "帳票"));
    expect(subNav()).toBeNull();
  });

  it("決算・申告の 2 段目は決算書・固定資産台帳・開業費", async () => {
    const { router } = renderAt("/e/e1/blue-return/2025");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(linkNames(sub)).toEqual(["決算書", "固定資産台帳", "開業費"]);
    current(sub, "決算書");
    expect(within(sub).getByRole("link", { name: "開業費" })).toHaveAttribute(
      "href",
      "/e/e1/deferred-assets",
    );

    router.history.push("/e/e1/deferred-assets");
    await waitFor(() =>
      current(screen.getByRole("navigation", { name: "事業体のサブメニュー" }), "開業費"),
    );
    current(await groupNav(), "決算・申告");
  });

  it("事業体の設定の 2 段目は基本・勘定科目・取引先・タグ・消費税・会計期間と移行", async () => {
    renderAt("/e/e1/settings");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(linkNames(sub)).toEqual([
      "基本",
      "勘定科目",
      "取引先",
      "タグ",
      "消費税",
      "会計期間と移行",
    ]);
    current(sub, "基本");
    expect(within(sub).getByRole("link", { name: "会計期間と移行" })).toHaveAttribute(
      "href",
      "/e/e1/periods",
    );
  });

  it("freee の取込の画面は「会計期間と移行」に属する", async () => {
    renderAt("/e/e1/imports/new");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    current(sub, "会計期間と移行");
    current(await groupNav(), "事業体の設定");
  });

  it("グループのリンクを押すと、そのグループの最初の項目へ移り、2 段目が切り替わる", async () => {
    const { router } = renderAt("/e/e1/journals");
    const nav = await groupNav();
    await userEvent.click(within(nav).getByRole("link", { name: "決算・申告" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/e/e1/blue-return"));
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    await waitFor(() => expect(linkNames(sub)).toEqual(["決算書", "固定資産台帳", "開業費"]));
  });
});

// --- ヘッダーとトップの移動（T005・T006。contracts/ui-shell.md §1、research R1・R4） ---

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

const LAST_ENTITY_KEY = "trebuchet:lastEntityId";

/** 実際のルート（ヘッダーを持つルート・トップ画面・事業体のレイアウト）でアプリを描画する */
function renderApp(url: string, handlers: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi({
    "GET /api/entities": () => ok({ entities: [entityA, entityB] }),
    ...handlers,
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // routeTree.gen.ts と同じく、ファイルルートに id・path・親を後から与える
  const routeTree = RootRoute.addChildren([
    HomeRoute.update({ id: "/", path: "/", getParentRoute: () => RootRoute } as never),
    ListRoute.update({ id: "/list", path: "/list", getParentRoute: () => RootRoute } as never),
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
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, calls };
}

const path = (router: ReturnType<typeof renderApp>["router"]) => router.state.location.pathname;
const header = () => screen.findByRole("banner");
const callsTo = (calls: ApiCall[], method: string, p: string) =>
  calls.filter((c) => c.method === method && c.path === p);

describe("ヘッダー（contracts/ui-shell.md §1）", () => {
  it("ロゴ・今の事業体の名前のリンク・事業体の切替があり、右は「設定」と「施錠してサインアウト」だけ", async () => {
    renderApp(`/e/${entityA.id}`);
    const banner = await header();
    expect(await within(banner).findByRole("link", { name: "個人事業A" })).toHaveAttribute(
      "href",
      `/e/${entityA.id}`,
    );
    expect(within(banner).getByRole("combobox", { name: "事業体" })).toHaveAttribute(
      "id",
      "entity-switcher",
    );
    expect(within(banner).getByRole("link", { name: "設定" })).toHaveAttribute(
      "href",
      "/settings/security",
    );
    expect(
      within(banner).getByRole("button", { name: "施錠してサインアウト" }),
    ).toBeInTheDocument();
    for (const gone of ["バックアップ", "AI の設定", "リモート"]) {
      expect(within(banner).queryByRole("link", { name: gone })).toBeNull();
    }
  });

  it("事業体の切替の「一覧・作成」で /list へ移る", async () => {
    const { router } = renderApp(`/e/${entityA.id}`);
    const banner = await header();
    const switcher = await within(banner).findByRole("combobox", { name: "事業体" });
    await userEvent.selectOptions(
      switcher,
      within(switcher).getByRole("option", { name: "一覧・作成" }),
    );
    await waitFor(() => expect(path(router)).toBe("/list"));
    expect(router.state.location.search).toEqual({});
  });

  it("事業体が 1 件のときも切替が出て、「一覧・作成」で /list の一覧と作成へ移る", async () => {
    const { router } = renderApp(`/e/${entityA.id}`, {
      "GET /api/entities": () => ok({ entities: [entityA] }),
    });
    const banner = await header();
    const switcher = await within(banner).findByRole("combobox", { name: "事業体" });
    await userEvent.selectOptions(
      switcher,
      within(switcher).getByRole("option", { name: "一覧・作成" }),
    );
    expect(await screen.findByRole("button", { name: "作成する" })).toBeInTheDocument();
    expect(path(router)).toBe("/list");
    expect(screen.getByRole("link", { name: "証憑を追加" })).toBeInTheDocument();
  });

  it("「施錠してサインアウト」は確認のダイアログを出し、「やめる」では何も送らない", async () => {
    const { calls } = renderApp(`/e/${entityA.id}`, {
      "POST /api/auth/sign-out": () => ({ status: 204, body: undefined }),
    });
    const banner = await header();
    await userEvent.click(within(banner).getByRole("button", { name: "施錠してサインアウト" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "施錠してサインアウト" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "すべての端末でサインアウトし、帳簿を閉じます。もう一度開くにはパスキーか回復キーが要ります",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "やめる" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(callsTo(calls, "POST", "/api/auth/sign-out")).toHaveLength(0);
  });

  it("ダイアログの「施錠してサインアウト」で POST /api/auth/sign-out を送る", async () => {
    const { calls } = renderApp(`/e/${entityA.id}`, {
      "POST /api/auth/sign-out": () => ({ status: 204, body: undefined }),
    });
    const banner = await header();
    await userEvent.click(within(banner).getByRole("button", { name: "施錠してサインアウト" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "施錠してサインアウト" }));
    await waitFor(() => expect(callsTo(calls, "POST", "/api/auth/sign-out")).toHaveLength(1));
  });

  it("施錠中は、右の 2 つとメニューを出さない（解錠の画面だけ）", async () => {
    renderApp(`/e/${entityA.id}`, {
      "GET /api/auth/status": () => ok({ ...DEFAULT_AUTH_STATUS, signedIn: false }),
    });
    await screen.findByRole("heading", { name: "Trebuchet" });
    expect(screen.queryByRole("link", { name: "設定" })).toBeNull();
    expect(screen.queryByRole("button", { name: "施錠してサインアウト" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "事業体のメニュー" })).toBeNull();
  });

  it("ロゴは最後に開いた事業体のホームへ（なければ `/`）。事業体の名前も同じ", async () => {
    // 最後に開いた事業体がない: ロゴは `/`
    const first = renderApp("/");
    const banner = await header();
    expect(within(banner).getByRole("link", { name: "Trebuchet" })).toHaveAttribute("href", "/");
    expect(path(first.router)).toBe("/");
  });

  it("最後に開いた事業体があれば、トップでもロゴはそのホームへ。もう一覧にない事業体は `/`", async () => {
    localStorage.setItem(LAST_ENTITY_KEY, entityB.id);
    renderApp("/");
    const banner = await header();
    await waitFor(() =>
      expect(within(banner).getByRole("link", { name: "Trebuchet" })).toHaveAttribute(
        "href",
        `/e/${entityB.id}`,
      ),
    );
  });

  it("最後に開いた事業体の ID が一覧になければ、ロゴは `/` のまま", async () => {
    localStorage.setItem(LAST_ENTITY_KEY, "0190a000-0000-7000-8000-00000000dead");
    renderApp("/");
    const banner = await header();
    await screen.findByRole("link", { name: "個人事業A" });
    expect(within(banner).getByRole("link", { name: "Trebuchet" })).toHaveAttribute("href", "/");
  });
});

describe("トップ（/）の移動（FR-010、R4）", () => {
  it("事業体が 1 件なら、初めてでもそのホームを開く", async () => {
    const { router } = renderApp("/", { "GET /api/entities": () => ok({ entities: [entityA] }) });
    await waitFor(() => expect(path(router)).toBe(`/e/${entityA.id}`));
  });

  it("事業体が 1 件なら、前回の記憶にかかわらずその 1 件のホームを開く", async () => {
    localStorage.setItem(LAST_ENTITY_KEY, "0190a000-0000-7000-8000-00000000dead");
    const { router } = renderApp("/", { "GET /api/entities": () => ok({ entities: [entityA] }) });
    await waitFor(() => expect(path(router)).toBe(`/e/${entityA.id}`));
  });

  it("事業体が 1 件でも `?list=1`（切替の「一覧・作成」）なら、移動せず一覧と作成のフォームを出す", async () => {
    const { router } = renderApp("/?list=1", {
      "GET /api/entities": () => ok({ entities: [entityA] }),
    });
    expect(await screen.findByRole("link", { name: "個人事業A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "作成する" })).toBeInTheDocument();
    expect(path(router)).toBe("/");
  });

  it("事業体が 2 件以上なら、移動せず一覧を出し、最後に開いたものを上に目立たせる", async () => {
    localStorage.setItem(LAST_ENTITY_KEY, entityB.id);
    const { router } = renderApp("/");
    const links = await screen.findAllByRole("link", { name: /個人事業A|株式会社B/ });
    expect(links.map((l) => l.textContent)).toEqual(["株式会社B", "個人事業A"]);
    expect(path(router)).toBe("/");
    const first = screen.getByRole("row", { name: /株式会社B/ });
    expect(within(first).getByText("最後に開いた")).toBeInTheDocument();
    expect(screen.getAllByText("最後に開いた")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "作成する" })).toBeInTheDocument();
  });

  it("最後に開いたものがなければ、一覧は今の並びのまま（印は出さない）", async () => {
    renderApp("/");
    const links = await screen.findAllByRole("link", { name: /個人事業A|株式会社B/ });
    expect(links.map((l) => l.textContent)).toEqual(["個人事業A", "株式会社B"]);
    expect(screen.queryByText("最後に開いた")).toBeNull();
  });

  it("事業体が 0 件なら、移動せず作成の案内とフォームを出す", async () => {
    const { router } = renderApp("/", { "GET /api/entities": () => ok({ entities: [] }) });
    expect(await screen.findByText(/事業体がまだありません/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "作成する" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "事業体" })).toBeNull();
    expect(path(router)).toBe("/");
  });
});
