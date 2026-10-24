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

const settingsForm = () => screen.findByRole("form", { name: "置き場所とパスフレーズの設定" });
const changeForm = () => screen.findByRole("form", { name: "パスフレーズの変更" });

describe("バックアップの設定", () => {
  it("同意のチェックを入れるまで保存できない", async () => {
    open({}, status({ configured: false, folder: null }));
    const form = within(await settingsForm());
    const save = form.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    await userEvent.click(form.getByLabelText(/パスフレーズを失うと復元できない/));
    expect(save).toBeEnabled();
  });

  it("12文字未満はその場で警告し、12文字になると消える", async () => {
    open({}, status({ configured: false, folder: null }));
    const form = within(await settingsForm());
    await userEvent.type(form.getByLabelText("パスフレーズ"), "short-pass1");
    expect(form.getByText(/12文字以上/)).toBeInTheDocument();
    await userEvent.type(form.getByLabelText("パスフレーズ"), "2");
    expect(form.queryByText(/12文字以上にしてください/)).not.toBeInTheDocument();
  });

  it("確認の入力が違うとその場で示す", async () => {
    open({}, status({ configured: false, folder: null }));
    const form = within(await settingsForm());
    await userEvent.type(form.getByLabelText("パスフレーズ"), "correct-horse-battery");
    await userEvent.type(form.getByLabelText("パスフレーズ（確認）"), "correct-horse");
    expect(form.getByText(/一致しません/)).toBeInTheDocument();
  });

  it("保存で PUT /backup/settings に本文を送り、入力を消す", async () => {
    const calls = open(
      {
        "PUT /api/backup/settings": () => ok({ runId: "r9" }),
      },
      status({ configured: false, folder: null }),
    );
    const form = within(await settingsForm());
    await userEvent.type(form.getByLabelText("置き場所"), "/Users/me/backup");
    await userEvent.type(form.getByLabelText("パスフレーズ"), "correct-horse-battery");
    await userEvent.type(form.getByLabelText("パスフレーズ（確認）"), "correct-horse-battery");
    await userEvent.click(form.getByLabelText(/パスフレーズを失うと復元できない/));
    await userEvent.click(form.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(callsTo(calls, "PUT", "/api/backup/settings")).toHaveLength(1));
    expect(callsTo(calls, "PUT", "/api/backup/settings")[0]?.body).toEqual({
      folder: "/Users/me/backup",
      passphrase: "correct-horse-battery",
      passphraseConfirm: "correct-horse-battery",
      acknowledged: true,
    });
    await waitFor(() => expect(form.getByLabelText("パスフレーズ")).toHaveValue(""));
  });

  it("サーバーの拒否（置き場所がない・短い・不一致）の文言を表示する", async () => {
    const replies = [
      apiError(422, "BACKUP_FOLDER_NOT_FOUND", "x"),
      apiError(422, "PASSPHRASE_TOO_SHORT", "x"),
      apiError(422, "PASSPHRASE_MISMATCH", "x"),
    ];
    open({ "PUT /api/backup/settings": () => replies.shift() ?? ok({ runId: null }) });
    const form = within(await settingsForm());
    await userEvent.click(form.getByLabelText(/パスフレーズを失うと復元できない/));
    const save = form.getByRole("button", { name: "保存" });

    await userEvent.click(save);
    expect(await form.findByText(/置き場所のフォルダが見つからない/)).toBeInTheDocument();
    await userEvent.click(save);
    expect(await form.findByText(/パスフレーズは12文字以上/)).toBeInTheDocument();
    await userEvent.click(save);
    expect(await form.findByText(/確認用の入力が一致しません/)).toBeInTheDocument();
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

  it("未設定のときは押せず、パスフレーズの変更も出ない", async () => {
    open({}, status({ configured: false, folder: null }));
    expect(await screen.findByRole("button", { name: /今すぐバックアップ/ })).toBeDisabled();
    expect(screen.queryByRole("form", { name: "パスフレーズの変更" })).not.toBeInTheDocument();
  });

  it("実行中の再要求（BACKUP_RUNNING）の文言を表示する", async () => {
    open({ "POST /api/backup/run": () => apiError(409, "BACKUP_RUNNING", "x") });
    await userEvent.click(await screen.findByRole("button", { name: "今すぐバックアップ" }));
    expect(await screen.findByText(/実行中です/)).toBeInTheDocument();
  });
});

describe("実行の履歴", () => {
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
      (["FOLDER_NOT_FOUND", "WRITE_FAILED", "VERIFY_FAILED", "PASSPHRASE_MISSING"] as const).map(
        (code, i) => run({ id: `f${i}`, status: "failed", errorCode: code }),
      ),
    );
    const table = await screen.findByRole("table", { name: "バックアップの実行履歴" });
    const text = table.textContent ?? "";
    expect(text).toContain("置き場所のフォルダが見つかりません");
    expect(text).toContain("書き込みに失敗しました");
    expect(text).toContain("書いたファイルを読み戻せませんでした");
    expect(text).toContain("パスフレーズが見つかりません");
  });
});

describe("パスフレーズの変更", () => {
  const fill = async (form: ReturnType<typeof within>) => {
    await userEvent.type(form.getByLabelText("新しいパスフレーズ"), "new-correct-horse");
    await userEvent.type(form.getByLabelText("新しいパスフレーズ（確認）"), "new-correct-horse");
  };

  it("今のパスフレーズを求め、過去のファイルは古いままと示す", async () => {
    const calls = open({ "PUT /api/backup/passphrase": () => ok({ runId: "r5" }) });
    const form = within(await changeForm());
    expect(form.getByText(/以前のバックアップは古いパスフレーズのままです/)).toBeInTheDocument();
    await userEvent.type(form.getByLabelText("今のパスフレーズ"), "old-correct-horse");
    await fill(form);
    await userEvent.click(form.getByRole("button", { name: "パスフレーズを変更" }));

    await waitFor(() => expect(callsTo(calls, "PUT", "/api/backup/passphrase")).toHaveLength(1));
    expect(callsTo(calls, "PUT", "/api/backup/passphrase")[0]?.body).toEqual({
      current: "old-correct-horse",
      passphrase: "new-correct-horse",
      passphraseConfirm: "new-correct-horse",
    });
  });

  it("今のパスフレーズが違うときの文言", async () => {
    open({ "PUT /api/backup/passphrase": () => apiError(422, "PASSPHRASE_WRONG", "x") });
    const form = within(await changeForm());
    await userEvent.type(form.getByLabelText("今のパスフレーズ"), "wrong-passphrase");
    await fill(form);
    await userEvent.click(form.getByRole("button", { name: "パスフレーズを変更" }));
    expect(await form.findByText(/今のパスフレーズが違います/)).toBeInTheDocument();
  });

  it("PASSPHRASE_NEEDED のときは今のパスフレーズの欄がなく、再入力を求め、current を送らない", async () => {
    const calls = open(
      { "PUT /api/backup/passphrase": () => ok({ runId: "r6" }) },
      status({ alert: { reason: "PASSPHRASE_NEEDED" } }),
    );
    const form = within(await changeForm());
    expect(form.queryByLabelText("今のパスフレーズ")).not.toBeInTheDocument();
    expect(form.getByText(/パスフレーズを入力し直して/)).toBeInTheDocument();
    await fill(form);
    await userEvent.click(form.getByRole("button", { name: "パスフレーズを変更" }));

    await waitFor(() => expect(callsTo(calls, "PUT", "/api/backup/passphrase")).toHaveLength(1));
    const body = callsTo(calls, "PUT", "/api/backup/passphrase")[0]?.body;
    expect(body).toEqual({
      passphrase: "new-correct-horse",
      passphraseConfirm: "new-correct-horse",
    });
    expect(body).not.toHaveProperty("current");
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
    ["PASSPHRASE_NEEDED", /パスフレーズが使えません/, "/other"],
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
