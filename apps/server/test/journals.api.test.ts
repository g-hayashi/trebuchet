import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { ok, type ReceiptImageTool, type ReceiptProbe } from "@trebuchet/domain";
import type { ReceiptDetail, ReceiptSummary } from "@trebuchet/schema";
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

// T022: 仕訳の一覧の receiptCount・詳細の receipts（contracts/http-api.md §4、research R6）

let tmp: TempDataDir;
let entityId: string;
let acc: (name: string) => string;
const clock = makeClock("2026-10-20T09:00:00.000Z");
const PROBE: ReceiptProbe = { width: 4032, height: 3024, fullColor: true };

beforeEach(async () => {
  tmp = useTempDataDir("server-journals-receipts");
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

async function post(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...(await testHeaders()), "content-type": "application/json" },
  });
}
const get = async (app: App, path: string) => app.request(path, { headers: await testHeaders() });

let seed = 100;
async function createReceipt(app: App): Promise<ReceiptDetail> {
  seed += 1;
  const form = new FormData();
  form.append("file", new File([new Uint8Array(jpegBytes({ seed }))], "r.jpg"));
  form.append("options", JSON.stringify({ category: "electronic" }));
  const res = await app.request(`${base()}/receipts`, {
    method: "POST",
    body: form,
    headers: await testHeaders(),
  });
  return (await json<{ receipt: ReceiptDetail }>(res, 201)).receipt;
}

async function createJournal(app: App, date: string) {
  const res = await post(app, `${base()}/journals`, {
    date,
    lines: [
      { side: "debit", accountId: acc("消耗品費"), amount: 1100 },
      { side: "credit", accountId: acc("現金"), amount: 1100 },
    ],
  });
  return (await json<{ journal: { id: string } }>(res, 201)).journal;
}

const link = (app: App, receiptId: string, journalId: string) =>
  post(app, `${base()}/receipts/${receiptId}/link`, { journalId });

type ListBody = { journals: { id: string; receiptCount: number }[]; nextCursor: string | null };
type DetailBody = { journal: { id: string }; receipts: ReceiptSummary[] };

describe("GET /journals の receiptCount", () => {
  it("有効な結びつきの数を返す（結びつきのない仕訳は 0）。解除・取消後も有効な数だけ数える", async () => {
    const app = makeApp();
    const none = await createJournal(app, "2026-10-01");
    const one = await createJournal(app, "2026-10-02");
    const two = await createJournal(app, "2026-10-03");
    const r1 = await createReceipt(app);
    const r2 = await createReceipt(app);
    const r3 = await createReceipt(app);
    expect((await link(app, r1.id, one.id)).status).toBe(201);
    expect((await link(app, r2.id, two.id)).status).toBe(201);
    expect((await link(app, r3.id, two.id)).status).toBe(201);

    const list = await json<ListBody>(await get(app, `${base()}/journals`), 200);
    const counts = Object.fromEntries(list.journals.map((j) => [j.id, j.receiptCount]));
    expect(counts).toEqual({ [none.id]: 0, [one.id]: 1, [two.id]: 2 });

    // 解除すると数えない
    const unlinked = await post(app, `${base()}/receipts/${r3.id}/unlink`, { reason: "誤り" });
    expect(unlinked.status).toBe(200);
    const after = await json<ListBody>(await get(app, `${base()}/journals`), 200);
    expect(after.journals.find((j) => j.id === two.id)?.receiptCount).toBe(1);
    expect(after.nextCursor).toBeNull();
  });
});

describe("GET /journals/:journalId の receipts", () => {
  it("有効な結びつきの証憑の要約を返す。結びつきがなければ空", async () => {
    const app = makeApp();
    const journal = await createJournal(app, "2026-10-02");
    const empty = await json<DetailBody>(await get(app, `${base()}/journals/${journal.id}`), 200);
    expect(empty.receipts).toEqual([]);

    const receipt = await createReceipt(app);
    await link(app, receipt.id, journal.id);
    const res = await get(app, `${base()}/journals/${journal.id}`);
    const body = await json<DetailBody>(res, 200);
    expect(body.journal.id).toBe(journal.id);
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0]).toMatchObject({
      id: receipt.id,
      linkState: "linked",
      category: "electronic",
      deleted: false,
    });
    expect(body.receipts[0]?.journal?.id).toBe(journal.id);

    // 既存の応答（statements）は残る
    expect(body).toHaveProperty("statements");

    await post(app, `${base()}/receipts/${receipt.id}/unlink`, { reason: "誤り" });
    const unlinked = await json<DetailBody>(
      await get(app, `${base()}/journals/${journal.id}`),
      200,
    );
    expect(unlinked.receipts).toEqual([]);
  });

  it("404 JOURNAL_NOT_FOUND は変わらない", async () => {
    const app = makeApp();
    const res = await get(app, `${base()}/journals/019aaaaa-0000-7000-8000-000000000000`);
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("JOURNAL_NOT_FOUND");
  });
});
