import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { clearDataKey, createReceiptFileStore, VaultLockedError } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import {
  domainError,
  err,
  ok,
  type ReceiptFileStore,
  type ReceiptImageTool,
  type ReceiptProbe,
} from "@trebuchet/domain";
import {
  RECEIPT_MAX_BYTES,
  RECEIPT_MAX_PIXELS,
  type ReceiptCreateOptions,
  type ReceiptDetail,
  type ReceiptSummary,
} from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  heicBytes,
  jpegBytes,
  pdfBytes,
} from "../../../packages/domain/test/fixtures/receipts/sample-files.ts";
import { createApp } from "../src/app.ts";
import {
  createTestEntity,
  createTestSession,
  errorOf,
  json,
  makeClock,
  TEST_HOST,
  TEST_ORIGIN,
  testHeaders,
} from "./helpers.ts";

// T015: 証憑の追加・一覧・詳細・ファイルの取り出し（contracts/http-api.md §1・§2、research R9・R10・R12）。
// 画像の変換は偽の ReceiptImageTool（sips を呼ばない）。ファイルの暗号化は本物（一時のデータ場所とテスト用の DK）

let tmp: TempDataDir;
let entityId: string;
const clock = makeClock("2026-10-20T09:00:00.000Z");

const PROBE: ReceiptProbe = { width: 4032, height: 3024, fullColor: true };
const REMOTE_HOST = "mac.tail1234.ts.net";

beforeEach(async () => {
  tmp = useTempDataDir("server-receipts");
  entityId = await createTestEntity();
  clock.set("2026-10-20T09:00:00.000Z");
});
afterEach(() => tmp.cleanup());

type Tool = ReceiptImageTool & {
  probe: ReturnType<typeof vi.fn>;
  toDisplay: ReturnType<typeof vi.fn>;
};

function fakeTool(over: Partial<ReceiptImageTool> = {}): Tool {
  return {
    probe: vi.fn(async () => ok(PROBE)),
    toDisplay: vi.fn(async (bytes: Uint8Array, mediaType: string) => ok({ bytes, mediaType })),
    toAiJpeg: vi.fn(async () => ok(new Uint8Array([1]))),
    ...over,
  } as Tool;
}

type Options = Parameters<typeof createApp>[0];

function makeApp(tool: Tool, options: Options = {}) {
  return createApp({ clock, receipts: { imageTool: tool }, ...options });
}

const OPTIONS: ReceiptCreateOptions = {
  category: "electronic",
  transactionDate: "2026-10-20",
  amount: 1100,
  partnerName: "合成の店",
  memo: null,
};

function uploadForm(bytes: Uint8Array, name = "r.jpg", options: unknown = OPTIONS): FormData {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name));
  if (options !== undefined) form.append("options", JSON.stringify(options));
  return form;
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const path = (suffix = "") => `/api/entities/${entityId}/receipts${suffix}`;

async function post(
  app: ReturnType<typeof makeApp>,
  form: FormData,
  headers?: Record<string, string>,
) {
  return app.request(path(), {
    method: "POST",
    body: form,
    headers: { ...(await testHeaders()), ...headers },
  });
}

async function get(app: ReturnType<typeof makeApp>, suffix = "", headers?: Record<string, string>) {
  return app.request(path(suffix), { headers: { ...(await testHeaders()), ...headers } });
}

async function created(
  app: ReturnType<typeof makeApp>,
  bytes = jpegBytes({ seed: 1 }),
  options: unknown = OPTIONS,
  name = "r.jpg",
): Promise<ReceiptDetail> {
  const res = await post(app, uploadForm(bytes, name, options));
  return (await json<{ receipt: ReceiptDetail }>(res, 201)).receipt;
}

describe("POST /receipts（追加。H: §2）", () => {
  it("201 で証憑を作る。経路は local、形式は中身で判定、画素数・色は probe から。ファイルは暗号化されて名前がハッシュ", async () => {
    const tool = fakeTool();
    const app = makeApp(tool);
    const bytes = jpegBytes({ seed: 1 });
    const receipt = await created(app, bytes, OPTIONS, "領収書.jpg");

    expect(receipt).toMatchObject({
      channel: "local",
      category: "electronic",
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
      mediaType: "image/jpeg",
      deleted: false,
      version: 1,
      warnings: [],
      currentFile: {
        sha256: sha256Of(bytes),
        mediaType: "image/jpeg",
        originalName: "領収書.jpg",
        sizeBytes: bytes.length,
        width: 4032,
        height: 3024,
        fullColor: true,
        channel: "local",
      },
    });
    expect(tool.probe).toHaveBeenCalledTimes(1);
    expect(tool.probe.mock.calls[0]?.[1]).toBe("image/jpeg");

    // data/receipts/<事業体>/<sha256>.trc（平文ではない）
    const dir = join(tmp.dir, "receipts", entityId.toLowerCase());
    expect(readdirSync(dir)).toEqual([`${sha256Of(bytes)}.trc`]);
    const stored = readFileSync(join(dir, `${sha256Of(bytes)}.trc`));
    expect(Buffer.from(stored).includes(Buffer.from(bytes))).toBe(false);
    expect(stored.subarray(0, 4).toString("ascii")).toBe("TRC1");
  });

  it("経路は要求の Host で決まる: ts.net は remote、localhost:8787 は local（options の自己申告は見ない）", async () => {
    const app = makeApp(fakeTool(), {
      getRemoteSettings: async () => ({ enabled: true, host: REMOTE_HOST }),
    });
    const session = await createTestSession({ rpId: REMOTE_HOST });
    const remote = await post(
      app,
      uploadForm(jpegBytes({ seed: 2 }), "a.jpg", { ...OPTIONS, channel: "local" }),
      {
        Host: REMOTE_HOST,
        Origin: `https://${REMOTE_HOST}`,
        Cookie: session.cookie,
      },
    );
    expect((await json<{ receipt: ReceiptDetail }>(remote, 201)).receipt.channel).toBe("remote");

    const loopback = await post(app, uploadForm(jpegBytes({ seed: 3 })), {
      Host: "localhost:8787",
    });
    expect((await json<{ receipt: ReceiptDetail }>(loopback, 201)).receipt.channel).toBe("local");
  });

  it("PDF・HEIC も追加できる。PDF は probe が undefined でも 201（寸法なし）", async () => {
    const tool = fakeTool({ probe: vi.fn(async () => ok(undefined)) });
    const app = makeApp(tool);
    const pdf = await created(app, pdfBytes({ seed: 1 }), OPTIONS, "x.pdf");
    expect(pdf.mediaType).toBe("application/pdf");
    expect(pdf.currentFile).toMatchObject({ width: null, height: null, fullColor: null });
    const heic = await created(
      app,
      heicBytes({ major: "heic", compatible: ["mif1"] }),
      OPTIONS,
      "x.heic",
    );
    expect(heic.mediaType).toBe("image/heic");
  });

  it("ちょうど 20 MB は通り、20 MB + 1 バイトは 413 FILE_TOO_LARGE（details.maxBytes）", async () => {
    const app = makeApp(fakeTool());
    const make = (size: number) => {
      const bytes = new Uint8Array(size);
      bytes.set([0xff, 0xd8, 0xff, 0xe0]);
      return bytes;
    };
    const ok20 = await post(app, uploadForm(make(RECEIPT_MAX_BYTES)));
    expect(ok20.status).toBe(201);

    const big = await post(app, uploadForm(make(RECEIPT_MAX_BYTES + 1)));
    expect(big.status).toBe(413);
    const error = await errorOf(big);
    expect(error.code).toBe("FILE_TOO_LARGE");
    expect(error.details).toEqual({ maxBytes: RECEIPT_MAX_BYTES });
  });

  it("中身が JPEG・PNG・HEIC・PDF のどれでもなければ 422 RECEIPT_FORMAT_UNSUPPORTED（拡張子・Content-Type は見ない）。probe は呼ばない", async () => {
    const tool = fakeTool();
    const app = makeApp(tool);
    const res = await post(
      app,
      uploadForm(new TextEncoder().encode("これは画像ではない"), "fake.jpg"),
    );
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("RECEIPT_FORMAT_UNSUPPORTED");
    expect(tool.probe).not.toHaveBeenCalled();
    expect(existsSync(join(tmp.dir, "receipts"))).toBe(false);
  });

  it("画素数が 1 億を超える画像は 422 VALIDATION（details.maxPixels）。何も保存しない", async () => {
    const tool = fakeTool({
      probe: vi.fn(async () =>
        err(
          domainError("VALIDATION", "画像の画素数が大きすぎます", {
            maxPixels: RECEIPT_MAX_PIXELS,
          }),
        ),
      ),
    });
    const app = makeApp(tool);
    const res = await post(app, uploadForm(jpegBytes({ seed: 4 })));
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("VALIDATION");
    expect(error.details).toEqual({ maxPixels: RECEIPT_MAX_PIXELS });
    expect(existsSync(join(tmp.dir, "receipts"))).toBe(false);
    const list = await json<{ receipts: ReceiptSummary[] }>(await get(app), 200);
    expect(list.receipts).toEqual([]);
  });

  it("file・options がない、options が不正なら 400 VALIDATION", async () => {
    const app = makeApp(fakeTool());
    const noFile = new FormData();
    noFile.append("options", JSON.stringify(OPTIONS));
    const a = await post(app, noFile);
    expect(a.status).toBe(400);
    expect((await errorOf(a)).details).toMatchObject({ issues: [{ path: ["file"] }] });

    const noOptions = new FormData();
    noOptions.append("file", new File([new Uint8Array(jpegBytes())], "a.jpg"));
    const b = await post(app, noOptions);
    expect(b.status).toBe(400);
    expect((await errorOf(b)).details).toMatchObject({ issues: [{ path: ["options"] }] });

    const c = await post(app, uploadForm(jpegBytes(), "a.jpg", { category: "unknown" }));
    expect(c.status).toBe(400);
    expect((await errorOf(c)).code).toBe("VALIDATION");
  });

  it("値の検査（取引年月日が暦にない）は 400 VALIDATION（options の issue の path）", async () => {
    const app = makeApp(fakeTool());
    const res = await post(
      app,
      uploadForm(jpegBytes({ seed: 5 }), "a.jpg", { ...OPTIONS, transactionDate: "2026-02-30" }),
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).details).toMatchObject({
      issues: [{ path: ["options", "transactionDate"] }],
    });
  });

  it("同じ内容をもう一度送ると 409 RECEIPT_DUPLICATE（details.receiptId、deleted）。2 件目の行を作らない", async () => {
    const app = makeApp(fakeTool());
    const first = await created(app, jpegBytes({ seed: 6 }));
    const res = await post(app, uploadForm(jpegBytes({ seed: 6 }), "copy.jpg"));
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("RECEIPT_DUPLICATE");
    expect(error.details).toEqual({ receiptId: first.id, deleted: false });
    const list = await json<{ receipts: ReceiptSummary[] }>(await get(app), 200);
    expect(list.receipts).toHaveLength(1);
  });

  it("施錠中は 401 LOCKED。何も保存しない", async () => {
    const app = makeApp(fakeTool());
    const headers = await testHeaders();
    clearDataKey();
    const res = await app.request(path(), {
      method: "POST",
      body: uploadForm(jpegBytes({ seed: 7 })),
      headers,
    });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("LOCKED");
  });

  it("ファイルの書き込み中に施錠された（VaultLockedError）は 401 LOCKED。行を作らない", async () => {
    const real = createReceiptFileStore(entityId);
    const locked: ReceiptFileStore = {
      ...real,
      has: () => false,
      put: () => {
        throw new VaultLockedError();
      },
    };
    const app = makeApp(fakeTool(), { receipts: { imageTool: fakeTool(), files: () => locked } });
    const res = await post(app, uploadForm(jpegBytes({ seed: 8 })));
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("LOCKED");
    const list = await json<{ receipts: ReceiptSummary[] }>(await get(makeApp(fakeTool())), 200);
    expect(list.receipts).toEqual([]);
  });

  it("警告の日付の境目: 紙の証憑の期限 2026-06-30（JST）。UTC 14:59 は警告なし、UTC 15:00 は INPUT_PERIOD_EXCEEDED", async () => {
    const app = makeApp(fakeTool());
    const paper = { ...OPTIONS, category: "paper_scan", transactionDate: "2026-04-21" };

    clock.set("2026-06-30T14:59:59.000Z");
    const before = await created(app, jpegBytes({ seed: 9 }), paper);
    expect(before.warnings.map((w) => w.code)).toEqual([]);

    clock.set("2026-06-30T15:00:00.000Z");
    const after = await created(app, jpegBytes({ seed: 10 }), paper);
    expect(after.warnings).toEqual([
      { code: "INPUT_PERIOD_EXCEEDED", details: { deadline: "2026-06-30" } },
    ]);
  });

  it("警告は保存を拒まない: 値が未入力・解像度が目安より低い・白黒でも 201", async () => {
    const tool = fakeTool({
      probe: vi.fn(async () => ok({ width: 1000, height: 800, fullColor: false })),
    });
    const app = makeApp(tool);
    const receipt = await created(app, jpegBytes({ seed: 11 }), { category: "paper_scan" });
    expect(receipt.warnings.map((w) => w.code)).toEqual([
      "FIELDS_MISSING",
      "RESOLUTION_BELOW_GUIDE",
      "NOT_FULL_COLOR",
    ]);
  });
});

describe("GET /receipts・/receipts/:receiptId", () => {
  it("一覧は新しい順で、条件（取引先・区分・未入力）で絞れる。警告つき", async () => {
    const app = makeApp(fakeTool());
    clock.set("2026-10-20T09:00:00.000Z");
    const a = await created(app, jpegBytes({ seed: 21 }), OPTIONS);
    clock.set("2026-10-21T09:00:00.000Z");
    const b = await created(app, jpegBytes({ seed: 22 }), { category: "paper_scan" });

    const all = await json<{ receipts: ReceiptSummary[]; nextCursor: string | null }>(
      await get(app),
      200,
    );
    expect(all.receipts.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(all.nextCursor).toBeNull();
    expect(all.receipts[0]?.warnings.map((w) => w.code)).toContain("FIELDS_MISSING");

    const missing = await json<{ receipts: ReceiptSummary[] }>(
      await get(app, "?missing=true"),
      200,
    );
    expect(missing.receipts.map((r) => r.id)).toEqual([b.id]);
    const partner = await json<{ receipts: ReceiptSummary[] }>(
      await get(app, `?partner=${encodeURIComponent("合成")}&category=electronic`),
      200,
    );
    expect(partner.receipts.map((r) => r.id)).toEqual([a.id]);
  });

  it("limit で区切るとカーソルで続きを読める。不正な条件は 400 VALIDATION", async () => {
    const app = makeApp(fakeTool());
    for (const seed of [31, 32, 33]) {
      clock.advance(1000);
      await created(app, jpegBytes({ seed }));
    }
    const page1 = await json<{ receipts: ReceiptSummary[]; nextCursor: string | null }>(
      await get(app, "?limit=2"),
      200,
    );
    expect(page1.receipts).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await json<{ receipts: ReceiptSummary[]; nextCursor: string | null }>(
      await get(app, `?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`),
      200,
    );
    expect(page2.receipts).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const bad = await get(app, "?limit=0");
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("VALIDATION");
  });

  it("詳細は版・ファイルの版の一覧・警告を返す。ない ID と別の形の ID は 404 / 400", async () => {
    const app = makeApp(fakeTool());
    const receipt = await created(app, jpegBytes({ seed: 41 }));
    const detail = await json<{ receipt: ReceiptDetail }>(await get(app, `/${receipt.id}`), 200);
    expect(detail.receipt).toEqual(receipt);
    expect(detail.receipt.files).toHaveLength(1);

    const unknown = await get(app, "/0191f5a0-0000-7000-8000-000000000000");
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe("RECEIPT_NOT_FOUND");
    const malformed = await get(app, "/not-an-id");
    expect(malformed.status).toBe(400);
  });
});

describe("GET /receipts/:receiptId/files/:sha256（表示・取り出し。R9・R12）", () => {
  it("原本をそのまま返す: Content-Type は版の media_type、no-store・nosniff・inline", async () => {
    const tool = fakeTool();
    const app = makeApp(tool);
    const bytes = jpegBytes({ seed: 51 });
    const receipt = await created(app, bytes);
    const res = await get(app, `/${receipt.id}/files/${sha256Of(bytes)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(bytes));
  });

  it("HEIC は既定（display）では JPEG に変換して返し、variant=original は原本を返す。原本は変えない", async () => {
    const converted = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
    const tool = fakeTool({
      toDisplay: vi.fn(async () => ok({ bytes: converted, mediaType: "image/jpeg" })),
    });
    const app = makeApp(tool);
    const heic = heicBytes({ major: "heic", compatible: ["mif1"] });
    const receipt = await created(app, heic, OPTIONS, "x.heic");
    const sha = sha256Of(heic);

    const display = await get(app, `/${receipt.id}/files/${sha}`);
    expect(display.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await display.arrayBuffer())).toEqual(converted);
    expect(tool.toDisplay).toHaveBeenCalledTimes(1);

    const original = await get(app, `/${receipt.id}/files/${sha}?variant=original`);
    expect(original.headers.get("content-type")).toBe("image/heic");
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(heic));
    expect(tool.toDisplay).toHaveBeenCalledTimes(1);
  });

  it("download=1 は attachment と元の名前（RFC 5987）", async () => {
    const app = makeApp(fakeTool());
    const bytes = pdfBytes({ seed: 52 });
    const receipt = await created(app, bytes, OPTIONS, "領収書 10月.pdf");
    const res = await get(
      app,
      `/${receipt.id}/files/${sha256Of(bytes)}?download=1&variant=original`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("領収書 10月.pdf")}`);
  });

  it("表示用の変換の失敗は 500 RECEIPT_CONVERSION_FAILED", async () => {
    const tool = fakeTool({
      toDisplay: vi.fn(async () => err(domainError("RECEIPT_CONVERSION_FAILED", "変換できません"))),
    });
    const app = makeApp(tool);
    const heic = heicBytes({ major: "heic", compatible: [] });
    const receipt = await created(app, heic, OPTIONS, "x.heic");
    const res = await get(app, `/${receipt.id}/files/${sha256Of(heic)}`);
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe("RECEIPT_CONVERSION_FAILED");
  });

  it("その証憑の版でない sha256 は 404 RECEIPT_NOT_FOUND。variant・download の値が不正なら 400", async () => {
    const app = makeApp(fakeTool());
    const a = await created(app, jpegBytes({ seed: 53 }));
    const b = await created(app, jpegBytes({ seed: 54 }));
    const wrong = await get(app, `/${a.id}/files/${b.currentFile.sha256}`);
    expect(wrong.status).toBe(404);
    expect((await errorOf(wrong)).code).toBe("RECEIPT_NOT_FOUND");
    const shaBad = await get(app, `/${a.id}/files/xyz`);
    expect(shaBad.status).toBe(400);
    const variant = await get(app, `/${a.id}/files/${a.currentFile.sha256}?variant=thumb`);
    expect(variant.status).toBe(400);
    expect((await errorOf(variant)).code).toBe("VALIDATION");
  });

  it("データ場所のファイルがない・改ざんされた場合は 500 RECEIPT_FILE_UNREADABLE（details.sha256）", async () => {
    const app = makeApp(fakeTool());
    const bytes = jpegBytes({ seed: 55 });
    const receipt = await created(app, bytes);
    rmSync(join(tmp.dir, "receipts", entityId.toLowerCase(), `${sha256Of(bytes)}.trc`));
    const res = await get(app, `/${receipt.id}/files/${sha256Of(bytes)}`);
    expect(res.status).toBe(500);
    const error = await errorOf(res);
    expect(error.code).toBe("RECEIPT_FILE_UNREADABLE");
    expect(error.details).toEqual({ sha256: sha256Of(bytes) });
  });
});

describe("認証（INV-29）", () => {
  it("未サインインは 4 つのルートとも 401（一覧・詳細・ファイル・追加）", async () => {
    const app = makeApp(fakeTool());
    const headers = { Host: TEST_HOST, Origin: TEST_ORIGIN };
    const id = "0191f5a0-0000-7000-8000-000000000000";
    const sha = "a".repeat(64);
    for (const [method, suffix] of [
      ["GET", ""],
      ["GET", `/${id}`],
      ["GET", `/${id}/files/${sha}`],
      ["POST", ""],
    ] as const) {
      const res = await app.request(path(suffix), { method, headers });
      expect(res.status, `${method} ${suffix}`).toBe(401);
    }
  });
});
