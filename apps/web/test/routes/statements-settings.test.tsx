import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/settings/statements";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 006 US2: 明細の設定（まとめて承認・外部へ送るしきい値。H:§6.3）

const ENTITY_A = {
  id: "e1",
  name: "個人事業A",
  kind: "individual",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const ENTITY_B = {
  id: "e2",
  name: "株式会社B",
  kind: "corporation",
  createdAt: "2026-02-01T00:00:00.000Z",
};

const settings = (bulkThreshold: number, externalThreshold: number) => ({
  settings: { bulkThreshold, externalThreshold, updatedAt: "2026-10-26T00:00:00.000Z" },
});

const putCalls = (all: ApiCall[], entityId = "e1") =>
  all.filter(
    (c) => c.method === "PUT" && c.path === `/api/entities/${entityId}/statement-settings`,
  );

function openSettings(extra: Record<string, Parameters<typeof mockApi>[0][string]> = {}) {
  const all = mockApi({
    "GET /api/entities": () => ok({ entities: [ENTITY_A, ENTITY_B] }),
    "GET /api/entities/e1/statement-settings": () => ok(settings(80, 60)),
    "GET /api/entities/e2/statement-settings": () => ok(settings(90, 70)),
    ...extra,
  });
  renderRoute(Route, { path: "/settings/statements", url: "/settings/statements" });
  return all;
}

const user = () => userEvent.setup();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("明細の設定", () => {
  it("最初の事業体の設定を表示する。事業体を切り替えると、その事業体の設定を読む", async () => {
    const u = user();
    openSettings();

    expect(await screen.findByLabelText("まとめて承認のしきい値")).toHaveValue("80");
    expect(screen.getByLabelText("外部の AI へ送るしきい値")).toHaveValue("60");
    expect(screen.getByLabelText("事業体")).toHaveValue("e1");

    await u.selectOptions(screen.getByLabelText("事業体"), "株式会社B");
    await waitFor(() => expect(screen.getByLabelText("まとめて承認のしきい値")).toHaveValue("90"));
    expect(screen.getByLabelText("外部の AI へ送るしきい値")).toHaveValue("70");
  });

  it("保存すると PUT で送り、「保存しました。」と出す", async () => {
    const u = user();
    const all = openSettings({
      "PUT /api/entities/e1/statement-settings": () => ok(settings(90, 40)),
    });

    const bulk = await screen.findByLabelText("まとめて承認のしきい値");
    await u.clear(bulk);
    await u.type(bulk, "90");
    const external = screen.getByLabelText("外部の AI へ送るしきい値");
    await u.clear(external);
    await u.type(external, "40");
    await u.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
    expect(putCalls(all)[0]?.body).toEqual({ bulkThreshold: 90, externalThreshold: 40 });
  });

  it("0〜100 の整数でなければ送らずに、項目にメッセージを出す", async () => {
    const u = user();
    const all = openSettings();

    const bulk = await screen.findByLabelText("まとめて承認のしきい値");
    for (const bad of ["101", "5.5", "abc", ""]) {
      await u.clear(bulk);
      if (bad !== "") await u.type(bulk, bad);
      await u.click(screen.getByRole("button", { name: "保存" }));
      expect(await screen.findByText("0〜100 の整数で入力してください")).toBeInTheDocument();
      expect(bulk).toHaveAttribute("aria-invalid", "true");
    }
    expect(putCalls(all)).toHaveLength(0);
  });

  it("API のエラーは表示し、「保存しました。」は出さない", async () => {
    const u = user();
    openSettings({
      "PUT /api/entities/e1/statement-settings": () =>
        apiError(400, "VALIDATION", "しきい値は 0〜100 の整数にしてください"),
    });

    await u.click(await screen.findByRole("button", { name: "保存" }));
    expect(await screen.findByText("しきい値は 0〜100 の整数にしてください")).toBeInTheDocument();
    expect(screen.queryByText("保存しました。")).not.toBeInTheDocument();
  });

  it("事業体がなければその旨を出す", async () => {
    mockApi({ "GET /api/entities": () => ok({ entities: [] }) });
    renderRoute(Route, { path: "/settings/statements", url: "/settings/statements" });
    expect(await screen.findByText("事業体がありません。")).toBeInTheDocument();
  });
});
