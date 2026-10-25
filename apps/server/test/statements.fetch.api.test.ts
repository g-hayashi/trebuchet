import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { PastedRow } from "@trebuchet/domain";
import { testClient } from "hono/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { MfmeFetchError, type MfmeFetcher, type MfmeRange } from "../src/lib/jobs.ts";
import {
  accountLookup,
  createTestEntity,
  createTestSession,
  errorOf,
  okBody,
  TEST_HOST,
  TEST_ORIGIN,
} from "./helpers.ts";

// 006 US4: contracts/http-api.md §3.4・§3.5 と §3.1・§3.2 の source.kind = "mfme_fetch"。
// 取得器は偽物（ブラウザを起動しない）。取得の結果は server のメモリにだけ置く

const NOW = "2026-10-31T03:00:00.000Z";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server-statements-fetch-api");
});
afterEach(() => tmp.cleanup());

const ROWS: PastedRow[] = [
  {
    accountName: "サンプル銀行",
    date: "2026-05-10",
    content: "ショップ001",
    amount: -1200,
    transferFlag: false,
  },
  {
    accountName: "サンプル銀行",
    date: "2026-05-11",
    content: "売上入金",
    amount: 3000,
    transferFlag: false,
    externalId: "ext-1",
  },
];

/** 完了を外から決められる偽の取得器 */
function controlledFetcher() {
  const calls: MfmeRange[] = [];
  let release: (rows: PastedRow[]) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  let report: (status: "waiting_login" | "running", progress?: unknown) => void = () => {};
  const fetcher: MfmeFetcher = {
    fetch: (range, onStatus) => {
      calls.push(range);
      report = onStatus;
      onStatus("waiting_login");
      return new Promise<PastedRow[]>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
    },
  };
  return {
    fetcher,
    calls,
    resolve: (rows: PastedRow[] = ROWS) => release(rows),
    reject: (e: unknown) => fail(e),
    report: (...args: Parameters<typeof report>) => report(...args),
  };
}

async function setup(fetcher: MfmeFetcher) {
  const entityId = await createTestEntity();
  const session = await createTestSession({ now: NOW });
  const client = testClient(
    createApp({ clock: { now: () => NOW }, mfme: { fetcher } }),
    undefined,
    undefined,
    { headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie } },
  );
  const e = client.api.entities[":entityId"];
  const param = { entityId };
  const accountId = await accountLookup(entityId);
  const range = { from: "2026-05", to: "2026-05" };
  const start = (json = range, p = param) => e.statements.mfme.fetch.$post({ param: p, json });
  const job = (jobId: string, p = param) => e.jobs[":jobId"].$get({ param: { ...p, jobId } });
  const statusOf = async (jobId: string) => (await okBody(await job(jobId))).status;
  const waitFor = async (jobId: string, status: string) =>
    vi.waitFor(async () => expect(await statusOf(jobId)).toBe(status));
  const source = (jobId: string) => ({ kind: "mfme_fetch" as const, jobId });
  const preview = (jobId: string) =>
    e.statements.imports.preview.$post({ param, json: { source: source(jobId) } });
  const commit = (jobId: string, inputSha256: string, countNew: number) =>
    e.statements.imports.$post({
      param,
      json: { source: source(jobId), expected: { inputSha256, countNew } },
    });
  const mapBank = async () => {
    const res = await e["statement-accounts"][":name"].$put({
      param: { ...param, name: "サンプル銀行" },
      json: { usage: "business", kind: "bank", accountId: accountId("普通預金") },
    });
    expect(res.status).toBe(200);
  };
  return { e, param, range, start, job, waitFor, preview, commit, mapBank, source };
}

describe("取得の開始と状態（§3.4・§3.5）", () => {
  it("202 { jobId }。取得器に期間を渡し、状態は waiting_login → running → done と進む", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    const res = await t.start();
    expect(res.status).toBe(202);
    const { jobId } = await okBody(res);
    expect(f.calls).toEqual([{ from: "2026-05", to: "2026-05" }]);

    expect(await okBody(await t.job(jobId))).toEqual({ status: "waiting_login" });
    f.report("running", { month: "2026-05" });
    expect(await okBody(await t.job(jobId))).toEqual({
      status: "running",
      progress: { month: "2026-05" },
    });
    f.resolve();
    await t.waitFor(jobId, "done");
    expect((await okBody(await t.job(jobId))).error).toBeUndefined();
  });

  it("動いている間に 2 つ目を始めると 409 JOB_RUNNING。終われば次を始められる", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    const { jobId } = await okBody(await t.start());
    const second = await t.start();
    expect(second.status).toBe(409);
    expect((await errorOf(second)).code).toBe("JOB_RUNNING");
    expect(f.calls).toHaveLength(1);

    f.resolve();
    await t.waitFor(jobId, "done");
    const third = await t.start();
    expect(third.status).toBe(202);
    expect((await okBody(third)).jobId).not.toBe(jobId);
  });

  it("失敗した後も次を始められる", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    const { jobId } = await okBody(await t.start());
    f.reject(new MfmeFetchError("MFME_WINDOW_CLOSED", "ブラウザが閉じられました"));
    await t.waitFor(jobId, "failed");
    expect((await t.start()).status).toBe(202);
  });

  it("期間の形が違う・開始月が終了月より後なら 400 VALIDATION。取得器は呼ばれない", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    const reversed = await t.start({ from: "2026-06", to: "2026-05" });
    expect(reversed.status).toBe(400);
    expect((await errorOf(reversed)).code).toBe("VALIDATION");
    const bad = await t.start({ from: "2026/05", to: "2026-05" });
    expect(bad.status).toBe(400);
    expect(f.calls).toEqual([]);
  });

  it("知らないジョブは 404 JOB_NOT_FOUND", async () => {
    const t = await setup(controlledFetcher().fetcher);
    const res = await t.job("00000000-0000-7000-8000-000000000001");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("JOB_NOT_FOUND");
  });

  it("別の事業体のジョブは見えない（404 JOB_NOT_FOUND）。プレビューにも使えない", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    const { jobId } = await okBody(await t.start());
    f.resolve();
    await t.waitFor(jobId, "done");
    const other = await createTestEntity("別の事業");
    const otherParam = { entityId: other };
    const seen = await t.job(jobId, otherParam);
    expect(seen.status).toBe(404);
    expect((await errorOf(seen)).code).toBe("JOB_NOT_FOUND");
    const res = await t.e.statements.imports.preview.$post({
      param: otherParam,
      json: { source: t.source(jobId) },
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("JOB_NOT_FOUND");
  });
});

describe("成功: 取得した行のプレビューと確定（§3.1・§3.2）", () => {
  it("プレビューは貼り付けと同じ形で、確定すると取込の回の起源は mfme_fetch", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    await t.mapBank();
    const { jobId } = await okBody(await t.start());
    f.resolve();
    await t.waitFor(jobId, "done");

    const res = await t.preview(jobId);
    expect(res.status).toBe(200);
    const p = await okBody(res);
    expect(p.countNew).toBe(2);
    expect(p.period).toEqual({ from: "2026-05-10", to: "2026-05-11" });
    expect(p.totals).toEqual({ inflow: 3000, outflow: 1200 });
    expect(p.unmappedAccounts).toEqual([]);
    expect(p.unreadable).toEqual([]);
    expect(p.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    // 同じジョブなら同じハッシュ
    expect((await okBody(await t.preview(jobId))).inputSha256).toBe(p.inputSha256);

    // プレビューは何も保存しない
    expect((await okBody(await t.e.statements.imports.$get({ param: t.param }))).batches).toEqual(
      [],
    );

    const committed = await t.commit(jobId, p.inputSha256, p.countNew);
    expect(committed.status).toBe(201);
    const body = await okBody(committed);
    expect(body.added).toBe(2);
    expect(body.batch.origin).toBe("mfme_fetch");
    const list = await okBody(await t.e.statements.$get({ param: t.param, query: {} }));
    expect(list.statements).toHaveLength(2);

    // 再取込（同じジョブ）は新規 0 件
    expect((await okBody(await t.preview(jobId))).countNew).toBe(0);
  });

  it("入力のハッシュが違えば確定は 409 STATEMENT_PLAN_CHANGED", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    await t.mapBank();
    const { jobId } = await okBody(await t.start());
    f.resolve();
    await t.waitFor(jobId, "done");
    const res = await t.commit(jobId, "0".repeat(64), 2);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("STATEMENT_PLAN_CHANGED");
  });

  it("未対応の口座があるときの確定は 422 STATEMENT_ACCOUNT_UNMAPPED", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    const { jobId } = await okBody(await t.start());
    f.resolve();
    await t.waitFor(jobId, "done");
    const p = await okBody(await t.preview(jobId));
    expect(p.unmappedAccounts).toEqual(["サンプル銀行"]);
    const res = await t.commit(jobId, p.inputSha256, p.countNew);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("STATEMENT_ACCOUNT_UNMAPPED");
  });

  it("知らないジョブの ID は 404 JOB_NOT_FOUND（プレビューも確定も）", async () => {
    const t = await setup(controlledFetcher().fetcher);
    const unknown = "00000000-0000-7000-8000-000000000002";
    const p = await t.preview(unknown);
    expect(p.status).toBe(404);
    expect((await errorOf(p)).code).toBe("JOB_NOT_FOUND");
    const c = await t.commit(unknown, "0".repeat(64), 0);
    expect(c.status).toBe(404);
    expect((await errorOf(c)).code).toBe("JOB_NOT_FOUND");
  });
});

describe("失敗: 何も加えず、理由と失敗した口座を返す（FR-010）", () => {
  it("失敗の理由（code・message・failedAccounts）を返し、明細は 0 件のまま", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    await t.mapBank();
    const { jobId } = await okBody(await t.start());
    f.reject(new MfmeFetchError("MFME_DOM_CHANGED", "画面の形が想定と違います", ["サンプル銀行"]));
    await t.waitFor(jobId, "failed");
    expect((await okBody(await t.job(jobId))).error).toEqual({
      code: "MFME_DOM_CHANGED",
      message: "画面の形が想定と違います",
      failedAccounts: ["サンプル銀行"],
    });

    // 失敗したジョブの行は使えない。取込の回も明細も増えない
    const p = await t.preview(jobId);
    expect(p.status).toBe(400);
    expect((await errorOf(p)).code).toBe("VALIDATION");
    const c = await t.commit(jobId, "0".repeat(64), 0);
    expect(c.status).toBe(400);
    expect((await okBody(await t.e.statements.imports.$get({ param: t.param }))).batches).toEqual(
      [],
    );
    expect(
      (await okBody(await t.e.statements.$get({ param: t.param, query: {} }))).statements,
    ).toEqual([]);
  });

  it("想定外の例外は一般的な理由（MFME_FETCH_FAILED）にして、元のメッセージを出さない", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    const { jobId } = await okBody(await t.start());
    f.reject(new Error("secret page content: サンプル"));
    await t.waitFor(jobId, "failed");
    const { error } = await okBody(await t.job(jobId));
    expect(error?.code).toBe("MFME_FETCH_FAILED");
    expect(error?.message).not.toContain("secret");
    expect(error?.failedAccounts).toBeUndefined();
  });

  it("取得器が同期的に例外を投げても、ジョブは failed になる", async () => {
    const t = await setup({
      fetch: () => {
        throw new Error("boom");
      },
    });
    const { jobId } = await okBody(await t.start());
    await t.waitFor(jobId, "failed");
  });
});

describe("実行中のジョブの行は使えない", () => {
  it("完了前のプレビューは 400 VALIDATION", async () => {
    const f = controlledFetcher();
    const t = await setup(f.fetcher);
    const { jobId } = await okBody(await t.start());
    const res = await t.preview(jobId);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});
