import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/index";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 014 T006: 事業体の一覧の空の状態に「デモ事業を作って試す」

const entity = {
  id: "0190a000-0000-7000-8000-00000000000a",
  name: "合成事業",
  kind: "individual",
  createdAt: "2026-01-01T00:00:00Z",
  demo: false,
};
const demo = {
  id: "0190a000-0000-7000-8000-0000000000d1",
  name: "デモ事業",
  kind: "individual",
  createdAt: "2026-11-08T03:00:00Z",
  demo: true,
};
afterEach(() => vi.unstubAllGlobals());

const BUTTON = "デモ事業を作って試す";
const DESCRIPTION = "架空のデータで機能を試せる事業体を作ります。試し終わったら削除できます。";

it("事業体が 0 件のとき、説明とボタン（variant=outline）が出る", async () => {
  mockApi({ "GET /api/entities": () => ok({ entities: [] }) });
  renderRoute(Route, { path: "/", url: "/?list=1" });
  const button = await screen.findByRole("button", { name: BUTTON });
  expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
  expect(button).toBeEnabled();
  // 各画面の default のボタンは 1 つ（作成フォームの「作成」）。デモのボタンは outline
  expect(button.className).toContain("border");
  expect(button.className).not.toContain("bg-primary");
});

it("事業体が 1 件以上あるときは出ない", async () => {
  mockApi({ "GET /api/entities": () => ok({ entities: [entity] }) });
  renderRoute(Route, { path: "/", url: "/?list=1" });
  await screen.findByText("合成事業");
  expect(screen.queryByRole("button", { name: BUTTON })).not.toBeInTheDocument();
  expect(screen.queryByText(DESCRIPTION)).not.toBeInTheDocument();
});

it("押すと無効になって「作成中…」、成功でデモのホームへ移り、一覧を読み直す", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entities: unknown[] = [];
  const calls = mockApi({
    "GET /api/entities": () => ok({ entities }),
    "POST /api/entities/demo": async () => {
      await gate;
      entities = [demo];
      return ok({ entity: demo }, 201);
    },
  });
  const { router } = renderRoute(Route, { path: "/", url: "/?list=1" });
  await userEvent.click(await screen.findByRole("button", { name: BUTTON }));
  const pending = await screen.findByRole("button", { name: "作成中…" });
  expect(pending).toBeDisabled();
  release();
  await waitFor(() => expect(router.state.location.pathname).toBe(`/e/${demo.id}`));
  const gets = calls.filter((c) => c.method === "GET" && c.path === "/api/entities");
  expect(gets.length).toBeGreaterThanOrEqual(2);
});

it.each([
  [409, "DEMO_NOT_AVAILABLE", "事業体があるため、デモ事業は作れません"],
  [500, "DEMO_FAILED", "デモ事業を作れませんでした"],
] as const)("%i %s は既存のエラー表示で出し、ボタンは押し直せる", async (status, code, text) => {
  mockApi({
    "GET /api/entities": () => ok({ entities: [] }),
    "POST /api/entities/demo": () => apiError(status, code, "サーバーの文言"),
  });
  renderRoute(Route, { path: "/", url: "/?list=1" });
  await userEvent.click(await screen.findByRole("button", { name: BUTTON }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(text);
  expect(screen.getByRole("button", { name: BUTTON })).toBeEnabled();
});

it("デモ事業を完全に削除して 0 件に戻ると、またボタンが出る（014 T007 の足しどころ）", async () => {
  let entities: unknown[] = [demo];
  mockApi({ "GET /api/entities": () => ok({ entities }) });
  const { queryClient } = renderRoute(Route, { path: "/", url: "/?list=1" });
  await screen.findByText("デモ事業");
  expect(screen.queryByRole("button", { name: BUTTON })).not.toBeInTheDocument();
  entities = [];
  await queryClient.invalidateQueries({ queryKey: ["entities"] });
  expect(await screen.findByRole("button", { name: BUTTON })).toBeInTheDocument();
});

it("demo の事業体だけ、名前の横に「デモ」の印が出る（014 T007）", async () => {
  mockApi({ "GET /api/entities": () => ok({ entities: [entity, demo] }) });
  renderRoute(Route, { path: "/", url: "/?list=1" });
  const demoRow = (await screen.findByText("デモ事業")).closest("tr");
  const normalRow = screen.getByText("合成事業").closest("tr");
  if (demoRow === null || normalRow === null) throw new Error("行がない");
  expect(within(demoRow).getByText("デモ")).toBeInTheDocument();
  expect(within(normalRow).queryByText("デモ")).not.toBeInTheDocument();
});
