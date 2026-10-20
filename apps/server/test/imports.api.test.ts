import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { ImportBatch, ImportBatchJournal, ImportPreview } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app, type ErrorBody } from "./helpers.ts";

// T025: 取込の API（contracts/http-api.md の 002）

let tmp: TempDataDir;
let entityId: string;

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/domain/test/fixtures/freee/${name}`, import.meta.url));

const JOURNAL = fixture("journal-2025.csv");
const LEDGER = fixture("ledger-2025.csv");
const SHA = createHash("sha256").update(JOURNAL).digest("hex");
/** 既定の選択では前年分の決算振替（900000011）が対象外になり、14件が new */
const COUNT_NEW = 14;
const CLOSING_ID = "900000011";

async function createEntity(firstFiscalYear: number): Promise<string> {
  const res = await app.request("/api/entities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "個人事業",
      kind: "individual",
      fiscalStartMonth: 1,
      firstFiscalYear,
    }),
  });
  if (res.status !== 201) throw new Error(`entity create failed: ${res.status}`);
  return ((await res.json()) as { entity: { id: string } }).entity.id;
}

beforeEach(async () => {
  tmp = useTempDataDir("server-imports");
  entityId = await createEntity(2025);
});
afterEach(() => tmp.cleanup());

const url = (path: string, id = entityId) => `/api/entities/${id}${path}`;

type Fields = {
  file?: Uint8Array<ArrayBuffer> | undefined;
  name?: string;
  options?: string | undefined;
  expected?: string | undefined;
};

function form({ file = JOURNAL, name = "journal-2025.csv", options, expected }: Fields): FormData {
  const data = new FormData();
  data.append("file", new File([file], name, { type: "text/csv" }));
  if (options !== undefined) data.append("options", options);
  if (expected !== undefined) data.append("expected", expected);
  return data;
}

const post = (path: string, fields: Fields, id = entityId) =>
  app.request(url(path, id), { method: "POST", body: form(fields) });

const preview = (fields: Fields = {}, id = entityId) =>
  post("/imports/freee/preview", { options: "{}", ...fields }, id);

const expectedOf = (countNew = COUNT_NEW, fileSha256 = SHA) =>
  JSON.stringify({ fileSha256, countNew });

const commit = (fields: Fields = {}) =>
  post("/imports/freee/commit", { options: "{}", expected: expectedOf(), ...fields });

const get = (path: string) => app.request(url(path));

const putMappings = (body: unknown) =>
  app.request(url("/import-mappings"), {
    method: "PUT",
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

/** 帳簿の状態（仕訳・取込の回・マスタ・対応表） */
async function books() {
  const paths = [
    "/journals",
    "/imports",
    "/import-mappings",
    "/partners",
    "/tags",
    "/fiscal-periods/2025/opening-balances",
  ];
  return Promise.all(paths.map(async (p) => (await get(p)).json()));
}

async function accountId(code: string): Promise<string> {
  const { accounts } = await json<{ accounts: { id: string; code: string }[] }>(
    await get("/accounts"),
    200,
  );
  const found = accounts.find((a) => a.code === code);
  if (found === undefined) throw new Error(`科目がない: ${code}`);
  return found.id;
}

describe("POST /imports/freee/preview", () => {
  it("200 { preview }。ハッシュはサーバーで計算し、帳簿は変わらない", async () => {
    const before = await books();
    const body = await json<{ preview: ImportPreview }>(await preview(), 200);
    expect(body.preview.file).toEqual({
      name: "journal-2025.csv",
      sha256: SHA,
      kind: "journal",
      encoding: "utf-8",
      rowCount: 21,
    });
    expect(body.preview.counts).toMatchObject({ new: COUNT_NEW, excluded: 1, rejected: 0 });
    expect(body.preview.ready).toBe(true);
    expect(body.preview.items).toHaveLength(15);
    expect(await books()).toEqual(before);
  });

  it("options を反映する（exclude → USER_EXCLUDED）。options がなければ {} として扱う", async () => {
    const excluded = await json<{ preview: ImportPreview }>(
      await preview({ options: JSON.stringify({ exclude: ["900000033"] }) }),
      200,
    );
    expect(excluded.preview.counts).toMatchObject({ new: COUNT_NEW - 1, excluded: 2 });
    expect(excluded.preview.items.find((i) => i.freeeJournalId === "900000033")).toMatchObject({
      decision: "excluded",
      reason: "USER_EXCLUDED",
    });

    const res = await app.request(url("/imports/freee/preview"), {
      method: "POST",
      body: form({}),
    });
    expect((await json<{ preview: ImportPreview }>(res, 200)).preview.counts.new).toBe(COUNT_NEW);
  });

  it.each([
    ["JSON でない", "{fiscalYears:"],
    ["型が違う", JSON.stringify({ fiscalYears: "2025" })],
    ["配列", "[]"],
  ])("options が不正（%s）→ 400 VALIDATION", async (_, options) => {
    const res = await preview({ options });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("VALIDATION");
    expect(error.details).toMatchObject({
      issues: [{ path: expect.arrayContaining(["options"]) }],
    });
  });

  it("会計期間がない日付は OUT_OF_PERIOD と案内の message を返す", async () => {
    const other = await createEntity(2026);
    const body = await json<{ preview: ImportPreview }>(await preview({}, other), 200);
    const item = body.preview.items.find((i) => i.reason === "OUT_OF_PERIOD") as
      | (ImportPreview["items"][number] & { message?: string })
      | undefined;
    expect(item).toMatchObject({ decision: "rejected" });
    expect(item?.message).toEqual(expect.any(String));
    expect(body.preview.ready).toBe(false);
  });

  it("仕訳帳の代わりに元帳 → 422 IMPORT_WRONG_KIND", async () => {
    const res = await preview({ file: LEDGER, name: "ledger-2025.csv" });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "IMPORT_WRONG_KIND",
      details: { expected: "journal", actual: "ledger" },
    });
  });

  it("freee の書き出しでない CSV → 422 IMPORT_UNKNOWN_FORMAT", async () => {
    const res = await preview({ file: new TextEncoder().encode("日付,金額\n2025-01-01,100\n") });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("IMPORT_UNKNOWN_FORMAT");
    expect(error.details).toMatchObject({ expected: "journal", missingColumns: expect.any(Array) });
  });
});

describe("POST /imports/freee/commit", () => {
  it("201 { batch, preview }。仕訳が登録され、取込の回にハッシュと件数が残る", async () => {
    const body = await json<{ batch: ImportBatch; preview: ImportPreview }>(await commit(), 201);
    expect(body.batch).toMatchObject({
      source: "freee_journal",
      fileName: "journal-2025.csv",
      fileSha256: SHA,
      fiscalYears: [2025],
      countNew: COUNT_NEW,
      countExcluded: 1,
      status: "active",
    });
    expect(body.preview.counts.new).toBe(COUNT_NEW);
    const { journals } = await json<{ journals: { source: string }[] }>(
      await get("/journals?limit=100"),
      200,
    );
    expect(journals).toHaveLength(COUNT_NEW);
    expect(journals.every((j) => j.source === "import_freee")).toBe(true);
  });

  it("2回目（expected.countNew = 0）は 422 IMPORT_NOT_READY で、何も登録しない", async () => {
    await json(await commit(), 201);
    const before = await books();
    const res = await commit({ expected: expectedOf(0) });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "IMPORT_NOT_READY",
      details: { unmapped: [] },
    });
    expect(await books()).toEqual(before);
  });

  it("プレビューのときとハッシュが違う → 409 IMPORT_FILE_CHANGED", async () => {
    const before = await books();
    const res = await commit({ expected: expectedOf(COUNT_NEW, "0".repeat(64)) });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("IMPORT_FILE_CHANGED");
    expect(await books()).toEqual(before);
  });

  it("作り直した件数が違う → 409 IMPORT_PLAN_CHANGED（details.preview に新しいプレビュー全体）", async () => {
    const before = await books();
    const res = await commit({ expected: expectedOf(COUNT_NEW - 1) });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("IMPORT_PLAN_CHANGED");
    const { preview: rebuilt } = error.details as { preview: ImportPreview };
    expect(rebuilt.file.sha256).toBe(SHA);
    expect(rebuilt.counts.new).toBe(COUNT_NEW);
    expect(rebuilt.items).toHaveLength(15);
    expect(await books()).toEqual(before);
  });

  it("対応が未定の名前が残る → 422 IMPORT_NOT_READY と details.unmapped", async () => {
    const before = await books();
    const res = await commit({ options: JSON.stringify({ include: [CLOSING_ID] }) });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "IMPORT_NOT_READY",
      details: { unmapped: ["損益"] },
    });
    expect(await books()).toEqual(before);
  });

  it.each([
    ["expected がない", undefined],
    ["expected が JSON でない", "x"],
    ["countNew が負", expectedOf(-1)],
    ["ハッシュの形式が違う", expectedOf(COUNT_NEW, "XYZ")],
  ])("%s → 400 VALIDATION", async (_, expected) => {
    const data = form({ options: "{}", expected });
    const res = await app.request(url("/imports/freee/commit"), { method: "POST", body: data });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("仕訳帳の代わりに元帳 → 422 IMPORT_WRONG_KIND", async () => {
    const ledgerSha = createHash("sha256").update(LEDGER).digest("hex");
    const res = await commit({
      file: LEDGER,
      name: "ledger-2025.csv",
      expected: expectedOf(COUNT_NEW, ledgerSha),
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("IMPORT_WRONG_KIND");
  });
});

describe("GET /imports、GET /imports/:batchId", () => {
  it("取込の回の一覧は新しい順", async () => {
    expect(await json(await get("/imports"), 200)).toEqual({ batches: [] });
    const first = await json<{ batch: ImportBatch }>(
      await commit({
        options: JSON.stringify({ exclude: ["900000033"] }),
        expected: expectedOf(COUNT_NEW - 1),
      }),
      201,
    );
    const second = await json<{ batch: ImportBatch }>(
      await commit({ expected: expectedOf(1) }),
      201,
    );
    const { batches } = await json<{ batches: ImportBatch[] }>(await get("/imports"), 200);
    expect(batches.map((b) => b.id)).toEqual([second.batch.id, first.batch.id]);
    expect(batches[0]).toEqual(second.batch);
  });

  it("取込の回の詳細は { batch, journals }（仕訳番号の順）", async () => {
    const { batch } = await json<{ batch: ImportBatch }>(await commit(), 201);
    const body = await json<{ batch: ImportBatch; journals: ImportBatchJournal[] }>(
      await get(`/imports/${batch.id}`),
      200,
    );
    expect(body.batch).toEqual(batch);
    expect(body.journals).toHaveLength(COUNT_NEW);
    expect(Object.keys(body.journals[0] ?? {}).sort()).toEqual(
      ["date", "freeeJournalId", "journalId", "journalNo", "status", "version"].sort(),
    );
    const numbers = body.journals.map((j) => j.journalNo);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(body.journals.every((j) => j.status === "active" && j.version === 1)).toBe(true);
    expect(new Set(body.journals.map((j) => j.freeeJournalId)).size).toBe(COUNT_NEW);
    expect(body.journals.map((j) => j.freeeJournalId)).not.toContain(CLOSING_ID);
  });

  it("ない取込の回 → 404 IMPORT_BATCH_NOT_FOUND", async () => {
    const res = await get("/imports/0190a000-0000-7000-8000-000000000000");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("IMPORT_BATCH_NOT_FOUND");
  });
});

describe("GET/PUT /import-mappings", () => {
  it("指定した行だけを追加・更新し、保存済みの対応表を返す", async () => {
    expect(await json(await get("/import-mappings"), 200)).toEqual({ accounts: [], taxes: [] });

    const entertainment = await accountId("5140");
    const meetings = await accountId("5260");
    const card = await accountId("2020");
    const saved = await json(
      await putMappings({
        accounts: [
          { sourceName: "交際費", accountId: meetings },
          { sourceName: "ＡＢＣカード", accountId: card, subAccountName: "ABCカード" },
        ],
      }),
      200,
    );
    expect(saved).toEqual({
      accounts: [
        { sourceName: "ABCカード", accountId: card, subAccountName: "ABCカード" },
        { sourceName: "交際費", accountId: meetings },
      ],
      taxes: [],
    });

    const updated = await json(
      await putMappings({
        accounts: [{ sourceName: "交際費", accountId: entertainment }],
        taxes: [{ sourceName: "課対仕入８％（軽）", taxCategory: "PURCHASE_8R" }],
      }),
      200,
    );
    const expected = {
      accounts: [
        { sourceName: "ABCカード", accountId: card, subAccountName: "ABCカード" },
        { sourceName: "交際費", accountId: entertainment },
      ],
      taxes: [{ sourceName: "課対仕入8%(軽)", taxCategory: "PURCHASE_8R" }],
    };
    expect(updated).toEqual(expected);
    expect(await json(await get("/import-mappings"), 200)).toEqual(expected);

    // プレビューは保存した対応表を使う
    const { preview: p } = await json<{ preview: ImportPreview }>(await preview(), 200);
    expect(p.mappings.accounts).toContainEqual({
      sourceName: "交際費",
      status: "saved",
      accountId: entertainment,
    });
  });

  it("使用停止の科目・他の科目の補助科目 → 422 VALIDATION（何も保存しない）", async () => {
    const misc = await accountId("5310");
    const patched = await app.request(url(`/accounts/${misc}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    expect(patched.status).toBe(200);
    const bank = await accountId("1020");
    const { subAccount } = await json<{ subAccount: { id: string } }>(
      await app.request(url(`/accounts/${bank}/sub-accounts`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "A銀行" }),
      }),
      201,
    );
    const card = await accountId("2020");

    for (const accounts of [
      [{ sourceName: "雑費", accountId: misc }],
      [{ sourceName: "カード", accountId: card, subAccountId: subAccount.id }],
    ]) {
      const res = await putMappings({
        accounts: [{ sourceName: "交際費", accountId: await accountId("5140") }, ...accounts],
      });
      expect(res.status, JSON.stringify(accounts)).toBe(422);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
    expect(await json(await get("/import-mappings"), 200)).toEqual({ accounts: [], taxes: [] });
  });

  it("入力の形が違う（補助科目の ID と名前の両方）→ 400 VALIDATION", async () => {
    const card = await accountId("2020");
    const res = await putMappings({
      accounts: [
        {
          sourceName: "カード",
          accountId: card,
          subAccountId: "0190a000-0000-7000-8000-000000000000",
          subAccountName: "カード",
        },
      ],
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});
