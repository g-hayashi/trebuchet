import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as StatementsRoute } from "@/routes/e/$entityId/statements/index";
import { type ApiCall, type ApiReply, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 006 US5・007/R17: 一覧を開いたときの候補の作り直しの後、AI に回す明細（needsAi）を自動で 10 件ずつ推定する
// （「AI で推定」のボタンはない）。推定は候補を変えるだけで、仕訳は変えない

const BASE = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const calls = (all: ApiCall[], method: string, path: string) =>
  all.filter((c) => c.method === method && c.path === `${BASE}${path}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+09:00"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ids = (count: number) => Array.from({ length: count }, (_, i) => uuid(i + 1));

const renderStatements = () =>
  renderRoute(StatementsRoute, { path: "/e/$entityId/statements/", url: "/e/e1/statements" });

const inferResponse = (statementIds: string[]) =>
  ok({
    results: statementIds.map((statementId) => ({
      statementId,
      method: "local_ai",
      confidence: 80,
    })),
    localAvailable: true,
    externalUsed: false,
  });

const inferBodies = (all: ApiCall[]) =>
  calls(all, "POST", "/statements/infer").map(
    (c) => (c.body as { statementIds: string[] }).statementIds,
  );

/** 未処理の明細が 1 件ある一覧と、候補の作り直しの応答（AI に回す明細は `needsAi`） */
const candidatesRoute = (needsAi: string[]) => ({
  [`GET ${BASE}/statements`]: () =>
    ok({
      statements: [
        {
          id: uuid(900),
          date: "2026-05-10",
          amount: -1200,
          content: "文房具",
          accountName: "サンプル銀行",
          usage: "business",
          status: "unprocessed",
          changed: null,
          candidate: null,
          links: [],
        },
      ],
    }),
  [`POST ${BASE}/statements/candidates`]: () => ok({ built: needsAi.length + 2, needsAi }),
});

const AI_OFF = {
  localEnabled: false,
  localAvailable: false,
  externalEnabled: false,
  externalBaseUrl: null,
  externalModel: null,
  receiptImagesEnabled: false,
  apiKeySet: false,
};

describe("AI での推定（自動。H:§4.3）", () => {
  it("「AI で推定」のボタンも、AI に回す明細の件数の表示もない", async () => {
    mockApi({ ...candidatesRoute([]) });
    renderStatements();
    await screen.findByRole("table", { name: "未処理の明細" });
    expect(screen.queryByRole("button", { name: "AI で推定" })).not.toBeInTheDocument();
    expect(screen.queryByText(/AI に回す明細/)).not.toBeInTheDocument();
  });

  it("候補の作り直しの後、needsAi を 10 件ずつ順に送り、進みを出し、終わったら一覧を読み直す", async () => {
    const needsAi = ids(25);
    let release: (reply: ApiReply) => void = () => {};
    let n = 0;
    const all = mockApi({
      ...candidatesRoute(needsAi),
      [`POST ${BASE}/statements/infer`]: (call) => {
        const batch = (call.body as { statementIds: string[] }).statementIds;
        n += 1;
        // 2 回目は止めて、途中の進みを見る
        if (n === 2) {
          return new Promise<ApiReply>((resolve) => {
            release = () => resolve(inferResponse(batch));
          });
        }
        return inferResponse(batch);
      },
    });
    renderStatements();

    const status = await screen.findByText(/AI で推定 10 \/ 25 件/);
    expect(status).toBeInTheDocument();
    const listReads = calls(all, "GET", "/statements").length;

    release(inferResponse([]));
    await waitFor(() => expect(screen.getByText(/AI で推定 25 \/ 25 件/)).toBeInTheDocument());
    expect(inferBodies(all)).toEqual([
      needsAi.slice(0, 10),
      needsAi.slice(10, 20),
      needsAi.slice(20),
    ]);
    await waitFor(() => expect(calls(all, "GET", "/statements").length).toBeGreaterThan(listReads));
    // 仕訳は変わらない（承認の API は呼ばない）
    expect(calls(all, "POST", "/statements/approve-bulk")).toHaveLength(0);
    // 候補の作り直しも 1 回だけ
    expect(calls(all, "POST", "/statements/candidates")).toHaveLength(1);
  });

  it("AI に回す明細がなければ、推定を呼ばない", async () => {
    const all = mockApi({ ...candidatesRoute([]) });
    renderStatements();
    await waitFor(() => expect(calls(all, "POST", "/statements/candidates")).toHaveLength(1));
    await screen.findByRole("table", { name: "未処理の明細" });
    expect(calls(all, "POST", "/statements/infer")).toHaveLength(0);
  });

  it("AI の設定が端末内も外部も無効なら、推定を呼ばない", async () => {
    const all = mockApi({
      ...candidatesRoute(ids(3)),
      "GET /api/settings/ai": () => ok(AI_OFF),
    });
    renderStatements();
    await waitFor(() => expect(calls(all, "POST", "/statements/candidates")).toHaveLength(1));
    await screen.findByRole("table", { name: "未処理の明細" });
    await waitFor(() => expect(calls(all, "GET", "/statements").length).toBeGreaterThan(1));
    expect(calls(all, "POST", "/statements/infer")).toHaveLength(0);
  });

  it("途中で失敗したら、そこで止めて理由と済んだ件数を示す（済んだ分は残る）", async () => {
    const needsAi = ids(15);
    let n = 0;
    const all = mockApi({
      ...candidatesRoute(needsAi),
      [`POST ${BASE}/statements/infer`]: (call) => {
        n += 1;
        return n === 1
          ? inferResponse((call.body as { statementIds: string[] }).statementIds)
          : apiError(422, "AI_NOT_CONFIGURED", "推定に失敗しました");
      },
    });
    renderStatements();

    expect(await screen.findByRole("alert")).toHaveTextContent("推定に失敗しました");
    expect(screen.getByText(/AI で推定 10 \/ 15 件で止まりました/)).toBeInTheDocument();
    expect(inferBodies(all)).toHaveLength(2);
  });

  describe("外部の AI へ送ったことと、端末内の AI が使えないことの表示", () => {
    const EXTERNAL_NOTICE =
      "外部の AI へ内容を送りました（確信度がしきい値に届かなかった明細だけ）。";
    const LOCAL_NOTICE = "端末内の AI が使えません。設定を確かめてください。";
    const progressRegion = () => screen.findByRole("status", { name: "AI の推定の進捗" });

    const respond = (
      call: ApiCall,
      flags: { localAvailable: boolean; externalUsed: boolean },
    ): ApiReply =>
      ok({
        results: (call.body as { statementIds: string[] }).statementIds.map((statementId) => ({
          statementId,
          method: "external_ai",
          confidence: 80,
        })),
        ...flags,
      });

    it("externalUsed が真なら、進みの近くに外部へ送ったことを出し、終わった後も消さない", async () => {
      mockApi({
        ...candidatesRoute(ids(12)),
        [`POST ${BASE}/statements/infer`]: (call) =>
          respond(call, { localAvailable: true, externalUsed: true }),
      });
      renderStatements();

      await screen.findByText(/AI で推定 12 \/ 12 件/);
      const region = await progressRegion();
      expect(within(region).getByText(EXTERNAL_NOTICE, { exact: true })).toBeInTheDocument();
      expect(within(region).queryByText(LOCAL_NOTICE, { exact: true })).not.toBeInTheDocument();
      // 一覧の読み直しの後も残る
      await new Promise((r) => setTimeout(r, 50));
      expect(
        within(await progressRegion()).getByText(EXTERNAL_NOTICE, { exact: true }),
      ).toBeInTheDocument();
    });

    it("localAvailable が偽なら、端末内の AI が使えないことを出す", async () => {
      mockApi({
        ...candidatesRoute(ids(3)),
        [`POST ${BASE}/statements/infer`]: (call) =>
          respond(call, { localAvailable: false, externalUsed: false }),
      });
      renderStatements();

      await screen.findByText(/AI で推定 3 \/ 3 件/);
      const region = await progressRegion();
      expect(within(region).getByText(LOCAL_NOTICE, { exact: true })).toBeInTheDocument();
      expect(within(region).queryByText(EXTERNAL_NOTICE, { exact: true })).not.toBeInTheDocument();
    });

    it("端末内が使え、外部へ送っていなければ、どちらも出さない", async () => {
      mockApi({
        ...candidatesRoute(ids(3)),
        [`POST ${BASE}/statements/infer`]: (call) =>
          respond(call, { localAvailable: true, externalUsed: false }),
      });
      renderStatements();

      await screen.findByText(/AI で推定 3 \/ 3 件/);
      const region = await progressRegion();
      expect(within(region).queryByText(EXTERNAL_NOTICE, { exact: true })).not.toBeInTheDocument();
      expect(within(region).queryByText(LOCAL_NOTICE, { exact: true })).not.toBeInTheDocument();
    });
  });
});
