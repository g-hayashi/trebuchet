import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { ok, type ReceiptImageTool } from "@trebuchet/domain";
import type { ReceiptDetail, ReceiptReadingView } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jpegBytes } from "../../../packages/domain/test/fixtures/receipts/sample-files.ts";
import { createApp } from "../src/app.ts";
import { createMemorySecretStore } from "../src/lib/keychain.ts";
import {
  accountLookup,
  createTestEntity,
  errorOf,
  json,
  jsonRequest,
  makeClock,
  testHeaders,
} from "./helpers.ts";

// T034: POST /receipts/:receiptId/readings（contracts/http-api.md §5、research R13・R14）。
// 外部の AI は偽の fetch（実際のネットワークには出ない）。画像の変換は偽の ReceiptImageTool（sips を呼ばない）。
// 失敗（時間切れ・HTTP のエラー・形の不一致）は HTTP のエラーにせず 201 で記録の status・errorCode を返す

let tmp: TempDataDir;
let entityId: string;
let acc: (name: string) => string;
const clock = makeClock();
const KEY = "sk-live-receipt-secret-0123456789";
const PARTNER = "合成の店ABC";
const MEMO = "秘密のメモXYZ";

beforeEach(async () => {
  tmp = useTempDataDir("server-receipt-reading-api");
  entityId = await createTestEntity();
  acc = await accountLookup(entityId);
  clock.set("2026-10-20T09:00:00.000Z");
});
afterEach(() => tmp.cleanup());

const AI_JPEG = jpegBytes({ seed: 99 });

const tool = (): ReceiptImageTool =>
  ({
    probe: vi.fn(async () => ok({ width: 4032, height: 3024, fullColor: true })),
    toDisplay: vi.fn(async (bytes: Uint8Array, mediaType: string) => ok({ bytes, mediaType })),
    toAiJpeg: vi.fn(async () => ok(AI_JPEG)),
  }) as unknown as ReceiptImageTool;

const completion = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

type Call = { url: string; init: RequestInit; body: ChatBody };
type Part = { type: string; text?: string; image_url?: { url: string; detail: string } };
type ChatBody = {
  model: string;
  messages: { role: string; content: string | Part[] }[];
  response_format: unknown;
};

function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({
      url: String(input),
      init: i,
      body: JSON.parse(String(i.body ?? "{}")) as ChatBody,
    });
    const next = queue.shift() ?? new Response("", { status: 500 });
    if (next instanceof Error) throw next;
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const READING_TEXT = JSON.stringify({
  transactionDate: "2026-10-20",
  amount: 1100,
  partnerName: "読み取った店",
  accountCode: null,
  taxCategory: "PURCHASE_10",
  confidence: 80,
  reason: "コンビニのレシート",
});

function makeApp(f: typeof fetch) {
  return createApp({
    clock,
    receipts: { imageTool: tool() },
    ai: { fetch: f, secrets: createMemorySecretStore() },
  });
}
type App = ReturnType<typeof makeApp>;

async function putSettings(app: App, over: Record<string, unknown> = {}) {
  return app.request("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify({
      localEnabled: false,
      externalEnabled: true,
      externalBaseUrl: "https://api.example.com",
      externalModel: "model-a",
      receiptImagesEnabled: true,
      apiKey: KEY,
      ...over,
    }),
    headers: { ...(await testHeaders()), "content-type": "application/json" },
  });
}

const path = (suffix = "") => `/api/entities/${entityId}/receipts${suffix}`;

async function create(app: App, options: unknown = { category: "paper_scan" }, seed = 1) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(jpegBytes({ seed }))], "元のファイル名.jpg"));
  form.append("options", JSON.stringify(options));
  const res = await app.request(path(), {
    method: "POST",
    body: form,
    headers: await testHeaders(),
  });
  return (await json<{ receipt: ReceiptDetail }>(res, 201)).receipt;
}

const post = (app: App, suffix: string, body?: unknown) =>
  jsonRequest(app, "POST", path(suffix), body);

async function readingsOf(app: App, id: string) {
  const res = await app.request(path(`/${id}`), { headers: await testHeaders() });
  return (await json<{ receipt: ReceiptDetail }>(res, 200)).receipt.readings;
}

describe("POST /receipts/:receiptId/readings（外部の AI で読む）", () => {
  it("201 { reading } で候補を返す。要求は image_url の部品と json_schema を持ち、取引先・メモ・ファイル名を含まない。証憑の値は変わらない", async () => {
    const { fn, calls } = fakeFetch(completion(READING_TEXT));
    const app = makeApp(fn);
    expect((await putSettings(app)).status).toBe(200);
    const receipt = await create(app, {
      category: "paper_scan",
      partnerName: PARTNER,
      memo: MEMO,
      amount: 5000,
    });

    const res = await post(app, `/${receipt.id}/readings`);
    const body = await json<{ reading: ReceiptReadingView }>(res, 201);
    expect(body.reading).toMatchObject({
      model: "model-a",
      status: "succeeded",
      errorCode: null,
      candidates: {
        transactionDate: "2026-10-20",
        amount: 1100,
        partnerName: "読み取った店",
        accountCode: null,
        taxCategory: "PURCHASE_10",
      },
      confidence: 80,
      reason: "コンビニのレシート",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://api.example.com/v1/chat/completions");
    expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call.body.model).toBe("model-a");
    const messages = call.body.messages;
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(typeof messages[0]?.content).toBe("string");
    const parts = messages[1]?.content as Part[];
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
    expect(parts[0]?.text).toContain("税区分のコード");
    const image = parts[1]?.image_url as { url: string; detail: string };
    expect(image.url).toBe(`data:image/jpeg;base64,${Buffer.from(AI_JPEG).toString("base64")}`);
    expect(image.detail).toBe("high");
    expect(call.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true },
    });
    // 取引先・メモ・元のファイル名・入力済みの金額・API キーは要求の本文に入らない（FR-015、INV-66）
    const sent = JSON.stringify(call.body);
    for (const secret of [PARTNER, MEMO, "元のファイル名", "5000", KEY]) {
      expect(sent).not.toContain(secret);
    }

    // 証憑の値は変わらない（INV-67）。読み取りの記録は 1 件
    const detail = await app.request(path(`/${receipt.id}`), { headers: await testHeaders() });
    const after = (await json<{ receipt: ReceiptDetail }>(detail, 200)).receipt;
    expect(after).toMatchObject({ version: 1, amount: 5000, partnerName: PARTNER, memo: MEMO });
    expect(after.readings).toHaveLength(1);
  });

  it("時間切れは 201 で status: timeout・errorCode: AI_TIMEOUT（記録が残る）", async () => {
    const { fn } = fakeFetch(new DOMException("timed out", "TimeoutError"));
    const app = makeApp(fn);
    await putSettings(app);
    const receipt = await create(app);

    const body = await json<{ reading: ReceiptReadingView }>(
      await post(app, `/${receipt.id}/readings`),
      201,
    );
    expect(body.reading).toMatchObject({ status: "timeout", errorCode: "AI_TIMEOUT" });
    expect(body.reading.candidates).toEqual({
      transactionDate: null,
      amount: null,
      partnerName: null,
      accountCode: null,
      taxCategory: null,
    });
    expect(await readingsOf(app, receipt.id)).toHaveLength(1);
  });

  it("HTTP のエラーと接続の失敗は 201 で status: failed・errorCode: AI_HTTP_ERROR（API キーを含まない）", async () => {
    const { fn } = fakeFetch(
      new Response(`bad ${KEY}`, { status: 500 }),
      new TypeError("fetch failed"),
    );
    const app = makeApp(fn);
    await putSettings(app);
    const receipt = await create(app);

    for (let i = 0; i < 2; i++) {
      const res = await post(app, `/${receipt.id}/readings`);
      expect(res.status).toBe(201);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(JSON.parse(text).reading).toMatchObject({
        status: "failed",
        errorCode: "AI_HTTP_ERROR",
      });
    }
    expect(await readingsOf(app, receipt.id)).toHaveLength(2);
  });

  it("JSON でない応答は 201 で status: invalid・errorCode: AI_INVALID_OUTPUT（候補なし）", async () => {
    const { fn } = fakeFetch(completion("これは JSON ではありません"));
    const app = makeApp(fn);
    await putSettings(app);
    const receipt = await create(app);

    const body = await json<{ reading: ReceiptReadingView }>(
      await post(app, `/${receipt.id}/readings`),
      201,
    );
    expect(body.reading).toMatchObject({ status: "invalid", errorCode: "AI_INVALID_OUTPUT" });
  });

  it("設定が無効（証憑の送信が偽、または外部が偽）なら 422 AI_NOT_CONFIGURED で、AI を呼ばず記録も残さない", async () => {
    const { fn, calls } = fakeFetch(completion(READING_TEXT));
    const app = makeApp(fn);
    const receipt = await create(app);

    // 既定（何も設定していない）
    const none = await post(app, `/${receipt.id}/readings`);
    expect(none.status).toBe(422);
    expect((await errorOf(none)).code).toBe("AI_NOT_CONFIGURED");

    // 外部は有効でも、証憑の画像の送信が偽
    await putSettings(app, { receiptImagesEnabled: false });
    const off = await post(app, `/${receipt.id}/readings`);
    expect(off.status).toBe(422);
    expect((await errorOf(off)).code).toBe("AI_NOT_CONFIGURED");

    // 外部を無効にすれば、証憑の画像の送信も偽
    await putSettings(app);
    await putSettings(app, { externalEnabled: false, receiptImagesEnabled: false });
    const external = await post(app, `/${receipt.id}/readings`);
    expect(external.status).toBe(422);

    expect(calls).toHaveLength(0);
    expect(await readingsOf(app, receipt.id)).toHaveLength(0);
  });

  it("証憑がなければ 404 RECEIPT_NOT_FOUND、削除済みなら 409 RECEIPT_DELETED（AI を呼ばない）", async () => {
    const { fn, calls } = fakeFetch(completion(READING_TEXT));
    const app = makeApp(fn);
    await putSettings(app);

    const missing = await post(app, "/00000000-0000-4000-8000-000000000001/readings");
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("RECEIPT_NOT_FOUND");

    const receipt = await create(app);
    const deleted = await post(app, `/${receipt.id}/delete`, { version: 1, reason: "誤り" });
    expect(deleted.status).toBe(200);
    const res = await post(app, `/${receipt.id}/readings`);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("RECEIPT_DELETED");
    expect(calls).toHaveLength(0);
  });
});

describe("POST /receipts/:receiptId/journal の readingId", () => {
  const journalBody = () => ({
    date: "2026-10-20",
    lines: [
      { side: "debit", accountId: acc("消耗品費"), amount: 1100 },
      { side: "credit", accountId: acc("現金"), amount: 1100 },
    ],
  });

  it("readingId は受け取って検査する: その証憑の読み取りなら 201、見つからなければ登録せず 400 VALIDATION", async () => {
    const { fn } = fakeFetch(completion(READING_TEXT));
    const app = makeApp(fn);
    await putSettings(app);
    const receipt = await create(app);
    const reading = (
      await json<{ reading: ReceiptReadingView }>(await post(app, `/${receipt.id}/readings`), 201)
    ).reading;

    const unknown = await post(app, `/${receipt.id}/journal`, {
      journal: journalBody(),
      readingId: "00000000-0000-4000-8000-000000000002",
    });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).code).toBe("VALIDATION");
    const list = await app.request(`/api/entities/${entityId}/journals`, {
      headers: await testHeaders(),
    });
    expect((await json<{ journals: unknown[] }>(list, 200)).journals).toHaveLength(0);

    const res = await post(app, `/${receipt.id}/journal`, {
      journal: journalBody(),
      readingId: reading.id,
    });
    expect(res.status).toBe(201);
  });
});
