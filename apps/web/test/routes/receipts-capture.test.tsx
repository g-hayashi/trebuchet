import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Route } from "@/routes/e/$entityId/receipts/capture";
import { Route as HomeRoute } from "@/routes/index";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 追加の入口は証憑の一覧の 1 つだけ。旧い「撮影の画面」の URL（ブックマーク・ホーム画面のアプリ）は一覧へ送る

describe("旧い撮影の画面の URL", () => {
  it("/receipts/capture は証憑の一覧へ移る", async () => {
    mockApi({});
    const { router } = renderRoute(Route, {
      path: "/e/$entityId/receipts/capture",
      url: "/e/e1/receipts/capture",
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/e/e1/receipts"));
  });
});

describe("事業体の一覧の入口", () => {
  beforeEach(() => {
    localStorage.clear();
    // 最初の表示の「前回の事業体を開く」を済ませた状態にする
    sessionStorage.setItem("trebuchet:lastEntityRestored", "1");
  });

  it("各事業体に「証憑を追加」があり、証憑の一覧へ進む", async () => {
    mockApi({
      "GET /api/entities": () =>
        ok({
          entities: [
            {
              id: "e1",
              name: "個人事業A",
              kind: "individual",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "e2",
              name: "株式会社B",
              kind: "corporation",
              createdAt: "2026-02-01T00:00:00.000Z",
            },
          ],
        }),
    });
    renderRoute(HomeRoute, { path: "/", url: "/" });

    const links = await screen.findAllByRole("link", { name: "証憑を追加" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/e/e1/receipts", "/e/e2/receipts"]);
    expect(screen.queryByRole("link", { name: "証憑を撮る" })).not.toBeInTheDocument();
  });
});
