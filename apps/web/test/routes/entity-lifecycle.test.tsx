import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/index";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const entity = {
  id: "0190a000-0000-7000-8000-00000000000a",
  name: "合成事業",
  kind: "individual",
  createdAt: "2026-01-01T00:00:00Z",
  demo: false,
};
afterEach(() => vi.unstubAllGlobals());

it("種別の説明を展開し、法人の制約を確認できる", async () => {
  mockApi({
    "GET /api/entities": () => ok({ entities: [] }),
    "GET /api/entities/archived": () => ok({ entities: [] }),
  });
  renderRoute(Route, { path: "/", url: "/?list=1" });
  const summary = await screen.findByText("個人・法人の違い");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  await userEvent.click(summary);
  expect(summary.closest("details")).toHaveAttribute("open");
  expect(screen.getByText(/法人税の申告には対応していません/)).toBeVisible();
});

it("初期一覧から非表示→非表示の組織→名称確認→完全削除を行う", async () => {
  let status = "active";
  const calls = mockApi({
    "GET /api/entities": () => ok({ entities: status === "active" ? [entity] : [] }),
    "GET /api/entities/archived": () =>
      ok({ entities: status === "archived" ? [{ ...entity, status }] : [] }),
    [`POST /api/entities/${entity.id}/archive`]: () => {
      status = "archived";
      return ok({ ok: true });
    },
    [`DELETE /api/entities/${entity.id}/purge`]: () => {
      status = "gone";
      return ok({ ok: true });
    },
  });
  renderRoute(Route, { path: "/", url: "/?list=1" });
  expect(screen.queryByRole("button", { name: "完全に削除" })).not.toBeInTheDocument();
  await userEvent.click(await screen.findByRole("button", { name: "非表示にする" }));
  await waitFor(() => expect(status).toBe("archived"));
  await userEvent.click(screen.getByText("非表示の組織"));
  await userEvent.click(await screen.findByRole("button", { name: "完全に削除" }));
  const dialog = await screen.findByRole("dialog");
  const submit = within(dialog).getByRole("button", { name: "完全に削除" });
  expect(submit).toBeDisabled();
  await userEvent.type(within(dialog).getByRole("textbox", { name: "確認の名称" }), entity.name);
  await userEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ name: entity.name });
  expect(status).toBe("gone");
});
