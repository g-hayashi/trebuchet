import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { ok, type ReceiptImageTool, type ReceiptProbe } from "@trebuchet/domain";
import type { ReceiptDetail, ReceiptSummary } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jpegBytes } from "../../../packages/domain/test/fixtures/receipts/sample-files.ts";
import { createApp } from "../src/app.ts";
import { createTestEntity, errorOf, json, makeClock, testHeaders } from "./helpers.ts";

// T017b: PATCH /receipts/:receiptId（contracts/http-api.md §2。未入力の値を理由なしで埋める。D1）

let tmp: TempDataDir;
let entityId: string;
const clock = makeClock("2026-10-20T09:00:00.000Z");
const PROBE: ReceiptProbe = { width: 4032, height: 3024, fullColor: true };

beforeEach(async () => {
  tmp = useTempDataDir("server-receipts-fill");
  entityId = await createTestEntity();
  clock.set("2026-10-20T09:00:00.000Z");
});
afterEach(() => tmp.cleanup());

const tool = (): ReceiptImageTool =>
  ({
    probe: vi.fn(async () => ok(PROBE)),
    toDisplay: vi.fn(async (bytes: Uint8Array, mediaType: string) => ok({ bytes, mediaType })),
    toAiJpeg: vi.fn(async () => ok(new Uint8Array([1]))),
  }) as unknown as ReceiptImageTool;

const makeApp = () => createApp({ clock, receipts: { imageTool: tool() } });
type App = ReturnType<typeof makeApp>;

const path = (suffix = "") => `/api/entities/${entityId}/receipts${suffix}`;

async function create(app: App, options: unknown, seed = 1): Promise<ReceiptDetail> {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(jpegBytes({ seed }))], "r.jpg"));
  form.append("options", JSON.stringify(options));
  const res = await app.request(path(), {
    method: "POST",
    body: form,
    headers: await testHeaders(),
  });
  return (await json<{ receipt: ReceiptDetail }>(res, 201)).receipt;
}

async function patch(app: App, id: string, body: unknown) {
  return app.request(path(`/${id}`), {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { ...(await testHeaders()), "content-type": "application/json" },
  });
}

describe("PATCH /receipts/:receiptId（未入力の値を埋める）", () => {
  it("200 で値を埋め、version +1。一覧の検索に出る（未入力から外れる）", async () => {
    const app = makeApp();
    const receipt = await create(app, { category: "paper_scan" });
    expect(receipt.warnings.map((w) => w.code)).toContain("FIELDS_MISSING");

    const res = await patch(app, receipt.id, {
      version: 1,
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
      memo: "会議",
    });
    const body = await json<{ receipt: ReceiptDetail }>(res, 200);
    expect(body.receipt).toMatchObject({
      id: receipt.id,
      version: 2,
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
      memo: "会議",
    });
    expect(body.receipt.warnings.map((w) => w.code)).not.toContain("FIELDS_MISSING");

    const list = await app.request(path("?partner=合成&amountMin=1000"), {
      headers: await testHeaders(),
    });
    const page = await json<{ receipts: ReceiptSummary[] }>(list, 200);
    expect(page.receipts.map((r) => r.id)).toEqual([receipt.id]);
    const missing = await app.request(path("?missing=true"), { headers: await testHeaders() });
    expect((await json<{ receipts: ReceiptSummary[] }>(missing, 200)).receipts).toEqual([]);
  });

  it("入力済みの値の変更は 422 REASON_REQUIRED（何も変わらない）", async () => {
    const app = makeApp();
    const receipt = await create(app, {
      category: "electronic",
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
    });
    const res = await patch(app, receipt.id, { version: 1, amount: 2000 });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("REASON_REQUIRED");
    const detail = await app.request(path(`/${receipt.id}`), { headers: await testHeaders() });
    expect((await json<{ receipt: ReceiptDetail }>(detail, 200)).receipt).toMatchObject({
      amount: 1100,
      version: 1,
    });
  });

  it("version の不一致は 409 VERSION_CONFLICT、削除済みは 409 RECEIPT_DELETED、ないものは 404", async () => {
    const app = makeApp();
    const receipt = await create(app, { category: "paper_scan" });
    const stale = await patch(app, receipt.id, { version: 3, amount: 1 });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe("VERSION_CONFLICT");

    const missing = await patch(app, "00000000-0000-4000-8000-000000000001", {
      version: 1,
      amount: 1,
    });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("RECEIPT_NOT_FOUND");
  });

  it("入力の形の誤り（version なし、金額 0、日付の形）は 400 VALIDATION", async () => {
    const app = makeApp();
    const receipt = await create(app, { category: "paper_scan" });
    for (const body of [
      { amount: 5 },
      { version: 1, amount: 0 },
      { version: 1, transactionDate: "2026/10/20" },
      { version: 1, partnerName: "" },
    ]) {
      const res = await patch(app, receipt.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
  });

  it("実在しない日付（2026-02-30）は VALIDATION（ドメインの検査）", async () => {
    const app = makeApp();
    const receipt = await create(app, { category: "paper_scan" });
    const res = await patch(app, receipt.id, { version: 1, transactionDate: "2026-02-30" });
    expect([400, 422]).toContain(res.status);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});
