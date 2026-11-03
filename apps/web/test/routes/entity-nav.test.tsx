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

describe("事業体の 2 段のメニュー", () => {
  it("1 段目は 6 つのグループで、グループのリンクは最初の項目へ進む", async () => {
    renderAt("/e/e1");
    const nav = await groupNav();
    expect(linkNames(nav)).toEqual([
      "ホーム",
      "記帳",
      "請求",
      "帳票",
      "決算・申告",
      "事業体の設定",
    ]);
    const href = (name: string) => within(nav).getByRole("link", { name }).getAttribute("href");
    expect(href("ホーム")).toBe("/e/e1");
    expect(href("記帳")).toBe("/e/e1/journals");
    expect(href("請求")).toBe("/e/e1/invoices");
    expect(href("帳票")).toBe("/e/e1/reports");
    expect(href("決算・申告")).toBe("/e/e1/blue-return");
    expect(href("事業体の設定")).toBe("/e/e1/accounts");
  });

  it("証憑の画面でも「記帳」が強調され、2 段目の「証憑」が強調される", async () => {
    renderAt(`/e/e1/receipts/00000000-0000-4000-8000-0000000000a1`);
    const nav = await groupNav();
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: "記帳" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(within(sub).getByRole("link", { name: "証憑" })).toHaveAttribute("aria-current", "page");
    expect(within(sub).getByRole("link", { name: "証憑" })).toHaveAttribute(
      "href",
      "/e/e1/receipts",
    );
  });

  it("仕訳の画面では「記帳」が強調され、2 段目に仕訳・明細・証憑・定期仕訳だけが出る", async () => {
    renderAt("/e/e1/journals");
    const nav = await groupNav();
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: "記帳" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(within(nav).getByRole("link", { name: "請求" })).not.toHaveAttribute("aria-current");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(linkNames(sub)).toEqual(["仕訳", "明細", "証憑", "定期仕訳"]);
    expect(within(sub).getByRole("link", { name: "仕訳" })).toHaveAttribute("aria-current", "page");
    expect(within(sub).getByRole("link", { name: "明細" })).not.toHaveAttribute("aria-current");
    expect(within(sub).getByRole("link", { name: "明細" })).toHaveAttribute(
      "href",
      "/e/e1/statements",
    );
    expect(within(sub).queryByRole("link", { name: "請求書" })).toBeNull();
  });

  it("工数の画面（invoices の下にない）でも「請求」が強調され、2 段目に請求の項目が出る", async () => {
    renderAt("/e/e1/work-hours");
    const nav = await groupNav();
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: "請求" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(within(nav).getByRole("link", { name: "記帳" })).not.toHaveAttribute("aria-current");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(linkNames(sub)).toEqual(["請求書", "工数", "請求の設定"]);
    expect(within(sub).getByRole("link", { name: "工数" })).toHaveAttribute("aria-current", "page");
  });

  it("請求の設定の画面も「請求」に属し、請求書の画面では請求書だけが強調される", async () => {
    renderAt("/e/e1/invoices/new");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(within(sub).getByRole("link", { name: "請求書" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(sub).getByRole("link", { name: "請求の設定" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("ホーム・帳票では 2 段目が出ない", async () => {
    const { router } = renderAt("/e/e1");
    const nav = await groupNav();
    expect(within(nav).getByRole("link", { name: "ホーム" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(subNav()).toBeNull();

    await userEvent.click(within(nav).getByRole("link", { name: "帳票" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/e/e1/reports"));
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: "帳票" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(subNav()).toBeNull();
  });

  it("申告の控えは今年の年分で開き、「決算・申告」に属する", async () => {
    renderAt("/e/e1/tax-return/2025");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(linkNames(sub)).toEqual(["決算書", "固定資産台帳", "申告の控え"]);
    expect(within(sub).getByRole("link", { name: "申告の控え" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(await groupNav()).getByRole("link", { name: "決算・申告" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("「設定」の 2 段目に「freee から移行」があり、取込の画面へ進む", async () => {
    const { router } = renderAt("/e/e1/accounts");
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    expect(linkNames(sub)).toEqual([
      "勘定科目",
      "取引先",
      "タグ",
      "消費税",
      "会計期間",
      "freee から移行",
    ]);
    const link = within(sub).getByRole("link", { name: "freee から移行" });
    expect(link).toHaveAttribute("href", "/e/e1/imports");
    await userEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/e/e1/imports"));
    await waitFor(() =>
      expect(
        within(screen.getByRole("navigation", { name: "事業体のサブメニュー" })).getByRole("link", {
          name: "freee から移行",
        }),
      ).toHaveAttribute("aria-current", "page"),
    );
  });

  it("グループのリンクを押すと、そのグループの最初の項目へ移り、2 段目が切り替わる", async () => {
    const { router } = renderAt("/e/e1/journals");
    const nav = await groupNav();
    await userEvent.click(within(nav).getByRole("link", { name: "決算・申告" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/e/e1/blue-return"));
    const sub = await screen.findByRole("navigation", { name: "事業体のサブメニュー" });
    await waitFor(() => expect(linkNames(sub)).toEqual(["決算書", "固定資産台帳", "申告の控え"]));
  });
});
