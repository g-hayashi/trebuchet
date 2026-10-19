import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { ImportBatch, ImportBatchJournal } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import type { ErrorBody } from "./helpers.ts";

// T056: 取込の取消の API（contracts/http-api.md の 002）

let tmp: TempDataDir;
let entityId: string;

const JOURNAL = readFileSync(
  new URL("../../../packages/domain/test/fixtures/freee/journal-2025.csv", import.meta.url),
);
const SHA = createHash("sha256").update(JOURNAL).digest("hex");
const COUNT_NEW = 14;
const REASON = "取り込む年度を間違えた";

beforeEach(async () => {
  tmp = useTempDataDir("server-imports-void");
  const res = await app.request("/api/entities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "個人事業",
      kind: "individual",
      fiscalStartMonth: 1,
      firstFiscalYear: 2025,
    }),
  });
  if (res.status !== 201) throw new Error(`entity create failed: ${res.status}`);
  entityId = ((await res.json()) as { entity: { id: string } }).entity.id;
});
afterEach(() => tmp.cleanup());

const url = (path: string) => `/api/entities/${entityId}${path}`;
const get = (path: string) => app.request(url(path));
const sendJson = (method: "POST" | "PUT", path: string, body: unknown) =>
  app.request(url(path), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const errorOf = async (res: Response) => ((await res.json()) as ErrorBody).error;

async function json<T>(res: Response, status: number): Promise<T> {
  if (res.status !== status) {
    throw new Error(`expected ${status} but got ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function commit(): Promise<ImportBatch> {
  const form = new FormData();
  form.append("file", new File([JOURNAL], "journal-2025.csv", { type: "text/csv" }));
  form.append("options", "{}");
  form.append("expected", JSON.stringify({ fileSha256: SHA, countNew: COUNT_NEW }));
  const res = await app.request(url("/imports/freee/commit"), { method: "POST", body: form });
  return (await json<{ batch: ImportBatch }>(res, 201)).batch;
}

const voidBatch = (batchId: string, body: unknown = { reason: REASON }) =>
  sendJson("POST", `/imports/${batchId}/void`, body);

type JournalRow = {
  id: string;
  version: number;
  status: string;
  date: string;
  memo: string | null;
  lines: { side: "debit" | "credit"; accountId: string; amount: number }[];
};

const journalsOf = async () =>
  (await json<{ journals: JournalRow[] }>(await get("/journals?limit=100&includeVoided=true"), 200))
    .journals;

/** 取込の後に1件を訂正する（version が 2 になる） */
async function correctOne(): Promise<string> {
  const target = (await journalsOf())[0];
  if (target === undefined) throw new Error("仕訳がない");
  const res = await sendJson("PUT", `/journals/${target.id}`, {
    date: target.date,
    memo: "訂正後",
    lines: target.lines.map(({ side, accountId, amount }) => ({ side, accountId, amount })),
    reason: "メモの追記",
    version: target.version,
  });
  await json(res, 200);
  return target.id;
}

describe("POST /imports/:batchId/void", () => {
  it("200 { batch, voidedCount }。取込の仕訳がすべて取消され、回は voided になる", async () => {
    const batch = await commit();

    const body = await json<{ batch: ImportBatch; voidedCount: number }>(
      await voidBatch(batch.id),
      200,
    );

    expect(body.voidedCount).toBe(COUNT_NEW);
    expect(body.batch).toMatchObject({ id: batch.id, status: "voided", voidReason: REASON });
    expect(body.batch.voidedAt).toEqual(expect.any(String));

    const detail = await json<{ batch: ImportBatch; journals: ImportBatchJournal[] }>(
      await get(`/imports/${batch.id}`),
      200,
    );
    expect(detail.batch).toEqual(body.batch);
    expect(detail.journals).toHaveLength(COUNT_NEW);
    expect(detail.journals.every((j) => j.status === "voided")).toBe(true);
    expect((await journalsOf()).every((j) => j.status === "voided")).toBe(true);
  });

  it("取消済みの取込をもう一度取り消す → 409 IMPORT_BATCH_VOIDED", async () => {
    const batch = await commit();
    await json(await voidBatch(batch.id), 200);

    const res = await voidBatch(batch.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({
      code: "IMPORT_BATCH_VOIDED",
      details: { batchId: batch.id },
    });
  });

  it("ない取込の回 → 404 IMPORT_BATCH_NOT_FOUND", async () => {
    const res = await voidBatch("0190a000-0000-7000-8000-000000000000");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("IMPORT_BATCH_NOT_FOUND");
  });

  it.each([
    ["空欄", { reason: "" }],
    ["空白だけ", { reason: "  　 " }],
  ])("理由が%s → 422 REASON_REQUIRED で、何も取り消さない", async (_, body) => {
    const batch = await commit();
    const res = await voidBatch(batch.id, body);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("REASON_REQUIRED");
    expect((await journalsOf()).every((j) => j.status === "active")).toBe(true);
  });

  it("理由の判定は取込の回の判定より先（ない回でも REASON_REQUIRED）", async () => {
    const res = await voidBatch("0190a000-0000-7000-8000-000000000000", { reason: " " });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("REASON_REQUIRED");
  });

  it.each([
    ["reason がない", {}],
    ["reason が文字列でない", { reason: 1 }],
    ["confirmCorrected が真偽値でない", { reason: REASON, confirmCorrected: "yes" }],
  ])("入力の形が違う（%s）→ 400 VALIDATION", async (_, body) => {
    const batch = await commit();
    const res = await voidBatch(batch.id, body);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("締め済みの年度を含む → 409 PERIOD_CLOSED（details.fiscalYears）で、何も取り消さない", async () => {
    const batch = await commit();
    await json(await app.request(url("/fiscal-periods/2025/close"), { method: "POST" }), 200);

    const res = await voidBatch(batch.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({
      code: "PERIOD_CLOSED",
      details: { fiscalYears: [2025] },
    });
    expect((await journalsOf()).every((j) => j.status === "active")).toBe(true);
    const { batch: after } = await json<{ batch: ImportBatch }>(
      await get(`/imports/${batch.id}`),
      200,
    );
    expect(after.status).toBe("active");
  });

  it("締めを解除すれば取り消せる", async () => {
    const batch = await commit();
    await json(await app.request(url("/fiscal-periods/2025/close"), { method: "POST" }), 200);
    await json(
      await sendJson("POST", "/fiscal-periods/2025/reopen", { reason: "取込をやり直す" }),
      200,
    );
    const body = await json<{ voidedCount: number }>(await voidBatch(batch.id), 200);
    expect(body.voidedCount).toBe(COUNT_NEW);
  });

  it("取込の後に訂正された仕訳がある → 409 CORRECTED_JOURNALS（details.count・journalIds）で、何も取り消さない", async () => {
    const batch = await commit();
    const correctedId = await correctOne();

    for (const body of [{ reason: REASON }, { reason: REASON, confirmCorrected: false }]) {
      const res = await voidBatch(batch.id, body);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toMatchObject({
        code: "CORRECTED_JOURNALS",
        details: { count: 1, journalIds: [correctedId] },
      });
    }
    expect((await journalsOf()).every((j) => j.status === "active")).toBe(true);
  });

  it("confirmCorrected: true なら、訂正された仕訳も含めて取り消す", async () => {
    const batch = await commit();
    await correctOne();

    const body = await json<{ batch: ImportBatch; voidedCount: number }>(
      await voidBatch(batch.id, { reason: REASON, confirmCorrected: true }),
      200,
    );
    expect(body.voidedCount).toBe(COUNT_NEW);
    expect(body.batch.status).toBe("voided");
    expect((await journalsOf()).every((j) => j.status === "voided")).toBe(true);
  });

  it("締め済みと訂正済みが重なると PERIOD_CLOSED が先", async () => {
    const batch = await commit();
    await correctOne();
    await json(await app.request(url("/fiscal-periods/2025/close"), { method: "POST" }), 200);

    const res = await voidBatch(batch.id, { reason: REASON, confirmCorrected: true });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("PERIOD_CLOSED");
  });
});
