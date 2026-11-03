import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/receipts/new";
import { mockApi } from "../mock-api";
import { renderRoute } from "../render-route";

// 証憑の追加の画面（011/T005。メニューの「証憑 → 追加する」の行き先）。今は追加のフォームを描くだけ。作り直しは US4（T0xx）

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("証憑の追加の画面", () => {
  it("見出し「証憑を追加」と、追加のフォームを出す", async () => {
    mockApi({});
    renderRoute(Route, { path: "/e/$entityId/receipts/new", url: "/e/e1/receipts/new" });

    expect(
      await screen.findByRole("heading", { level: 1, name: "証憑を追加" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("form", { name: "証憑を追加" })).toBeInTheDocument();
  });
});
