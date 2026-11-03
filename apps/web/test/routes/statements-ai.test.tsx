import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as StatementsRoute } from "@/routes/e/$entityId/statements/index";
import { type ApiCall, type ApiReply, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 006 US5: 「AI で推定」（H:§4.3。needsAi を 10 件ずつ送る）。
// 推定は候補を変えるだけで、仕訳は変えない

const BASE = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const calls = (all: ApiCall[], method: string, path: string) =>
  all.filter((c) => c.method === method && c.path === `${BASE}${path}`);

const user = () => userEvent.setup();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+09:00"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- 明細の画面の「AI で推定」 ----

const ids = (count: number) => Array.from({ length: count }, (_, i) => uuid(i + 1));

const renderStatements = () =>
  renderRoute(StatementsRoute, { path: "/e/$entityId/statements/", url: "/e/e1/statements" });

const inferResponse = (
  statementIds: string[],
  over: { localAvailable?: boolean; externalUsed?: boolean; method?: string } = {},
) =>
  ok({
    results: statementIds.map((statementId) => ({
      statementId,
      method: over.method ?? "local_ai",
      confidence: 80,
    })),
    localAvailable: over.localAvailable ?? true,
    externalUsed: over.externalUsed ?? false,
  });

const inferBodies = (all: ApiCall[]) =>
  calls(all, "POST", "/statements/infer").map(
    (c) => (c.body as { statementIds: string[] }).statementIds,
  );

/** 「候補を作る」を押して needsAi を受け取った状態にする */
async function buildCandidates(needsAi: string[]) {
  const u = user();
  await u.click(await screen.findByRole("button", { name: "候補を作る" }));
  await screen.findByText(
    `候補を ${needsAi.length + 2} 件作りました（候補なし ${needsAi.length} 件）。`,
  );
  return u;
}

const candidatesRoute = (needsAi: string[]) => ({
  [`POST ${BASE}/statements/candidates`]: () => ok({ built: needsAi.length + 2, needsAi }),
});

describe("AI で推定（H:§4.3）", () => {
  it("候補を作る前は、推定の対象がないので押せない", async () => {
    mockApi({});
    renderStatements();
    const button = await screen.findByRole("button", { name: "AI で推定" });
    expect(button).toBeDisabled();
  });

  it("needsAi を 10 件ずつ順に送り、進捗を出し、終わったら一覧を読み直す", async () => {
    const needsAi = ids(25);
    let release: (reply: ApiReply) => void = () => {};
    let n = 0;
    const all = mockApi({
      ...candidatesRoute(needsAi),
      [`POST ${BASE}/statements/infer`]: (call) => {
        const batch = (call.body as { statementIds: string[] }).statementIds;
        n += 1;
        // 2 回目は止めて、途中の進捗を見る
        if (n === 2) {
          return new Promise<ApiReply>((resolve) => {
            release = () => resolve(inferResponse(batch));
          });
        }
        return inferResponse(batch);
      },
    });
    renderStatements();
    const u = await buildCandidates(needsAi);
    const listReads = calls(all, "GET", "/statements").length;

    await u.click(screen.getByRole("button", { name: "AI で推定" }));
    const status = await screen.findByRole("status", { name: "AI の推定の進捗" });
    await waitFor(() => expect(status).toHaveTextContent("10 / 25 件"));
    expect(screen.getByRole("button", { name: "AI で推定" })).toBeDisabled();

    release(inferResponse([]));
    await waitFor(() => expect(status).toHaveTextContent("25 件を推定しました"));
    expect(inferBodies(all)).toEqual([
      needsAi.slice(0, 10),
      needsAi.slice(10, 20),
      needsAi.slice(20),
    ]);
    await waitFor(() => expect(calls(all, "GET", "/statements").length).toBeGreaterThan(listReads));
    // 仕訳は変わらない（承認の API は呼ばない）
    expect(calls(all, "POST", "/statements/approve-bulk")).toHaveLength(0);
  });

  it("結果の方法ごとの件数を示し、外部の AI へ送ったことを知らせる", async () => {
    const needsAi = ids(3);
    mockApi({
      ...candidatesRoute(needsAi),
      [`POST ${BASE}/statements/infer`]: () =>
        ok({
          results: [
            { statementId: needsAi[0], method: "local_ai", confidence: 90 },
            { statementId: needsAi[1], method: "external_ai", confidence: 70 },
            { statementId: needsAi[2], method: "none", confidence: null },
          ],
          localAvailable: true,
          externalUsed: true,
        }),
    });
    renderStatements();
    const u = await buildCandidates(needsAi);
    await u.click(screen.getByRole("button", { name: "AI で推定" }));

    const status = await screen.findByRole("status", { name: "AI の推定の進捗" });
    await waitFor(() => expect(status).toHaveTextContent("3 件を推定しました"));
    expect(status).toHaveTextContent("端末内の AI 1 件");
    expect(status).toHaveTextContent("外部の AI 1 件");
    expect(status).toHaveTextContent("候補なし 1 件");
    expect(status).toHaveTextContent("外部の AI へ内容を送りました");
  });

  it("端末内の AI が使えないときは、その旨を知らせる", async () => {
    const needsAi = ids(1);
    mockApi({
      ...candidatesRoute(needsAi),
      [`POST ${BASE}/statements/infer`]: (call) =>
        inferResponse((call.body as { statementIds: string[] }).statementIds, {
          localAvailable: false,
          method: "none",
        }),
    });
    renderStatements();
    const u = await buildCandidates(needsAi);
    await u.click(screen.getByRole("button", { name: "AI で推定" }));
    const status = await screen.findByRole("status", { name: "AI の推定の進捗" });
    await waitFor(() => expect(status).toHaveTextContent("端末内の AI が使えません"));
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
    const u = await buildCandidates(needsAi);
    await u.click(screen.getByRole("button", { name: "AI で推定" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("推定に失敗しました");
    expect(screen.getByRole("status", { name: "AI の推定の進捗" })).toHaveTextContent("10 / 15 件");
    expect(inferBodies(all)).toHaveLength(2);
    // 再度押せる
    expect(screen.getByRole("button", { name: "AI で推定" })).toBeEnabled();
  });

  it("評価の画面への導線はない", async () => {
    mockApi({});
    renderStatements();
    await screen.findByRole("button", { name: "AI で推定" });
    expect(screen.queryByRole("link", { name: "推定の評価", exact: true })).not.toBeInTheDocument();
  });
});
