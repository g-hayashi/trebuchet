import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BackupRun, BackupStatus } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as RootRoute } from "@/routes/__root";
import { Route } from "@/routes/settings/backup";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const status = (patch: Partial<BackupStatus> = {}): BackupStatus => ({
  configured: true,
  folderSource: "configured",
  folder: "/Users/me/backup",
  lastSuccess: "2026-10-19T10:00:00.000Z",
  lastCheck: "2026-10-19T10:00:00.000Z",
  lastRun: null,
  alert: null,
  running: false,
  ...patch,
});

const SHA = "a".repeat(64);
const run = (patch: Partial<BackupRun>): BackupRun => ({
  id: "r1",
  startedAt: "2026-10-19T09:59:00.000Z",
  finishedAt: "2026-10-19T10:00:00.000Z",
  trigger: "manual",
  status: "succeeded",
  errorCode: null,
  fileName: null,
  sizeBytes: null,
  contentSha256: SHA,
  summary: null,
  ...patch,
});

const callsTo = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

function open(
  extra: Record<string, Parameters<typeof mockApi>[0][string]> = {},
  s: BackupStatus = status(),
  runs: BackupRun[] = [],
) {
  const calls = mockApi({
    "GET /api/backup/status": () => ok(s),
    "GET /api/backup/runs": () => ok({ runs }),
    ...extra,
  });
  renderRoute(Route, { path: "/settings/backup", url: "/settings/backup" });
  return calls;
}

const settingsForm = () => screen.findByRole("form", { name: "置き場所の設定" });

describe("バックアップの画面の並び（FR-057）", () => {
  it("h1 は設定のメニューの名前と同じ「バックアップ」で、見出しは 状態 → 置き場所の設定 → 復元 → 実行の履歴 の順。h1 と重ならない", async () => {
    open();
    const h1 = await screen.findByRole("heading", { level: 1, name: "バックアップ" });
    expect(h1.parentElement?.className).not.toMatch(/max-w-/);
    await screen.findByRole("heading", { level: 2, name: "状態" });
    await screen.findByRole("heading", { level: 2, name: "置き場所の設定" });
    await screen.findByRole("heading", { level: 2, name: "実行の履歴" });
    const names = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(names).toEqual(["バックアップ", "状態", "置き場所の設定", "復元", "実行の履歴"]);
  });
});

describe("既定の置き場所（FR-056・R16）", () => {
  const DEFAULT_NOTE = /この Mac の中（bak\/）にあります。Mac を失うとバックアップも失われます/;

  it("folderSource が default のときだけ、Mac の中にあること・変えられることを出す", async () => {
    open({}, status({ folderSource: "default", folder: "/repo/bak" }));
    const note = await screen.findByText(DEFAULT_NOTE);
    expect(note).toHaveTextContent("同期フォルダなどに変えられます");
  });

  it("configured なら出さない", async () => {
    open({}, status({ folderSource: "configured" }));
    await screen.findByText("/Users/me/backup");
    expect(screen.queryByText(DEFAULT_NOTE)).not.toBeInTheDocument();
  });
});

describe("書けずに失敗したときの案内（Edge Cases）", () => {
  const failed = (errorCode: string) =>
    status({
      alert: { reason: "LAST_RUN_FAILED" },
      lastRun: run({ status: "failed", errorCode, contentSha256: null }),
    });

  it.each([
    ["WRITE_FAILED", "configured"],
    ["FOLDER_NOT_FOUND", "default"],
  ] as const)("%s（%s）: 警告と一緒に、置き場所を変える案内を出す", async (code, source) => {
    open({}, { ...failed(code), folderSource: source });
    const warning = await screen.findByRole("region", { name: "バックアップの警告" });
    expect(warning).toHaveTextContent("直近のバックアップに失敗しました");
    expect(warning).toHaveTextContent("置き場所を変えてください");
  });

  it("書き込みの失敗でなければ（帳簿の写しの失敗など）置き場所の案内は出さない", async () => {
    open({}, failed("SNAPSHOT_FAILED"));
    const warning = await screen.findByRole("region", { name: "バックアップの警告" });
    expect(warning).not.toHaveTextContent("置き場所を変えてください");
  });

  it("alert がなければ警告は出ない", async () => {
    open();
    await screen.findByRole("heading", { level: 2, name: "状態" });
    expect(screen.queryByRole("region", { name: "バックアップの警告" })).not.toBeInTheDocument();
  });
});

describe("バックアップの設定（008 の D9: パスフレーズ・同意はない）", () => {
  it("置き場所の欄だけがあり、パスフレーズ・同意・パスフレーズの変更はない", async () => {
    open({}, status({ folderSource: "default", folder: "/bak" }));
    const form = within(await settingsForm());
    expect(form.getByLabelText("置き場所")).toBeInTheDocument();
    expect(form.getByRole("button", { name: "保存" })).toBeEnabled();
    expect(screen.queryByLabelText(/パスフレーズ/)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "パスフレーズの変更" })).not.toBeInTheDocument();
    expect(screen.queryByText(/パスフレーズ/)).not.toBeInTheDocument();
  });

  it("鍵は端末の鍵から作ること、新しい Mac では回復キーで復元することを案内する", async () => {
    open({}, status({ folderSource: "default", folder: "/bak" }));
    expect((await screen.findAllByText(/回復キー/)).length).toBeGreaterThan(0);
  });

  it("保存で PUT /backup/settings に置き場所だけを送る", async () => {
    const calls = open(
      {
        "PUT /api/backup/settings": () => ok({ runId: "r9" }),
      },
      status({ folderSource: "default", folder: "/bak" }),
    );
    const form = within(await settingsForm());
    await userEvent.clear(form.getByLabelText("置き場所"));
    await userEvent.type(form.getByLabelText("置き場所"), "/Users/me/backup");
    await userEvent.click(form.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(callsTo(calls, "PUT", "/api/backup/settings")).toHaveLength(1));
    expect(callsTo(calls, "PUT", "/api/backup/settings")[0]?.body).toEqual({
      folder: "/Users/me/backup",
    });
    // 保存の知らせは画面の上の toast に出る（フォームの外）
    expect(await screen.findByText(/保存しました/)).toBeInTheDocument();
  });

  it("サーバーの拒否（置き場所がない）の文言を表示する", async () => {
    open({ "PUT /api/backup/settings": () => apiError(422, "BACKUP_FOLDER_NOT_FOUND", "x") });
    const form = within(await settingsForm());
    await userEvent.click(form.getByRole("button", { name: "保存" }));
    expect(await form.findByText(/置き場所のフォルダが見つからない/)).toBeInTheDocument();
  });
});

describe("今すぐバックアップ", () => {
  it("押すと POST /backup/run を呼ぶ", async () => {
    const calls = open({ "POST /api/backup/run": () => ok({ runId: "r2" }, 202) });
    await userEvent.click(await screen.findByRole("button", { name: "今すぐバックアップ" }));
    await waitFor(() => expect(callsTo(calls, "POST", "/api/backup/run")).toHaveLength(1));
  });

  it("実行中は押せない", async () => {
    open({}, status({ running: true }));
    expect(await screen.findByRole("button", { name: /今すぐバックアップ/ })).toBeDisabled();
  });

  it("未設定でも既定の置き場所があるので押せる", async () => {
    open({}, status({ folderSource: "default", folder: "/bak" }));
    expect(await screen.findByRole("button", { name: /今すぐバックアップ/ })).toBeEnabled();
  });

  it("実行中の再要求（BACKUP_RUNNING）の文言を表示する", async () => {
    open({ "POST /api/backup/run": () => apiError(409, "BACKUP_RUNNING", "x") });
    await userEvent.click(await screen.findByRole("button", { name: "今すぐバックアップ" }));
    expect(await screen.findByText(/実行中です/)).toBeInTheDocument();
  });
});

describe("実行の履歴", () => {
  it("最近の 5 件だけを読む（limit=5）", async () => {
    const calls = open({}, status(), [run({})]);
    await screen.findByRole("table", { name: "バックアップの実行履歴" });
    expect(callsTo(calls, "GET", "/api/backup/runs").map((c) => c.query)).toEqual([{ limit: "5" }]);
  });

  it("「CSV に書き出す」は全件の CSV（format=csv）へのリンク", async () => {
    open({}, status(), [run({})]);
    const link = await screen.findByRole("link", { name: "CSV に書き出す" });
    expect(link).toHaveAttribute("href", "/api/backup/runs?format=csv");
    expect(link).toHaveAttribute("download");
  });

  it("0 件なら「CSV に書き出す」は無効（リンクではなく押せないボタン）", async () => {
    open();
    expect(await screen.findByRole("button", { name: "CSV に書き出す" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "CSV に書き出す" })).not.toBeInTheDocument();
  });
  it("成功・変更なし・失敗を表に示す", async () => {
    open({}, status(), [
      run({
        id: "r3",
        status: "failed",
        trigger: "auto",
        errorCode: "FOLDER_NOT_FOUND",
        contentSha256: null,
      }),
      run({ id: "r2", status: "skipped", trigger: "auto" }),
      run({
        id: "r1",
        status: "succeeded",
        trigger: "manual",
        fileName: "trebuchet-20261019.bak",
        sizeBytes: 2048,
      }),
    ]);
    const table = await screen.findByRole("table", { name: "バックアップの実行履歴" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent("自動");
    expect(rows[1]).toHaveTextContent("失敗");
    expect(rows[1]).toHaveTextContent("置き場所のフォルダが見つかりません");
    expect(rows[2]).toHaveTextContent("変更なし");
    expect(rows[3]).toHaveTextContent("手動");
    expect(rows[3]).toHaveTextContent("成功");
    expect(rows[3]).toHaveTextContent("trebuchet-20261019.bak");
    expect(rows[3]).toHaveTextContent("2.0 KB");
  });

  it("失敗の理由のコードごとの文言", async () => {
    open(
      {},
      status(),
      (
        [
          "FOLDER_NOT_FOUND",
          "WRITE_FAILED",
          "VERIFY_FAILED",
          "SNAPSHOT_FAILED",
          "RECEIPTS_SYNC_FAILED",
        ] as const
      ).map((code, i) => run({ id: `f${i}`, status: "failed", errorCode: code })),
    );
    const table = await screen.findByRole("table", { name: "バックアップの実行履歴" });
    const text = table.textContent ?? "";
    expect(text).toContain("置き場所のフォルダが見つかりません");
    expect(text).toContain("書き込みに失敗しました");
    expect(text).toContain("書いたファイルを読み戻せませんでした");
    expect(text).toContain("帳簿の写しを作れませんでした");
    expect(text).toContain("証憑のファイルを置き場所に写せませんでした");
    expect(text).not.toContain("RECEIPTS_SYNC_FAILED");
  });
});

describe("全画面の上部の知らせ", () => {
  function openRootLayout(s: BackupStatus, url: string) {
    mockApi({
      "GET /api/backup/status": () => ok(s),
      "GET /api/entities": () => ok({ entities: [] }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const home = createRoute({
      getParentRoute: () => RootRoute,
      path: "/",
      component: () => <p>トップの画面</p>,
    });
    const other = createRoute({
      getParentRoute: () => RootRoute,
      path: "/other",
      component: () => <p>別の画面</p>,
    });
    const router = createRouter({
      routeTree: RootRoute.addChildren([home, other]),
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: [url] }),
    });
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it.each([
    ["STALE", /バックアップが成功していません/, "/"],
    ["LAST_RUN_FAILED", /直近のバックアップに失敗しました/, "/other"],
  ] as const)(
    "%s の知らせを、どの画面でも出し、設定へのリンクを付ける",
    async (reason, text, url) => {
      openRootLayout(status({ alert: { reason } }), url);
      const banner = await screen.findByRole("region", { name: "バックアップの知らせ" });
      expect(banner).toHaveTextContent(text);
      expect(within(banner).getByRole("link", { name: /バックアップの設定/ })).toHaveAttribute(
        "href",
        "/settings/backup",
      );
    },
  );

  it("alert がなければ出ない", async () => {
    openRootLayout(status({ alert: null }), "/other");
    await screen.findByText("別の画面");
    expect(screen.queryByRole("region", { name: "バックアップの知らせ" })).not.toBeInTheDocument();
  });
});
