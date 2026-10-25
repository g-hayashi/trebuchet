import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { domainError, err, ok, type PastedRow } from "@trebuchet/domain";
import { testClient } from "hono/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import type { FmServer } from "../src/lib/fm-server.ts";
import { createJobStore, type MfmeFetcher } from "../src/lib/jobs.ts";
import { createMemorySecretStore } from "../src/lib/keychain.ts";
import {
  accountLookup,
  createTestEntity,
  createTestSession,
  errorOf,
  okBody,
  TEST_HOST,
  TEST_ORIGIN,
} from "./helpers.ts";

// 006 US5: contracts/http-api.md §6.1・§6.2（評価のジョブと一覧）。偽の fetch・fm で、評価の実行 → ジョブの状態 →
// 保存した結果の一覧までを通す。評価は候補・ルール・仕訳を書き換えない

const NOW = "2026-10-31T03:00:00.000Z";
const BANK = "サンプル銀行";
const SPLIT = "2026-03-01";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server-statements-evals-api");
});
afterEach(() => tmp.cleanup());

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

async function setup(options: { fmAvailable?: boolean; hold?: Promise<void> } = {}) {
  const entityId = await createTestEntity();
  const accountId = await accountLookup(entityId);
  const session = await createTestSession({ now: NOW });
  const headers = { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie };
  const plain = testClient(createApp(), undefined, undefined, { headers });
  const supplies =
    (
      await (await plain.api.entities[":entityId"].accounts.$get({ param: { entityId } })).json()
    ).accounts.find((a) => a.name === "消耗品費")?.code ?? "";

  const calls: { url: string; body: string }[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    await options.hold;
    return completion(
      JSON.stringify({
        accountCode: supplies,
        taxCategory: "PURCHASE_10",
        purpose: "business",
        confidence: 82,
        reason: "文房具の購入",
      }),
    );
  });
  const fm: FmServer = {
    available: async () => options.fmAvailable ?? false,
    ensureStarted: async () => (options.fmAvailable ? "http://127.0.0.1:18790" : undefined),
    stop: () => {},
  };
  const holdFetcher = { release: () => {} };
  const mfmeFetcher: MfmeFetcher = {
    fetch: () =>
      new Promise<PastedRow[]>((resolve) => {
        holdFetcher.release = () => resolve([]);
      }),
  };
  const client = testClient(
    createApp({
      clock: { now: () => NOW },
      ai: { fetch: fetchFn as unknown as typeof fetch, secrets: createMemorySecretStore(), fm },
      mfme: { fetcher: mfmeFetcher },
    }),
    undefined,
    undefined,
    { headers },
  );
  const e = client.api.entities[":entityId"];
  const param = { entityId };

  const mapped = await e["statement-accounts"][":name"].$put({
    param: { ...param, name: BANK },
    json: { usage: "business", kind: "bank", accountId: accountId("普通預金") },
  });
  expect(mapped.status).toBe(200);

  const HEADER = ["日付", "内容", "金額（円）", "保有金融機関", "メモ", "振替"].join("\t");
  const importLines = async (...lines: string[]) => {
    const source = { kind: "paste" as const, text: [HEADER, ...lines].join("\n"), year: 2026 };
    const preview = await okBody(
      await e.statements.imports.preview.$post({ param, json: { source } }),
    );
    const res = await e.statements.imports.$post({
      param,
      json: { source, expected: { inputSha256: preview.inputSha256, countNew: preview.countNew } },
    });
    expect(res.status).toBe(201);
  };
  const list = async () => (await okBody(await e.statements.$get({ param, query: {} }))).statements;
  const approveAll = async () => {
    for (const s of await list()) {
      const amount = Math.abs(s.amount);
      const res = await e.statements[":statementId"].approve.$post({
        param: { ...param, statementId: s.id },
        json: {
          draft: {
            date: s.date,
            memo: s.content,
            lines: [
              { side: "debit", accountId: accountId("消耗品費"), amount },
              { side: "credit", accountId: accountId("普通預金"), amount },
            ],
          },
        },
      });
      expect(res.status).toBe(201);
    }
  };
  // 基準日（SPLIT）の前に 1 件（ルールを作る）、後に 2 件（ルールが当たる 1 件と、当たらない 1 件）
  await importLines(
    ["02/10(火)", "ショップ001", "-1,200", BANK, "", 0].join("\t"),
    ["04/10(金)", "ショップ002", "-1,300", BANK, "", 0].join("\t"),
    ["04/11(土)", "別の店", "-1,400", BANK, "", 0].join("\t"),
  );
  await approveAll();

  const start = (json: Record<string, unknown> = { splitDate: SPLIT }, p = param) =>
    e.statements.evals.$post({ param: p, json: json as never });
  const runs = async (p = param) =>
    (await okBody(await e.statements.evals.$get({ param: p }))).runs;
  const job = (jobId: string, p = param) => e.jobs[":jobId"].$get({ param: { ...p, jobId } });
  const waitFor = (jobId: string, status: string) =>
    vi.waitFor(async () => expect((await okBody(await job(jobId))).status).toBe(status));
  const snapshot = async () => ({
    statements: await list(),
    journals: (await okBody(await e.journals.$get({ param, query: {} }))).journals,
    rules: (await okBody(await e["inference-rules"].$get({ param, query: {} }))).rules,
  });
  return { e, param, calls, start, runs, job, waitFor, snapshot, holdFetcher, client };
}

describe("評価の開始と結果（§6.1・§6.2）", () => {
  it("まだ実行していなければ { runs: [] }。実行すると 202 { jobId } で、done になった後に結果が一覧に出る", async () => {
    const t = await setup();
    expect(await t.runs()).toEqual([]);
    const res = await t.start();
    expect(res.status).toBe(202);
    const { jobId } = await okBody(res);
    await t.waitFor(jobId, "done");
    const runs = await t.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      splitDate: SPLIT,
      includeAi: false,
      sampleCount: 2,
      models: [],
    });
    expect(runs[0]?.result.methods).toEqual([
      { method: "rule", count: 1, matchRate: 1000 },
      { method: "none", count: 1, matchRate: 0 },
    ]);
    expect(runs[0]?.result.fields.counterAccount).toBe(500);
    expect(t.calls).toHaveLength(0);
  });

  it("基準日を省略すると今年（時計の年）の 1 月 1 日。新しい順に並ぶ", async () => {
    const t = await setup();
    const first = await okBody(await t.start({}));
    await t.waitFor(first.jobId, "done");
    const second = await okBody(await t.start({ splitDate: SPLIT }));
    await t.waitFor(second.jobId, "done");
    const runs = await t.runs();
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.splitDate).sort()).toEqual(["2026-01-01", SPLIT]);
    // 同じ時刻なら ID の降順（後から作った方が新しい）
    expect(runs[0]?.splitDate).toBe(SPLIT);
  });

  it("includeAi: ルールのない明細だけ端末内の AI（fm）を呼び、方法と使ったモデルを記録する。マスクした内容だけを送る", async () => {
    const t = await setup({ fmAvailable: true });
    const { jobId } = await okBody(await t.start({ splitDate: SPLIT, includeAi: true }));
    await t.waitFor(jobId, "done");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toBe("http://127.0.0.1:18790/v1/chat/completions");
    const run = (await t.runs())[0];
    expect(run).toMatchObject({ includeAi: true, models: ["fm"] });
    expect(run?.result.methods.map((m) => [m.method, m.count])).toEqual([
      ["rule", 1],
      ["local_ai", 1],
    ]);
  });

  it("includeAi でも、端末内・外部のどちらも使えなければ AI を呼ばず none（外部は有効なときだけ）", async () => {
    const t = await setup({ fmAvailable: false });
    const { jobId } = await okBody(await t.start({ splitDate: SPLIT, includeAi: true }));
    await t.waitFor(jobId, "done");
    expect(t.calls).toHaveLength(0);
    const run = (await t.runs())[0];
    expect(run?.models).toEqual([]);
    expect(run?.result.methods.map((m) => m.method)).toEqual(["rule", "none"]);
  });

  it("候補・ルール・仕訳を書き換えない", async () => {
    const t = await setup({ fmAvailable: true });
    const before = await t.snapshot();
    const { jobId } = await okBody(await t.start({ splitDate: SPLIT, includeAi: true }));
    await t.waitFor(jobId, "done");
    expect(await t.snapshot()).toEqual(before);
  });

  it("基準日の形が違えば 400 VALIDATION（ジョブは始まらない）", async () => {
    const t = await setup();
    const res = await t.start({ splitDate: "2026/03/01" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
    expect(await t.runs()).toEqual([]);
  });
});

describe("暦にない基準日", () => {
  it("400 VALIDATION（ジョブは始まらない）", async () => {
    const t = await setup();
    const res = await t.start({ splitDate: "2026-02-30" });
    expect(res.status).toBe(400);
    expect(await t.runs()).toEqual([]);
  });
});

describe("JobStore.startTask（失敗の扱い）", () => {
  it("失敗の Result はそのエラーコード、例外は EVAL_FAILED（元のメッセージは出さない）で failed になり、次を始められる", async () => {
    const jobs = createJobStore();
    const failedResult = jobs.startTask("e1", async () =>
      err(domainError("VALIDATION", "入力が違う")),
    );
    await vi.waitFor(() =>
      expect(jobs.view("e1", failedResult?.jobId ?? "")?.status).toBe("failed"),
    );
    expect(jobs.view("e1", failedResult?.jobId ?? "")?.error).toEqual({
      code: "VALIDATION",
      message: "入力が違う",
    });

    const thrown = jobs.startTask("e1", async () => {
      throw new Error("内部の詳細 /secret/path");
    });
    await vi.waitFor(() => expect(jobs.view("e1", thrown?.jobId ?? "")?.status).toBe("failed"));
    expect(jobs.view("e1", thrown?.jobId ?? "")?.error).toEqual({
      code: "EVAL_FAILED",
      message: "評価に失敗しました",
    });

    const done = jobs.startTask("e1", async () => ok(1));
    expect(done).toBeDefined();
    await vi.waitFor(() => expect(jobs.view("e1", done?.jobId ?? "")?.status).toBe("done"));
  });
});

describe("ジョブの規則（§3）", () => {
  it("動いている間に 2 つ目を始めると 409 JOB_RUNNING。MF ME の取得のジョブとも同時に動かない。終われば始められる", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = await setup({ fmAvailable: true, hold });
    const { jobId } = await okBody(await t.start({ splitDate: SPLIT, includeAi: true }));
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(await okBody(await t.job(jobId))).toEqual({ status: "running" });

    const second = await t.start();
    expect(second.status).toBe(409);
    expect((await errorOf(second)).code).toBe("JOB_RUNNING");
    const fetchJob = await t.e.statements.mfme.fetch.$post({
      param: t.param,
      json: { from: "2026-05", to: "2026-05" },
    });
    expect(fetchJob.status).toBe(409);

    release();
    await t.waitFor(jobId, "done");
    expect((await t.start()).status).toBe(202);
  });

  it("評価のジョブが動いている間に MF ME の取得を始めても 409。取得のジョブが動いている間は評価も 409", async () => {
    const t = await setup();
    const started = await t.e.statements.mfme.fetch.$post({
      param: t.param,
      json: { from: "2026-05", to: "2026-05" },
    });
    expect(started.status).toBe(202);
    const res = await t.start();
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("JOB_RUNNING");
    t.holdFetcher.release();
  });

  it("別の事業体からは評価のジョブが見えない（404 JOB_NOT_FOUND）。結果も事業体ごと", async () => {
    const t = await setup();
    const { jobId } = await okBody(await t.start());
    await t.waitFor(jobId, "done");
    const other = await createTestEntity("別の事業");
    const otherParam = { entityId: other };
    const seen = await t.job(jobId, otherParam);
    expect(seen.status).toBe(404);
    expect((await errorOf(seen)).code).toBe("JOB_NOT_FOUND");
    expect(await t.runs(otherParam)).toEqual([]);
    expect(await t.runs()).toHaveLength(1);
  });
});
