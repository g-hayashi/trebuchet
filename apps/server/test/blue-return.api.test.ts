import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { BlueReturn } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLookup, client, createTestEntity, errorOf, postSimpleJournal } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;
let acc: (name: string) => string;

const e = client.api.entities[":entityId"];
const br = () => e["blue-return"][":year"];
const param = (year = "2026") => ({ entityId, year });

beforeEach(async () => {
  tmp = useTempDataDir("server-blue-return");
  entityId = await createTestEntity();
  acc = await accountLookup(entityId);
});
afterEach(() => tmp.cleanup());

const simple = (debit: string, credit: string, amount: number, date: string) =>
  postSimpleJournal(entityId, acc, debit, credit, amount, date);

const ANSWERS = {
  doubleEntry: true,
  statementsAttached: true,
  filedOnTime: true,
  eTax: true,
  electronicBooks: false,
};

const amountOf = (
  body: { page1: { lines: { no: number; amount: number | null }[] } },
  no: number,
) => body.page1.lines.find((l) => l.no === no)?.amount;

describe("GET /blue-return/:year（US1）", () => {
  beforeEach(async () => {
    await simple("普通預金", "売上高", 1_000_000, "2026-03-31");
    await simple("消耗品費", "普通預金", 100_000, "2026-04-10");
    await simple("通信費", "普通預金", 20_000, "2026-05-10");
    const voided = await simple("通信費", "普通預金", 7_000, "2026-06-01");
    const v = await e.journals[":journalId"].void.$post({
      param: { entityId, journalId: voided.id },
      json: { reason: "二重登録", version: 1 },
    });
    if (v.status !== 200) throw new Error(`void failed: ${v.status}`);
  });

  it("200 で { blueReturn } を返し、BlueReturn の形で取消済みを除く。回答前は欄44・45 が null", async () => {
    const res = await br().$get({ param: param() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blueReturn: unknown };
    const parsed = BlueReturn.parse(body.blueReturn);
    expect(parsed.fiscalYear).toBe(2026);
    expect(parsed.status).toBe("open");
    expect(amountOf(parsed, 1)).toBe(1_000_000);
    expect(amountOf(parsed, 12)).toBe(20_000);
    expect(amountOf(parsed, 17)).toBe(100_000);
    expect(amountOf(parsed, 43)).toBe(880_000);
    expect(amountOf(parsed, 44)).toBeNull();
    expect(amountOf(parsed, 45)).toBeNull();
    expect(parsed.transfer).toEqual({ businessIncome: null, blueDeduction: null });
    expect(parsed.warnings.map((w) => w.code)).toContain("DEDUCTION_ANSWERS_MISSING");
  });

  it("回答を保存すると欄44・45 が計算される", async () => {
    const put = await br()["deduction-answers"].$put({ param: param(), json: ANSWERS });
    expect(put.status).toBe(200);
    const res = await br().$get({ param: param() });
    const parsed = BlueReturn.parse(((await res.json()) as { blueReturn: unknown }).blueReturn);
    expect(parsed.transfer).toEqual({ businessIncome: 230_000, blueDeduction: 650_000 });
  });

  it("使わない欄は常に 0（blankUnused は受けない）", async () => {
    // 型は query を受けない。実行時にクエリを付けても無視されることを確かめる
    const res = await br().$get({
      param: param(),
      query: { blankUnused: "true" },
    } as unknown as Parameters<ReturnType<typeof br>["$get"]>[0]);
    expect(res.status).toBe(200);
    const parsed = BlueReturn.parse(((await res.json()) as { blueReturn: unknown }).blueReturn);
    expect(amountOf(parsed, 2)).toBe(0);
  });

  it("存在しない年度は 400 VALIDATION（001 の締め・解除と同じ）、年が数字でなくても 400", async () => {
    const missing = await br().$get({ param: param("1999") });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("VALIDATION");
    const bad = await br().$get({ param: param("abcd") });
    expect(bad.status).toBe(400);
  });
});

describe("3 ページの減価償却の行（009 US1）", () => {
  it("定額法の資産は償却率・本年中の償却期間・出所・方法を持つ。確定すると警告なしで一致する", async () => {
    const created = await e["fixed-assets"].$post({
      param: { entityId },
      json: {
        name: "機材A",
        acquiredOn: "2026-07-10",
        inServiceOn: "2026-07-10",
        acquisitionCost: 500_000,
        method: "straight_line",
        usefulLifeYears: 4,
        businessRatio: 10000,
        assetAccountId: acc("工具器具備品"),
      } as never,
    });
    expect(created.status).toBe(201);
    const commit = await br().adjustments.$post({
      param: param(),
      json: {
        kind: "depreciation",
        sourceId: ((await created.json()) as { asset: { id: string } }).asset.id,
        expected: { amount: 62_500 },
      } as never,
    });
    expect(commit.status).toBe(201);
    const res = await br().$get({ param: param() });
    const parsed = BlueReturn.parse(((await res.json()) as { blueReturn: unknown }).blueReturn);
    expect(parsed.page3.depreciation).toHaveLength(1);
    expect(parsed.page3.depreciation[0]).toMatchObject({
      source: "fixed_asset",
      method: "straight_line",
      ratePermille: 250,
      months: 6,
      disposedOn: null,
      total: 62_500,
      closingBookValue: 437_500,
    });
    expect(parsed.warnings.map((w) => w.code)).not.toContain("DEPRECIATION_MISMATCH");
  });
});

describe("GET /blue-return/:year/csv（FR-003, R14）", () => {
  beforeEach(async () => {
    await simple("普通預金", "売上高", 500_000, "2026-03-31");
  });

  const fetchCsv = async (query?: { blankUnused: "true" | "false" }) => {
    const res = await br().csv.$get({ param: param(), query: query ?? {} });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    return new TextDecoder().decode(bytes).split("\r\n");
  };

  it("既定は使わない欄を 0 で出す", async () => {
    const lines = await fetchCsv();
    expect(lines[0]).toBe("ページ,欄番号,欄名,金額");
    expect(lines).toContain("1,2,期首商品（製品）棚卸高,0");
    expect(lines.some((l) => l.startsWith("1,1,") && l.endsWith(",500000"))).toBe(true);
  });

  it("?blankUnused=true は使わない欄の金額を空にする", async () => {
    const lines = await fetchCsv({ blankUnused: "true" });
    expect(lines).toContain("1,2,期首商品（製品）棚卸高,");
    expect(lines.some((l) => l.startsWith("1,1,") && l.endsWith(",500000"))).toBe(true);
  });

  it("?blankUnused に true・false 以外は 400", async () => {
    const res = await br().csv.$get({ param: param(), query: { blankUnused: "maybe" as "true" } });
    expect(res.status).toBe(400);
  });

  it("存在しない年度は 400 VALIDATION", async () => {
    const res = await br().csv.$get({ param: param("1999"), query: {} });
    expect(res.status).toBe(400);
  });
});

describe("GET / PUT /blue-return/:year/deduction-answers（FR-010）", () => {
  it("回答がなければ { answers: null, cap: null }", async () => {
    const res = await br()["deduction-answers"].$get({ param: param() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answers: null, cap: null });
  });

  it("PUT は 200 で回答と上限額を返し、GET で読み戻せる", async () => {
    const put = await br()["deduction-answers"].$put({ param: param(), json: ANSWERS });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      answers: { fiscalYear: 2026, ...ANSWERS },
      cap: { cap: 650_000, tier: "max", unmet: [] },
    });

    const downgraded = await br()["deduction-answers"].$put({
      param: param(),
      json: { ...ANSWERS, eTax: false },
    });
    expect(await downgraded.json()).toMatchObject({
      cap: { cap: 550_000, tier: "standard" },
    });
    const got = await br()["deduction-answers"].$get({ param: param() });
    expect(await got.json()).toMatchObject({
      answers: { eTax: false },
      cap: { tier: "standard" },
    });
  });

  it("PUT の入力が正しくなければ 400 VALIDATION", async () => {
    const res = await br()["deduction-answers"].$put({
      param: param(),
      // biome-ignore lint/suspicious/noExplicitAny: 不正な入力を送る
      json: { doubleEntry: "yes" } as any,
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("存在しない年度は 400 VALIDATION", async () => {
    const res = await br()["deduction-answers"].$put({ param: param("1999"), json: ANSWERS });
    expect(res.status).toBe(400);
  });
});

describe("法人の事業体", () => {
  let corpId: string;
  beforeEach(async () => {
    const res = await client.api.entities.$post({
      json: { name: "法人", kind: "corporation", fiscalStartMonth: 4, firstFiscalYear: 2026 },
    });
    if (res.status !== 201) throw new Error(`entity create failed: ${res.status}`);
    corpId = (await res.json()).entity.id;
  });

  it("決算書・CSV・控除の回答はすべて 422 ENTITY_KIND_UNSUPPORTED", async () => {
    const p = { entityId: corpId, year: "2026" };
    const responses = [
      await br().$get({ param: p }),
      await br().csv.$get({ param: p, query: {} }),
      await br()["deduction-answers"].$get({ param: p }),
      await br()["deduction-answers"].$put({ param: p, json: ANSWERS }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe("ENTITY_KIND_UNSUPPORTED");
    }
  });
});
