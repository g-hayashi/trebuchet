import { createRootRoute, createRoute } from "@tanstack/react-router";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as SettingsRoute } from "@/routes/settings/route";
import { renderTree } from "../render-route";

afterEach(() => {
  vi.restoreAllMocks();
});

/** 設定のレイアウトの下に、どのパスにも一致する空の子を置いて描画する（メニューだけを確かめる） */
function renderAt(url: string) {
  const rootRoute = createRootRoute();
  const settingsRoute = SettingsRoute.update({
    id: "/settings",
    path: "/settings",
    getParentRoute: () => rootRoute,
  } as never);
  const anyChild = createRoute({
    getParentRoute: () => settingsRoute,
    path: "$",
    component: () => null,
  });
  rootRoute.addChildren([settingsRoute.addChildren([anyChild])]);
  renderTree(rootRoute, url);
}

describe("設定のメニュー（contracts/ui-shell.md §6）", () => {
  it("セキュリティ・バックアップ・AI・リモートへのリンクがあり、今のページに aria-current が付く", async () => {
    renderAt("/settings/ai");
    const nav = await screen.findByRole("navigation", { name: "設定のメニュー" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["セキュリティ", "/settings/security"],
      ["バックアップ", "/settings/backup"],
      ["AI", "/settings/ai"],
      ["リモート", "/settings/remote"],
    ]);
    expect(within(nav).getByRole("link", { name: "AI" })).toHaveAttribute("aria-current", "page");
  });

  it("今の画面だけに aria-current が付く（親のパスに一致して二重にならない）", async () => {
    renderAt("/settings/backup");
    const nav = await screen.findByRole("navigation", { name: "設定のメニュー" });
    const current = within(nav)
      .getAllByRole("link")
      .filter((l) => l.hasAttribute("aria-current"));
    expect(current.map((l) => l.textContent)).toEqual(["バックアップ"]);
  });

  it("4 つのページは同じ最大幅 max-w-4xl の中に並ぶ（FR-053）", async () => {
    renderAt("/settings/security");
    const nav = await screen.findByRole("navigation", { name: "設定のメニュー" });
    expect(nav.parentElement).toHaveClass("max-w-4xl", "mx-auto");
  });
});
