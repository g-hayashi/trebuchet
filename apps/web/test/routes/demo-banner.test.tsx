import { createRootRoute, createRoute } from "@tanstack/react-router";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as EntityRoute } from "@/routes/e/$entityId/route";
import { mockApi, ok } from "../mock-api";
import { renderTree } from "../render-route";

// 014 T007: 事業体の画面の骨組みの上部に、デモの事業体だけ帯を出す（contracts/http-api.md の画面、R8）

const entity = (id: string, demo: boolean) => ({
  id,
  name: demo ? "デモ事業" : "個人事業A",
  kind: "individual",
  createdAt: "2026-11-08T03:00:00.000Z",
  demo,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 事業体のレイアウトの下に、どのパスにも一致する空の子と、一覧の画面（`/list`）を置いて描画する */
function renderAt(url: string) {
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
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: "/list",
    component: () => <p>事業体の一覧の画面</p>,
  });
  rootRoute.addChildren([entityRoute.addChildren([anyChild]), list]);
  return renderTree(rootRoute, url);
}

const BANNER = "デモ用の架空のデータです";
const DELETE_LINK = "試し終わったら削除";

describe("デモの帯（FR-008・009）", () => {
  it.each([
    ["ホーム", "/e/d1"],
    ["仕訳", "/e/d1/journals"],
    ["決算書", "/e/d1/blue-return"],
  ])("demo の事業体の%sに、帯と「試し終わったら削除」が出る", async (_name, url) => {
    mockApi({ "GET /api/entities": () => ok({ entities: [entity("d1", true)] }) });
    renderAt(url);
    const note = await screen.findByRole("note", { name: "デモ事業の案内" });
    expect(note).toHaveTextContent(BANNER);
    expect(screen.getByRole("link", { name: DELETE_LINK })).toHaveAttribute("href", "/list");
    // アーカイブ（一覧の「非表示にする」）の案内
    expect(note).toHaveTextContent("非表示にする");
  });

  it("通常の事業体では出ない（デモが別にあっても、開いている事業体で決まる）", async () => {
    mockApi({
      "GET /api/entities": () => ok({ entities: [entity("e1", false), entity("d1", true)] }),
    });
    renderAt("/e/e1");
    // 一覧を読み込んだ後（メニューが出てから）に確かめる
    await screen.findByRole("navigation", { name: "事業体のメニュー" });
    await vi.waitFor(() =>
      expect(screen.queryByRole("note", { name: "デモ事業の案内" })).toBeNull(),
    );
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: DELETE_LINK })).not.toBeInTheDocument();
  });

  it("「試し終わったら削除」を押すと、一覧へ移る", async () => {
    mockApi({ "GET /api/entities": () => ok({ entities: [entity("d1", true)] }) });
    const { router } = renderAt("/e/d1/journals");
    await userEvent.click(await screen.findByRole("link", { name: DELETE_LINK }));
    expect(await screen.findByText("事業体の一覧の画面")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/list");
  });
});
