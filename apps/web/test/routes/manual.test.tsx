import { createRoute } from "@tanstack/react-router";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as RootRoute } from "@/routes/__root";
import { mockApi, ok } from "../mock-api";
import { renderTree } from "../render-route";

afterEach(() => vi.restoreAllMocks());

function renderApp(url = "/", locked = false) {
  const calls = mockApi({
    "GET /api/entities": () => ok({ entities: [] }),
    ...(locked
      ? {
          "GET /api/auth/status": () =>
            ok({ registered: true, signedIn: false, rpId: "localhost" }),
        }
      : {}),
  });
  const child = createRoute({
    getParentRoute: () => RootRoute,
    path: "$",
    component: () => (
      <main>
        <label>
          入力中の摘要
          <input aria-label="入力中の摘要" />
        </label>
      </main>
    ),
  });
  const { router } = renderTree(RootRoute.addChildren([child]), url);
  return { router, calls };
}

async function openManual() {
  await userEvent.click(await screen.findByRole("button", { name: "マニュアル" }));
  return screen.findByRole("dialog", { name: "マニュアル" });
}

describe("アプリ内マニュアル", () => {
  it("通常画面から開き、閉じてもURLと入力中の内容が保たれる", async () => {
    const { router } = renderApp("/e/demo/journals/new");
    const input = await screen.findByRole("textbox", { name: "入力中の摘要" });
    await userEvent.type(input, "合成の交通費");
    const panel = await openManual();
    expect(
      within(panel).getByRole("button", { name: "この画面：仕訳を入力する" }),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(input).toHaveValue("合成の交通費");
    expect(router.state.location.pathname).toBe("/e/demo/journals/new");
    expect(screen.getByRole("button", { name: "マニュアル" })).toHaveFocus();
  });

  it("施錠中でも操作説明を読み、帳簿のAPIを呼ばない", async () => {
    const { calls } = renderApp("/", true);
    await screen.findByRole("heading", { name: "帳簿は施錠されています" });
    const panel = await openManual();
    await userEvent.click(within(panel).getByRole("button", { name: "初期設定・解錠・回復キー" }));
    expect(
      within(panel).getByRole("heading", { name: "初期設定・解錠・回復キー" }),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.path.startsWith("/api/entities"))).toHaveLength(0);
  });

  it("ボタン名・エラーの文言でFAQを含めて検索し、画像と注意事項を読める", async () => {
    renderApp();
    const panel = await openManual();
    await userEvent.type(
      within(panel).getByRole("searchbox", { name: "マニュアルを検索" }),
      "JOURNAL_LINKED",
    );
    await userEvent.click(within(panel).getByRole("button", { name: "仕訳を訂正・取消する" }));
    expect(within(panel).getByRole("heading", { name: "注意事項" })).toBeInTheDocument();
    expect(within(panel).getByText(/請求・入金から作った仕訳/)).toBeInTheDocument();
    expect(within(panel).getByRole("img", { name: /仕訳の詳細/ })).toHaveAttribute(
      "src",
      "/manual/journal-detail.png",
    );
    await userEvent.click(within(panel).getByText("JOURNAL_LINKEDで訂正できない", { exact: true }));
    expect(within(panel).getByText(/請求書の詳細/)).toBeVisible();
    await userEvent.click(within(panel).getByRole("button", { name: "目的の一覧へ" }));
    expect(within(panel).getByRole("searchbox")).toHaveValue("JOURNAL_LINKED");
  });

  it("一致がないときに検索を解除して目的の一覧へ戻れる", async () => {
    renderApp();
    const panel = await openManual();
    await userEvent.type(within(panel).getByRole("searchbox"), "存在しない検索語987");
    expect(
      within(panel).getByText("該当する記事がありません。別の言葉で検索してください。", {
        exact: true,
      }),
    ).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "検索をクリア" }));
    expect(within(panel).getByRole("button", { name: "仕訳を入力する" })).toBeInTheDocument();
  });
});
