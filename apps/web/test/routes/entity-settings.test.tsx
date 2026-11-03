import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/settings";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 事業体の設定の「基本」（011/T005、FR-052）。事業体の名前の変更は、ホームからここへ移した

const entity = {
  id: "e1",
  name: "個人事業A",
  kind: "individual",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("事業体の設定（基本）", () => {
  it("見出し「基本」と、事業体の名前の変更を出し、変更すると PATCH する", async () => {
    const calls = mockApi({
      "GET /api/entities": () => ok({ entities: [entity] }),
      "PATCH /api/entities/e1": (call) => ok({ entity: { ...entity, ...(call.body as object) } }),
    });
    renderRoute(Route, { path: "/e/$entityId/settings", url: "/e/e1/settings" });

    expect(await screen.findByRole("heading", { level: 1, name: "基本" })).toBeInTheDocument();
    const name = await screen.findByLabelText("名称");
    expect(name).toHaveValue("個人事業A");
    await userEvent.clear(name);
    await userEvent.type(name, "個人事業B");
    await userEvent.click(screen.getByRole("button", { name: "変更する" }));

    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/entities/e1")?.body,
      ).toEqual({
        name: "個人事業B",
      }),
    );
  });
});
