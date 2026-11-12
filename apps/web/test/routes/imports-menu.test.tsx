import { createRootRoute } from "@tanstack/react-router";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as ImportsRoute } from "@/routes/e/$entityId/imports/index";
import { Route as EntityHomeRoute } from "@/routes/e/$entityId/index";
import { Route as EntityRoute } from "@/routes/e/$entityId/route";
import { mockApi, ok } from "../mock-api";
import { renderTree } from "../render-route";

const entity = {
  id: "e1",
  name: "個人事業A",
  kind: "individual",
  createdAt: "2026-01-01T00:00:00.000Z",
  demo: false,
} as const;

beforeEach(() => {
  mockApi({
    "GET /api/entities": () => ok({ entities: [entity] }),
    "GET /api/entities/e1/imports": () => ok({ batches: [] }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 事業体のレイアウトの下に、ホームと取込の画面を置いて描画する */
function renderEntity(url: string) {
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
  return renderTree(rootRoute, url);
}

describe("事業体のメニューの「会計期間と移行」（T017、011/T005）", () => {
  it("「事業体の設定」の 2 段目の「会計期間と移行」が、取込の画面で強調される（freee の取込はその画面から）", async () => {
    renderEntity("/e/e1/imports");
    const nav = await screen.findByRole("navigation", { name: "事業体のメニュー" });
    expect(await screen.findByRole("heading", { level: 1, name: "取込" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "新しい取込" })).toHaveAttribute(
      "href",
      "/e/e1/imports/new",
    );
    expect(within(nav).getByRole("link", { name: "事業体の設定" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const sub = screen.getByRole("navigation", { name: "事業体のサブメニュー" });
    const link = within(sub).getByRole("link", { name: "会計期間と移行" });
    expect(link).toHaveAttribute("href", "/e/e1/periods");
    expect(link).toHaveAttribute("aria-current", "page");
  });
});
