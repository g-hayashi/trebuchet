import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as ImportRoute } from "@/routes/e/$entityId/statements/import";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 006 US4: MF ME からの自動取得（H:§3.4・§3.5 と §3.1・§3.2 の mfme_fetch）。
// 画面は状態を取りにくるだけで、取得はサーバーの偽ではない取得器が行う（ここでは API を偽にする）

const BASE = "/api/entities/e1";
const JOB_ID = "00000000-0000-4000-8000-000000000999";
const SHA = "b".repeat(64);
const SOURCE = { kind: "mfme_fetch", jobId: JOB_ID };

const PREVIEW = {
  inputSha256: SHA,
  period: { from: "2026-05-10", to: "2026-05-11" },
  totals: { inflow: 3000, outflow: 1200 },
  rows: [
    {
      key: "k0",
      date: "2026-05-10",
      amount: -1200,
      content: "ショップ001",
      accountName: "サンプル銀行",
      status: "new",
      warnings: [],
    },
    {
      key: "k1",
      date: "2026-05-11",
      amount: 3000,
      content: "売上入金",
      accountName: "サンプル銀行",
      status: "new",
      warnings: [],
    },
  ],
  unreadable: [],
  unmappedAccounts: [] as string[],
  countNew: 2,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+09:00"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderImport = () =>
  renderRoute(ImportRoute, {
    path: "/e/$entityId/statements/import",
    url: "/e/e1/statements/import",
  });

const calls = (all: ApiCall[], method: string, path: string) =>
  all.filter((c) => c.method === method && c.path === `${BASE}${path}`);

const startRoute = { [`POST ${BASE}/statements/mfme/fetch`]: () => ok({ jobId: JOB_ID }, 202) };
const jobPath = `GET ${BASE}/jobs/${JOB_ID}`;

describe("取得の開始（§3.4）", () => {
  it("期間（既定は今月）を送り、ログイン待ちの案内を出す", async () => {
    const all = mockApi({
      ...startRoute,
      [jobPath]: () => ok({ status: "waiting_login" }),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await screen.findByRole("region", { name: "MF ME から取得" });
    expect(region).toBeInTheDocument();
    expect(screen.getByLabelText("開始月")).toHaveValue("2026-10");
    expect(screen.getByLabelText("終了月")).toHaveValue("2026-10");
    fireEvent.change(screen.getByLabelText("開始月"), { target: { value: "2026-08" } });
    await u.click(screen.getByRole("button", { name: "取得を開始" }));

    expect(await screen.findByText(/ブラウザのウィンドウで MF ME にログイン/)).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/mfme/fetch")[0]?.body).toEqual({
      from: "2026-08",
      to: "2026-10",
    });
    expect(screen.getByRole("button", { name: "取得を開始" })).toBeDisabled();
  });

  it("開始月が終了月より後なら、送らずに知らせる", async () => {
    const all = mockApi(startRoute);
    const u = userEvent.setup();
    renderImport();
    await screen.findByRole("region", { name: "MF ME から取得" });
    fireEvent.change(screen.getByLabelText("開始月"), { target: { value: "2026-11" } });
    await u.click(screen.getByRole("button", { name: "取得を開始" }));
    expect(await screen.findByText("開始月は終了月以前にしてください")).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/mfme/fetch")).toHaveLength(0);
  });

  it("別の取得が動いている（409 JOB_RUNNING）と、その旨を示す", async () => {
    mockApi({
      [`POST ${BASE}/statements/mfme/fetch`]: () =>
        apiError(409, "JOB_RUNNING", "取得のジョブが動いています"),
    });
    const u = userEvent.setup();
    renderImport();
    await u.click(await screen.findByRole("button", { name: "取得を開始" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("取得のジョブが動いています");
  });
});

describe("完了 → プレビュー → 確定", () => {
  it("取得中の状態を取り直し、done でジョブの ID を取込元としてプレビューを出し、確定できる", async () => {
    let polls = 0;
    const all = mockApi({
      ...startRoute,
      [jobPath]: () =>
        ok(
          ++polls === 1
            ? { status: "running", progress: { month: "2026-10", done: 0, total: 1 } }
            : { status: "done" },
        ),
      [`POST ${BASE}/statements/imports/preview`]: () => ok(PREVIEW),
      [`POST ${BASE}/statements/imports`]: () =>
        ok(
          {
            batch: {
              id: "00000000-0000-4000-8000-000000000001",
              origin: "mfme_fetch",
              inputSha256: SHA,
              periodFrom: "2026-05-10",
              periodTo: "2026-05-11",
              countNew: 2,
              countExisting: 0,
              countUnreadable: 0,
              createdAt: "2026-10-26T01:00:00.000Z",
            },
            added: 2,
            changed: 0,
          },
          201,
        ),
    });
    const u = userEvent.setup();
    renderImport();
    await u.click(await screen.findByRole("button", { name: "取得を開始" }));
    expect(await screen.findByText(/取得しています/)).toHaveTextContent("2026-10");

    expect(
      await screen.findByRole("region", { name: "プレビューの要約" }, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/imports/preview")[0]?.body).toEqual({
      source: SOURCE,
    });
    expect(screen.getByRole("table", { name: "取り込む明細の一覧" })).toHaveTextContent("売上入金");

    await u.click(screen.getByRole("button", { name: "取り込む" }));
    expect(await screen.findByText("2 件を取り込みました。")).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/imports")[0]?.body).toEqual({
      source: SOURCE,
      expected: { inputSha256: SHA, countNew: 2 },
    });
    // 取得の状態は取り直さない（終わったジョブを繰り返し読まない）
    const jobCalls = calls(all, "GET", `/jobs/${JOB_ID}`).length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(calls(all, "GET", `/jobs/${JOB_ID}`)).toHaveLength(jobCalls);
  }, 10_000);
});

describe("失敗（FR-010）", () => {
  it("理由・失敗した口座・貼り付けの案内を出し、明細は取り込まない。案内から貼り付けへ進める", async () => {
    const all = mockApi({
      ...startRoute,
      [jobPath]: () =>
        ok({
          status: "failed",
          error: {
            code: "MFME_DOM_CHANGED",
            message: "MF ME の画面の形が想定と違うため、読み取れませんでした",
            failedAccounts: ["サンプル銀行", "サンプルカード"],
          },
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await u.click(await screen.findByRole("button", { name: "取得を開始" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("MF ME の画面の形が想定と違うため、読み取れませんでした");
    expect(alert).toHaveTextContent("取得できなかった口座");
    expect(alert).toHaveTextContent("サンプル銀行");
    expect(alert).toHaveTextContent("サンプルカード");
    expect(alert).toHaveTextContent("貼り付けで取り込めます");
    expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "プレビューの要約" })).not.toBeInTheDocument();
    // 失敗の後は、もう一度取得できる
    expect(screen.getByRole("button", { name: "取得を開始" })).toBeEnabled();

    await u.click(screen.getByRole("button", { name: "貼り付けで取り込む" }));
    await waitFor(() => expect(screen.getByLabelText("貼り付けのテキスト")).toHaveFocus());
  });

  it("失敗の理由がなくても（口座なし）、貼り付けの案内を出す", async () => {
    mockApi({
      ...startRoute,
      [jobPath]: () =>
        ok({
          status: "failed",
          error: { code: "MFME_LOGIN_TIMEOUT", message: "ログインが完了しませんでした" },
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await u.click(await screen.findByRole("button", { name: "取得を開始" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("ログインが完了しませんでした");
    expect(alert).not.toHaveTextContent("取得できなかった口座");
    expect(screen.getByRole("button", { name: "貼り付けで取り込む" })).toBeInTheDocument();
  });

  it("ジョブが消えていた（server の再起動。404 JOB_NOT_FOUND）ときも、貼り付けへ案内する", async () => {
    mockApi({
      ...startRoute,
      [jobPath]: () => apiError(404, "JOB_NOT_FOUND", "取得のジョブが見つかりません"),
    });
    const u = userEvent.setup();
    renderImport();
    await u.click(await screen.findByRole("button", { name: "取得を開始" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("取得のジョブが見つかりません");
    expect(screen.getByRole("button", { name: "貼り付けで取り込む" })).toBeInTheDocument();
  });
});
