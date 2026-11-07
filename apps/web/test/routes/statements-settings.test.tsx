import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/statements/settings";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 006 US2・US3: 明細の設定（まとめて承認・外部へ送るしきい値。H:§6.3）。事業体ごとの設定なので、
// 事業体の画面の下（/e/:entityId/statements/settings）に置く（事業体の選択は持たない）

const settings = (bulkThreshold: number, externalThreshold: number) => ({
  settings: { bulkThreshold, externalThreshold, updatedAt: "2026-10-26T00:00:00.000Z" },
});

const putCalls = (all: ApiCall[], entityId = "e1") =>
  all.filter(
    (c) => c.method === "PUT" && c.path === `/api/entities/${entityId}/statement-settings`,
  );

function openSettings(
  extra: Record<string, Parameters<typeof mockApi>[0][string]> = {},
  entityId = "e1",
) {
  const all = mockApi({
    "GET /api/entities/e1/statement-settings": () => ok(settings(80, 60)),
    "GET /api/entities/e2/statement-settings": () => ok(settings(90, 70)),
    ...extra,
  });
  renderRoute(Route, {
    path: "/e/$entityId/statements/settings",
    url: `/e/${entityId}/statements/settings`,
  });
  return all;
}

const user = () => userEvent.setup();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("明細の設定", () => {
  it("URL の事業体の設定を表示する。事業体の選択は持たない", async () => {
    openSettings({}, "e2");

    expect(await screen.findByLabelText("確信度の高い行のしきい値")).toHaveValue("90");
    expect(screen.getByLabelText("外部の AI へ送るしきい値")).toHaveValue("70");
    expect(screen.queryByLabelText("事業体")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "明細の設定" })).toBeInTheDocument();
  });

  it("明細の一覧へ戻るリンクがある", async () => {
    openSettings();
    expect(await screen.findByRole("link", { name: "明細の一覧へ" })).toHaveAttribute(
      "href",
      "/e/e1/statements",
    );
  });

  it("保存すると PUT で送り、「保存しました。」と出す", async () => {
    const u = user();
    const all = openSettings({
      "PUT /api/entities/e1/statement-settings": () => ok(settings(90, 40)),
    });

    const bulk = await screen.findByLabelText("確信度の高い行のしきい値");
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

    const bulk = await screen.findByLabelText("確信度の高い行のしきい値");
    for (const bad of ["101", "5.5", "abc", ""]) {
      await u.clear(bulk);
      if (bad !== "") await u.type(bulk, bad);
      await u.click(screen.getByRole("button", { name: "保存" }));
      expect(await screen.findByText("0〜100 の整数で入力してください")).toBeInTheDocument();
      expect(bulk).toHaveAttribute("aria-invalid", "true");
    }
    expect(putCalls(all)).toHaveLength(0);
  });

  it("しきい値を変えるのはここだけ。一覧・確認の画面には出ないと案内し、保存が主な操作", async () => {
    openSettings();
    await screen.findByLabelText("確信度の高い行のしきい値");
    expect(screen.getByText(/一覧・確認の画面には出ません/)).toBeInTheDocument();
    expect(screen.getAllByText(/「確信度の高い行を選択」/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/まとめて承認/)).not.toBeInTheDocument();
    const primary = screen
      .getAllByRole("button")
      .filter((b) => b.className.split(" ").includes("bg-primary"))
      .map((b) => b.textContent);
    expect(primary).toEqual(["保存"]);
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
});

// 007 US2: 取込元（列の対応の保存）の一覧・名前の変更・削除（H:§3）
describe("取込元", () => {
  const source = (n: number, name: string, over: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name,
    fixedAccountName: null,
    mapping: {
      delimiter: "\t",
      headerRow: 0,
      columns: { date: 0, content: 1, amount: 2, accountName: 3 },
      amountSign: "inflow_positive",
    },
    header: ["日付", "内容", "金額", "保有金融機関"],
    lastUsedAt: "2026-10-20T01:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-10-20T01:00:00.000Z",
    ...over,
  });
  const A = source(1, "MF ME");
  const B = source(2, "テスト銀行 CSV", { fixedAccountName: "テスト銀行" });
  const SOURCES = "GET /api/entities/e1/statement-sources";
  const sourcesRegion = () => screen.findByRole("region", { name: "取込元" });

  it("名前・種類（まとめ / 1 つの口座）・最後に使った日時を一覧にする", async () => {
    openSettings({ [SOURCES]: () => ok({ sources: [A, B] }) });
    const table = await within(await sourcesRegion()).findByRole("table", { name: "取込元の一覧" });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("MF ME");
    expect(rows[1]).toHaveTextContent("まとめ");
    expect(rows[2]).toHaveTextContent("テスト銀行 CSV");
    expect(rows[2]).toHaveTextContent("1 つの口座");
    expect(rows[2]).toHaveTextContent("テスト銀行");
    expect(rows[1]).toHaveTextContent(new Date(A.lastUsedAt).toLocaleString("ja-JP"));
  });

  it("保存した取込元がなければその旨を示す", async () => {
    openSettings();
    expect(await screen.findByText("保存した取込元はまだありません。")).toBeInTheDocument();
  });

  it("名前を変えると PATCH で送り、一覧を読み直す", async () => {
    const u = user();
    let name = "MF ME";
    const all = openSettings({
      [SOURCES]: () => ok({ sources: [{ ...A, name }] }),
      [`PATCH /api/entities/e1/statement-sources/${A.id}`]: (call) => {
        name = (call.body as { name: string }).name;
        return ok({ source: { ...A, name } });
      },
    });
    const region = await sourcesRegion();
    await u.click(await within(region).findByRole("button", { name: "「MF ME」の名前を変更" }));
    const input = within(region).getByLabelText("「MF ME」の新しい名前");
    expect(input).toHaveValue("MF ME");
    await u.clear(input);
    await u.type(input, "マネーフォワード");
    await u.click(within(region).getByRole("button", { name: "「MF ME」の名前を保存" }));

    expect(await within(region).findByText("マネーフォワード")).toBeInTheDocument();
    expect(
      all.find((c) => c.method === "PATCH" && c.path.endsWith(`/statement-sources/${A.id}`))?.body,
    ).toEqual({ name: "マネーフォワード" });
    // 編集の欄は閉じる
    expect(within(region).queryByLabelText("「MF ME」の新しい名前")).not.toBeInTheDocument();
  });

  it("名前の変更が重複（409）なら知らせ、欄は開いたまま。空の名前は送らない", async () => {
    const u = user();
    const all = openSettings({
      [SOURCES]: () => ok({ sources: [A, B] }),
      [`PATCH /api/entities/e1/statement-sources/${A.id}`]: () =>
        apiError(409, "STATEMENT_SOURCE_NAME_TAKEN", "同じ名前の取込元があります"),
    });
    const region = await sourcesRegion();
    await u.click(await within(region).findByRole("button", { name: "「MF ME」の名前を変更" }));
    const input = within(region).getByLabelText("「MF ME」の新しい名前");
    await u.clear(input);
    expect(within(region).getByRole("button", { name: "「MF ME」の名前を保存" })).toBeDisabled();
    await u.type(input, "テスト銀行 CSV");
    await u.click(within(region).getByRole("button", { name: "「MF ME」の名前を保存" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "同じ名前の取込元があります",
    );
    expect(input).toBeInTheDocument();
    expect(all.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("名前の変更をやめると、欄を閉じて何も送らない", async () => {
    const u = user();
    const all = openSettings({ [SOURCES]: () => ok({ sources: [A] }) });
    const region = await sourcesRegion();
    await u.click(await within(region).findByRole("button", { name: "「MF ME」の名前を変更" }));
    await u.click(within(region).getByRole("button", { name: "やめる" }));
    expect(within(region).queryByLabelText("「MF ME」の新しい名前")).not.toBeInTheDocument();
    expect(all.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("削除は確認してから DELETE。確認の文言で、明細と仕訳は変わらないと説明する", async () => {
    const u = user();
    let sources = [A, B];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const all = openSettings({
      [SOURCES]: () => ok({ sources }),
      [`DELETE /api/entities/e1/statement-sources/${A.id}`]: () => {
        sources = [B];
        return { status: 204, body: undefined };
      },
    });
    const region = await sourcesRegion();
    await u.click(await within(region).findByRole("button", { name: "「MF ME」を削除" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0]?.[0])).toContain("MF ME");
    expect(String(confirm.mock.calls[0]?.[0])).toContain("明細");
    expect(String(confirm.mock.calls[0]?.[0])).toContain("仕訳");
    await waitFor(() =>
      expect(within(region).queryByRole("button", { name: "「MF ME」を削除" })).toBeNull(),
    );
    expect(all.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(within(region).getByText("テスト銀行 CSV")).toBeInTheDocument();
  });

  it("確認で取りやめれば、DELETE を送らない", async () => {
    const u = user();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const all = openSettings({ [SOURCES]: () => ok({ sources: [A] }) });
    const region = await sourcesRegion();
    await u.click(await within(region).findByRole("button", { name: "「MF ME」を削除" }));
    expect(all.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });
});
