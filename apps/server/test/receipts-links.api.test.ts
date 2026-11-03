import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { ok, type ReceiptImageTool, type ReceiptProbe } from "@trebuchet/domain";
import type { ReceiptDetail } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jpegBytes } from "../../../packages/domain/test/fixtures/receipts/sample-files.ts";
import { createApp } from "../src/app.ts";
import {
  accountLookup,
  createTestEntity,
  errorOf,
  json,
  makeClock,
  testHeaders,
} from "./helpers.ts";

// T022: 証憑と仕訳の結びつけ（contracts/http-api.md §1・§3、research R5・R6）。
// 画像の変換は偽の ReceiptImageTool。ファイルの暗号化は本物（一時のデータ場所とテスト用の DK）

let tmp: TempDataDir;
let entityId: string;
let acc: (name: string) => string;
const clock = makeClock("2026-10-20T09:00:00.000Z");
const PROBE: ReceiptProbe = { width: 4032, height: 3024, fullColor: true };

beforeEach(async () => {
  tmp = useTempDataDir("server-receipts-links");
  entityId = await createTestEntity();
  acc = await accountLookup(entityId);
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

const base = () => `/api/entities/${entityId}`;
const receiptPath = (id: string, suffix = "") => `${base()}/receipts/${id}${suffix}`;

async function post(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...(await testHeaders()), "content-type": "application/json" },
  });
}

async function get(app: App, path: string) {
  return app.request(path, { headers: await testHeaders() });
}

let seed = 0;
async function createReceipt(
  app: App,
  fields: { transactionDate?: string; amount?: number } = {},
): Promise<ReceiptDetail> {
  seed += 1;
  const form = new FormData();
  form.append("file", new File([new Uint8Array(jpegBytes({ seed }))], "r.jpg"));
  form.append("options", JSON.stringify({ category: "paper_scan", ...fields }));
  const res = await app.request(`${base()}/receipts`, {
    method: "POST",
    body: form,
    headers: await testHeaders(),
  });
  return (await json<{ receipt: ReceiptDetail }>(res, 201)).receipt;
}

const journalBody = (amount: number, date: string) => ({
  date,
  lines: [
    { side: "debit", accountId: acc("消耗品費"), amount },
    { side: "credit", accountId: acc("現金"), amount },
  ],
});

async function createJournal(app: App, amount: number, date: string) {
  const res = await post(app, `${base()}/journals`, journalBody(amount, date));
  return (await json<{ journal: { id: string; journalNo: number } }>(res, 201)).journal;
}

describe("POST /receipts/:receiptId/link", () => {
  it("201 で結びつけ、詳細の linkState が linked になる。同じ仕訳への再結びつけは変わらず 201", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app);
    const journal = await createJournal(app, 1100, "2026-10-20");

    const res = await post(app, receiptPath(receipt.id, "/link"), { journalId: journal.id });
    const body = await json<{ receipt: ReceiptDetail }>(res, 201);
    expect(body.receipt.id).toBe(receipt.id);
    expect(body.receipt.linkState).toBe("linked");
    expect(body.receipt.journal?.id).toBe(journal.id);

    const again = await post(app, receiptPath(receipt.id, "/link"), { journalId: journal.id });
    expect(again.status).toBe(201);
  });

  it("404 RECEIPT_NOT_FOUND・404 JOURNAL_NOT_FOUND", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app);
    const journal = await createJournal(app, 1100, "2026-10-20");

    const noReceipt = await post(
      app,
      receiptPath("019aaaaa-0000-7000-8000-000000000000", "/link"),
      {
        journalId: journal.id,
      },
    );
    expect(noReceipt.status).toBe(404);
    expect((await errorOf(noReceipt)).code).toBe("RECEIPT_NOT_FOUND");

    const noJournal = await post(app, receiptPath(receipt.id, "/link"), {
      journalId: "019aaaaa-0000-7000-8000-000000000000",
    });
    expect(noJournal.status).toBe(404);
    expect((await errorOf(noJournal)).code).toBe("JOURNAL_NOT_FOUND");
  });

  it("409 JOURNAL_VOIDED: 取り消した仕訳には結びつけられない", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app);
    const journal = await createJournal(app, 1100, "2026-10-20");
    const voided = await post(app, `${base()}/journals/${journal.id}/void`, {
      reason: "誤り",
      version: 1,
    });
    expect(voided.status).toBe(200);

    const res = await post(app, receiptPath(receipt.id, "/link"), { journalId: journal.id });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("JOURNAL_VOIDED");
  });

  it("409 RECEIPT_ALREADY_LINKED（details.journalId）→ replace なしの付け替えは 422 REASON_REQUIRED → 理由つきで 201", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app);
    const j1 = await createJournal(app, 1100, "2026-10-20");
    const j2 = await createJournal(app, 1100, "2026-10-21");
    await post(app, receiptPath(receipt.id, "/link"), { journalId: j1.id });

    const conflict = await post(app, receiptPath(receipt.id, "/link"), { journalId: j2.id });
    expect(conflict.status).toBe(409);
    const error = await errorOf(conflict);
    expect(error.code).toBe("RECEIPT_ALREADY_LINKED");
    expect(error.details).toMatchObject({ journalId: j1.id });

    const noReason = await post(app, receiptPath(receipt.id, "/link"), {
      journalId: j2.id,
      replace: true,
      reason: "   ",
    });
    expect(noReason.status).toBe(422);
    expect((await errorOf(noReason)).code).toBe("REASON_REQUIRED");

    const noReasonAtAll = await post(app, receiptPath(receipt.id, "/link"), {
      journalId: j2.id,
      replace: true,
    });
    expect(noReasonAtAll.status).toBe(422);
    expect((await errorOf(noReasonAtAll)).code).toBe("REASON_REQUIRED");

    const replaced = await post(app, receiptPath(receipt.id, "/link"), {
      journalId: j2.id,
      replace: true,
      reason: "仕訳を間違えた",
    });
    const body = await json<{ receipt: ReceiptDetail }>(replaced, 201);
    expect(body.receipt.linkState).toBe("linked");
    expect(body.receipt.journal?.id).toBe(j2.id);
  });

  it("取り消された仕訳への結びつき（journal_voided）は replace なしで結び直せる", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app);
    const j1 = await createJournal(app, 1100, "2026-10-20");
    const j2 = await createJournal(app, 1100, "2026-10-21");
    await post(app, receiptPath(receipt.id, "/link"), { journalId: j1.id });
    await post(app, `${base()}/journals/${j1.id}/void`, { reason: "誤り", version: 1 });

    const detail = await json<{ receipt: ReceiptDetail }>(
      await get(app, receiptPath(receipt.id)),
      200,
    );
    expect(detail.receipt.linkState).toBe("journal_voided");

    const res = await post(app, receiptPath(receipt.id, "/link"), { journalId: j2.id });
    const body = await json<{ receipt: ReceiptDetail }>(res, 201);
    expect(body.receipt.linkState).toBe("linked");
    expect(body.receipt.journal?.id).toBe(j2.id);
  });

  // 409 RECEIPT_DELETED は receipts-edit.api.test.ts（削除の API と同じ場所）

  it("400 VALIDATION: journalId がない", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app);
    const res = await post(app, receiptPath(receipt.id, "/link"), {});
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});

describe("POST /receipts/:receiptId/unlink", () => {
  it("200 で結びつきを閉じる。再度の解除（結びつきなし）は 422 VALIDATION、理由なしは 422 REASON_REQUIRED", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app);
    const journal = await createJournal(app, 1100, "2026-10-20");
    await post(app, receiptPath(receipt.id, "/link"), { journalId: journal.id });

    const noReason = await post(app, receiptPath(receipt.id, "/unlink"), { reason: "" });
    expect(noReason.status).toBe(422);
    expect((await errorOf(noReason)).code).toBe("REASON_REQUIRED");

    const res = await post(app, receiptPath(receipt.id, "/unlink"), { reason: "誤って結びつけた" });
    const body = await json<{ receipt: ReceiptDetail }>(res, 200);
    expect(body.receipt.linkState).toBe("none");

    const again = await post(app, receiptPath(receipt.id, "/unlink"), { reason: "もう一度" });
    expect(again.status).toBe(422);
    expect((await errorOf(again)).code).toBe("VALIDATION");
  });

  it("404 RECEIPT_NOT_FOUND", async () => {
    const app = makeApp();
    const res = await post(app, receiptPath("019aaaaa-0000-7000-8000-000000000000", "/unlink"), {
      reason: "x",
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("RECEIPT_NOT_FOUND");
  });
});

describe("POST /receipts/:receiptId/journal", () => {
  it("201 { journal, receipt } で仕訳を登録して結びつける。もう一度は 409 RECEIPT_ALREADY_LINKED で仕訳が増えない", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app);

    const res = await post(app, receiptPath(receipt.id, "/journal"), {
      journal: journalBody(1100, "2026-10-20"),
    });
    const body = await json<{
      journal: { id: string; journalNo: number; status: string };
      receipt: ReceiptDetail;
    }>(res, 201);
    expect(body.journal).toMatchObject({ journalNo: 1, status: "active" });
    expect(body.receipt.linkState).toBe("linked");
    expect(body.receipt.journal?.id).toBe(body.journal.id);

    const again = await post(app, receiptPath(receipt.id, "/journal"), {
      journal: journalBody(1100, "2026-10-20"),
    });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("RECEIPT_ALREADY_LINKED");

    const list = await json<{ journals: unknown[] }>(await get(app, `${base()}/journals`), 200);
    expect(list.journals).toHaveLength(1);
  });

  it("001 の登録のエラー（UNBALANCED）は 422 のままで、証憑は結びつかない", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app);
    const res = await post(app, receiptPath(receipt.id, "/journal"), {
      journal: {
        date: "2026-10-20",
        lines: [
          { side: "debit", accountId: acc("消耗品費"), amount: 1100 },
          { side: "credit", accountId: acc("現金"), amount: 1000 },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("UNBALANCED");

    const detail = await json<{ receipt: ReceiptDetail }>(
      await get(app, receiptPath(receipt.id)),
      200,
    );
    expect(detail.receipt.linkState).toBe("none");
    const list = await json<{ journals: unknown[] }>(await get(app, `${base()}/journals`), 200);
    expect(list.journals).toHaveLength(0);
  });

  it("404 RECEIPT_NOT_FOUND（仕訳は作られない）", async () => {
    const app = makeApp();
    const res = await post(app, receiptPath("019aaaaa-0000-7000-8000-000000000000", "/journal"), {
      journal: journalBody(1100, "2026-10-20"),
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("RECEIPT_NOT_FOUND");
  });
});

describe("GET /receipts/:receiptId/journal-candidates", () => {
  it("取引年月日の前後 14 日の有効な仕訳を、金額一致 → 日付の近い順に返す。取消済みは出ない", async () => {
    const app = makeApp();
    const receipt = await createReceipt(app, { transactionDate: "2026-10-20", amount: 1100 });
    const near = await createJournal(app, 500, "2026-10-20");
    const match = await createJournal(app, 1100, "2026-10-25");
    await createJournal(app, 1100, "2026-12-25"); // 範囲外
    const voided = await createJournal(app, 1100, "2026-10-21");
    await post(app, `${base()}/journals/${voided.id}/void`, { reason: "誤り", version: 1 });

    const res = await get(app, receiptPath(receipt.id, "/journal-candidates"));
    const body = await json<{
      candidates: {
        journal: { id: string };
        total: number;
        daysDiff: number;
        amountMatches: boolean;
      }[];
    }>(res, 200);
    expect(body.candidates.map((c) => c.journal.id)).toEqual([match.id, near.id]);
    expect(body.candidates[0]).toMatchObject({ total: 1100, daysDiff: 5, amountMatches: true });
    expect(body.candidates[1]).toMatchObject({ total: 500, daysDiff: 0, amountMatches: false });
  });

  it("404 RECEIPT_NOT_FOUND", async () => {
    const app = makeApp();
    const res = await get(
      app,
      receiptPath("019aaaaa-0000-7000-8000-000000000000", "/journal-candidates"),
    );
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("RECEIPT_NOT_FOUND");
  });
});
