import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { ok, type ReceiptImageTool, type ReceiptProbe } from "@trebuchet/domain";
import type { ReceiptDetail, ReceiptHistoryEntry } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jpegBytes } from "../../../packages/domain/test/fixtures/receipts/sample-files.ts";
import { createApp } from "../src/app.ts";
import {
  accountLookup,
  createTestEntity,
  errorOf,
  json,
  jsonRequest,
  makeClock,
  testHeaders,
} from "./helpers.ts";

// T028: 訂正・差し替え・削除・履歴（contracts/http-api.md §1・§2、US5）。
// 画像の変換は偽の ReceiptImageTool。ファイルの暗号化は本物（一時のデータ場所とテスト用の DK）

let tmp: TempDataDir;
let entityId: string;
let acc: (name: string) => string;
const clock = makeClock();
const GOOD: ReceiptProbe = { width: 4032, height: 3024, fullColor: true };
let probeResult: ReceiptProbe = GOOD;

beforeEach(async () => {
  tmp = useTempDataDir("server-receipts-edit");
  entityId = await createTestEntity();
  acc = await accountLookup(entityId);
  clock.set("2026-10-20T09:00:00.000Z");
  probeResult = GOOD;
});
afterEach(() => tmp.cleanup());

const tool = (): ReceiptImageTool =>
  ({
    probe: vi.fn(async () => ok(probeResult)),
    toDisplay: vi.fn(async (bytes: Uint8Array, mediaType: string) => ok({ bytes, mediaType })),
    toAiJpeg: vi.fn(async () => ok(new Uint8Array([1]))),
  }) as unknown as ReceiptImageTool;

const makeApp = () => createApp({ clock, receipts: { imageTool: tool() } });
type App = ReturnType<typeof makeApp>;

const base = () => `/api/entities/${entityId}`;
const receiptPath = (id: string, suffix = "") => `${base()}/receipts/${id}${suffix}`;

const post = (app: App, path: string, body: unknown) => jsonRequest(app, "POST", path, body);
const patch = (app: App, id: string, body: unknown) =>
  jsonRequest(app, "PATCH", receiptPath(id), body);
const get = (app: App, path: string) => jsonRequest(app, "GET", path);

let seed = 100;
async function createReceipt(app: App, options: unknown = { category: "paper_scan" }) {
  seed += 1;
  const form = new FormData();
  form.append("file", new File([new Uint8Array(jpegBytes({ seed }))], "r.jpg"));
  form.append("options", JSON.stringify(options));
  const res = await app.request(`${base()}/receipts`, {
    method: "POST",
    body: form,
    headers: await testHeaders(),
  });
  return (await json<{ receipt: ReceiptDetail }>(res, 201)).receipt;
}

async function replace(
  app: App,
  id: string,
  options: unknown,
  bytes: Uint8Array = jpegBytes({ seed: ++seed }),
) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], "again.jpg"));
  form.append("options", JSON.stringify(options));
  return app.request(receiptPath(id, "/files"), {
    method: "POST",
    body: form,
    headers: await testHeaders(),
  });
}

async function createJournal(app: App, amount: number, date: string) {
  const res = await post(app, `${base()}/journals`, {
    date,
    lines: [
      { side: "debit", accountId: acc("消耗品費"), amount },
      { side: "credit", accountId: acc("現金"), amount },
    ],
  });
  return (await json<{ journal: { id: string } }>(res, 201)).journal;
}

const FILLED = {
  category: "electronic",
  transactionDate: "2026-10-20",
  amount: 1100,
  partnerName: "合成の店",
};

describe("PATCH /receipts/:receiptId（訂正）", () => {
  it("入力済みの値の変更は理由なしなら 422 REASON_REQUIRED、理由つきなら 200 で履歴に前後の値と理由が残る", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, FILLED);

    const noReason = await patch(app, receipt.id, { version: 1, amount: 2000 });
    expect(noReason.status).toBe(422);
    expect((await errorOf(noReason)).code).toBe("REASON_REQUIRED");

    const res = await patch(app, receipt.id, { version: 1, amount: 2000, reason: "金額の誤り" });
    const body = await json<{ receipt: ReceiptDetail }>(res, 200);
    expect(body.receipt).toMatchObject({ amount: 2000, version: 2 });

    const history = await json<{ history: ReceiptHistoryEntry[] }>(
      await get(app, receiptPath(receipt.id, "/history")),
      200,
    );
    const update = history.history.find((h) => h.action === "update");
    expect(update?.reason).toBe("金額の誤り");
    expect(update?.before).toMatchObject({ amount: 1100 });
    expect(update?.after).toMatchObject({ amount: 2000 });
  });

  it("version の不一致は 409 VERSION_CONFLICT", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, FILLED);
    const res = await patch(app, receipt.id, { version: 5, amount: 2000, reason: "誤り" });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("VERSION_CONFLICT");
  });
});

describe("POST /receipts/:receiptId/files（差し替え）", () => {
  it("201 で版 +1。前の版も取り出せ、履歴に replace_file が残る。値は変わらない", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, FILLED);
    const oldSha = receipt.currentFile.sha256;

    const res = await replace(app, receipt.id, { reason: "撮り直し", version: 1 });
    const body = await json<{ receipt: ReceiptDetail }>(res, 201);
    expect(body.receipt.version).toBe(2);
    expect(body.receipt.currentFile.sha256).not.toBe(oldSha);
    expect(body.receipt.files).toHaveLength(2);
    expect(body.receipt.amount).toBe(1100);

    const old = await get(app, receiptPath(receipt.id, `/files/${oldSha}?variant=original`));
    expect(old.status).toBe(200);

    const history = await json<{ history: ReceiptHistoryEntry[] }>(
      await get(app, receiptPath(receipt.id, "/history")),
      200,
    );
    const replaced = history.history.find((h) => h.action === "replace_file");
    expect(replaced?.reason).toBe("撮り直し");
  });

  it("警告つき（解像度の目安未満）でも 201 で、応答の warnings に出る", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, { ...FILLED, category: "paper_scan" });
    expect(receipt.warnings).toEqual([]);
    probeResult = { width: 1000, height: 800, fullColor: false };
    const res = await replace(app, receipt.id, { reason: "撮り直し", version: 1 });
    const body = await json<{ receipt: ReceiptDetail }>(res, 201);
    expect(body.receipt.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["RESOLUTION_BELOW_GUIDE", "NOT_FULL_COLOR"]),
    );
  });

  it("理由なしは 422 REASON_REQUIRED、版の不一致は 409 VERSION_CONFLICT", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, FILLED);
    const blank = await replace(app, receipt.id, { reason: "  ", version: 1 });
    expect([400, 422]).toContain(blank.status);
    const stale = await replace(app, receipt.id, { reason: "撮り直し", version: 9 });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe("VERSION_CONFLICT");
  });

  it("同じ内容のファイルは 409 RECEIPT_DUPLICATE、形式が違えば 422 RECEIPT_FORMAT_UNSUPPORTED、options の誤りは 400", async () => {
    const app = makeApp();
    const bytes = jpegBytes({ seed: 7777 });
    const receipt = await createReceipt(app, FILLED);
    const first = await replace(app, receipt.id, { reason: "撮り直し", version: 1 }, bytes);
    expect(first.status).toBe(201);
    const dup = await replace(app, receipt.id, { reason: "もう一度", version: 2 }, bytes);
    expect(dup.status).toBe(409);
    expect((await errorOf(dup)).code).toBe("RECEIPT_DUPLICATE");

    const bad = await replace(
      app,
      receipt.id,
      { reason: "x", version: 2 },
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(bad.status).toBe(422);
    expect((await errorOf(bad)).code).toBe("RECEIPT_FORMAT_UNSUPPORTED");

    const noOptions = await replace(app, receipt.id, { version: 2 });
    expect(noOptions.status).toBe(400);
    expect((await errorOf(noOptions)).code).toBe("VALIDATION");
  });

  it("ないものは 404 RECEIPT_NOT_FOUND", async () => {
    const app = makeApp();
    const res = await replace(app, "019aaaaa-0000-7000-8000-000000000000", {
      reason: "x",
      version: 1,
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("RECEIPT_NOT_FOUND");
  });
});

describe("POST /receipts/:receiptId/delete（削除）", () => {
  it("200 で削除済みになる。表示・ファイルの取り出し・履歴はできる。一覧は既定で除き includeDeleted で含む", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, FILLED);
    const res = await post(app, receiptPath(receipt.id, "/delete"), {
      reason: "誤って取り込んだ",
      version: 1,
    });
    const body = await json<{ receipt: ReceiptDetail }>(res, 200);
    expect(body.receipt.version).toBe(2);
    expect(body.receipt.deletedAt).not.toBeNull();

    const detail = await json<{ receipt: ReceiptDetail }>(
      await get(app, receiptPath(receipt.id)),
      200,
    );
    expect(detail.receipt.deletedAt).not.toBeNull();
    const file = await get(
      app,
      receiptPath(receipt.id, `/files/${receipt.currentFile.sha256}?variant=original`),
    );
    expect(file.status).toBe(200);
    const history = await json<{ history: ReceiptHistoryEntry[] }>(
      await get(app, receiptPath(receipt.id, "/history")),
      200,
    );
    expect(history.history.map((h) => h.action)).toEqual(["create", "delete"]);
    expect(history.history[1]?.reason).toBe("誤って取り込んだ");

    const list = await json<{ receipts: { id: string }[] }>(
      await get(app, `${base()}/receipts`),
      200,
    );
    expect(list.receipts.map((r) => r.id)).not.toContain(receipt.id);
    const all = await json<{ receipts: { id: string }[] }>(
      await get(app, `${base()}/receipts?includeDeleted=true`),
      200,
    );
    expect(all.receipts.map((r) => r.id)).toContain(receipt.id);
  });

  it("削除済みの値の変更・差し替え・再削除・結びつけは 409 RECEIPT_DELETED", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, FILLED);
    const journal = await createJournal(app, 1100, "2026-10-20");
    await post(app, receiptPath(receipt.id, "/delete"), { reason: "不要", version: 1 });

    const edit = await patch(app, receipt.id, { version: 2, memo: "x" });
    expect(edit.status).toBe(409);
    expect((await errorOf(edit)).code).toBe("RECEIPT_DELETED");
    const swap = await replace(app, receipt.id, { reason: "x", version: 2 });
    expect(swap.status).toBe(409);
    expect((await errorOf(swap)).code).toBe("RECEIPT_DELETED");
    const again = await post(app, receiptPath(receipt.id, "/delete"), {
      reason: "もう一度",
      version: 2,
    });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("RECEIPT_DELETED");
    const link = await post(app, receiptPath(receipt.id, "/link"), { journalId: journal.id });
    expect(link.status).toBe(409);
    expect((await errorOf(link)).code).toBe("RECEIPT_DELETED");
  });

  it("結びつきがあれば 409 RECEIPT_LINKED（details.journalId）。解除すれば削除できる", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, FILLED);
    const journal = await createJournal(app, 1100, "2026-10-20");
    await post(app, receiptPath(receipt.id, "/link"), { journalId: journal.id });

    const res = await post(app, receiptPath(receipt.id, "/delete"), { reason: "不要", version: 1 });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("RECEIPT_LINKED");
    expect(error.details).toMatchObject({ journalId: journal.id });

    const unlink = await post(app, receiptPath(receipt.id, "/unlink"), { reason: "付け替え前" });
    expect(unlink.status).toBe(200);
    const detail = await json<{ receipt: ReceiptDetail }>(
      await get(app, receiptPath(receipt.id)),
      200,
    );
    const done = await post(app, receiptPath(receipt.id, "/delete"), {
      reason: "不要",
      version: detail.receipt.version,
    });
    expect(done.status).toBe(200);
  });

  it("理由なし（空白）は 422 REASON_REQUIRED か 400、版の不一致は 409 VERSION_CONFLICT、ないものは 404", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, FILLED);
    const blank = await post(app, receiptPath(receipt.id, "/delete"), {
      reason: "  ",
      version: 1,
    });
    expect([400, 422]).toContain(blank.status);
    const stale = await post(app, receiptPath(receipt.id, "/delete"), {
      reason: "不要",
      version: 4,
    });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe("VERSION_CONFLICT");
    const missing = await post(
      app,
      receiptPath("019aaaaa-0000-7000-8000-000000000000", "/delete"),
      { reason: "不要", version: 1 },
    );
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("RECEIPT_NOT_FOUND");
  });
});

describe("GET /receipts/:receiptId/history", () => {
  it("古い順で { history } を返す。JSON に Cache-Control: no-store は付けない。ないものは 404", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, { category: "paper_scan" });
    await patch(app, receipt.id, { version: 1, amount: 500 });
    const res = await get(app, receiptPath(receipt.id, "/history"));
    expect(res.headers.get("cache-control")).not.toBe("no-store");
    const body = await json<{ history: ReceiptHistoryEntry[] }>(res, 200);
    expect(body.history.map((h) => h.action)).toEqual(["create", "update"]);

    const missing = await get(app, receiptPath("019aaaaa-0000-7000-8000-000000000000", "/history"));
    expect(missing.status).toBe(404);
  });
});
