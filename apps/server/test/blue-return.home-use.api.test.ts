import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { BlueReturn } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountLookup,
  client,
  createTestEntity,
  errorOf,
  okBody,
  postSimpleJournal,
} from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;
let acc: (name: string) => string;

const e = client.api.entities[":entityId"];
const br = () => e["blue-return"][":year"];
const param = (year = "2026") => ({ entityId, year });

beforeEach(async () => {
  tmp = useTempDataDir("server-blue-return-home-use");
  entityId = await createTestEntity();
  acc = await accountLookup(entityId);
});
afterEach(() => tmp.cleanup());

const simple = (debit: string, credit: string, amount: number, date: string) =>
  postSimpleJournal(entityId, acc, debit, credit, amount, date);

const allocationBody = (over: Record<string, unknown> = {}) => ({
  accountId: acc("地代家賃"),
  businessRatio: 3000,
  basis: "床面積 15㎡／50㎡",
  ...over,
});

const putAllocation = (over: Record<string, unknown> = {}, year = "2026") =>
  br()["home-use"].$put({
    param: param(year),
    json: allocationBody(over) as Parameters<ReturnType<typeof br>["home-use"]["$put"]>[0]["json"],
  });

const warningsOf = async (code: string) => {
  const res = await br().$get({ param: param() });
  const body = BlueReturn.parse(((await res.json()) as { blueReturn: unknown }).blueReturn);
  return body.warnings.filter((w) => w.code === code);
};

describe("GET / PUT /blue-return/:year/home-use（FR-012〜013）", () => {
  it("PUT は 200 で { allocation } を返し、GET は { allocations, previousYear } を返す", async () => {
    const empty = await br()["home-use"].$get({ param: param() });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ allocations: [], previousYear: [] });

    const put = await putAllocation();
    expect(put.status).toBe(200);
    const { allocation } = await okBody(put);
    expect(allocation).toMatchObject({
      fiscalYear: 2026,
      accountId: acc("地代家賃"),
      subAccountId: null,
      businessRatio: 3000,
      basis: "床面積 15㎡／50㎡",
    });

    const again = await putAllocation({ businessRatio: 3000, basis: "更新後の根拠" });
    expect((await okBody(again)).allocation.id).toBe(allocation.id);
    const got = await br()["home-use"].$get({ param: param() });
    const body = await okBody(got);
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0]).toMatchObject({ id: allocation.id, basis: "更新後の根拠" });
    expect(body.previousYear).toEqual([]);
  });

  it("422 HOME_USE_ACCOUNT_INVALID: 費用でない科目", async () => {
    const res = await putAllocation({ accountId: acc("普通預金") });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("HOME_USE_ACCOUNT_INVALID");
  });

  it("422 HOME_USE_BASIS_REQUIRED: 根拠が空（空白だけも）", async () => {
    for (const basis of ["", "   "]) {
      const res = await putAllocation({ basis });
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe("HOME_USE_BASIS_REQUIRED");
    }
    const got = await br()["home-use"].$get({ param: param() });
    expect((await okBody(got)).allocations).toEqual([]);
  });

  it("422 HOME_USE_CHANGE_REASON_REQUIRED: 前の年度と割合が違うのに理由がない。理由があれば保存でき、GET に前の年度が載る", async () => {
    expect((await putAllocation({ businessRatio: 3000 }, "2026")).status).toBe(200);
    const next = await e["fiscal-periods"].$post({ param: { entityId } });
    expect(next.status).toBe(201);

    const noReason = await putAllocation({ businessRatio: 4000 }, "2027");
    expect(noReason.status).toBe(422);
    expect((await errorOf(noReason)).code).toBe("HOME_USE_CHANGE_REASON_REQUIRED");

    const ok = await putAllocation({ businessRatio: 4000, changeReason: "事務所を広げた" }, "2027");
    expect(ok.status).toBe(200);
    const got = await br()["home-use"].$get({ param: param("2027") });
    const body = await okBody(got);
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0]).toMatchObject({
      businessRatio: 4000,
      changeReason: "事務所を広げた",
    });
    expect(body.previousYear).toHaveLength(1);
    expect(body.previousYear[0]).toMatchObject({ fiscalYear: 2026, businessRatio: 3000 });
  });

  it("400 VALIDATION: 割合が範囲外、存在しない年度。締め済みの年度でも保存できる", async () => {
    const bad = await putAllocation({ businessRatio: 10001 });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("VALIDATION");
    const missing = await br()["home-use"].$get({ param: param("1999") });
    expect(missing.status).toBe(400);

    const closed = await e["fiscal-periods"][":year"].close.$post({ param: param() });
    expect(closed.status).toBe(200);
    expect((await putAllocation()).status).toBe(200);
  });
});

describe("GET / PUT /blue-return/:year/rent-details（FR-017）", () => {
  const rows = [
    { payee: "大家A", property: "事務所", annualRent: 1_200_000, deductibleAmount: 360_000 },
    { payee: "大家B", property: "駐車場", annualRent: 240_000, deductibleAmount: 240_000 },
  ];

  it("PUT は全件を置き換えて 200 { rows }、GET で読み戻せる。決算書の2ページに載る", async () => {
    const empty = await br()["rent-details"].$get({ param: param() });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ rows: [] });

    const put = await br()["rent-details"].$put({ param: param(), json: { rows } });
    expect(put.status).toBe(200);
    const saved = (await okBody(put)).rows;
    expect(saved.map((r) => [r.payee, r.sortOrder])).toEqual([
      ["大家A", 0],
      ["大家B", 1],
    ]);
    const got = await br()["rent-details"].$get({ param: param() });
    expect((await okBody(got)).rows).toEqual(saved);

    const blue = await br().$get({ param: param() });
    const parsed = BlueReturn.parse(((await blue.json()) as { blueReturn: unknown }).blueReturn);
    expect(parsed.page2.rentDetails.map((r) => r.payee)).toEqual(["大家A", "大家B"]);

    const cleared = await br()["rent-details"].$put({ param: param(), json: { rows: [] } });
    expect(await cleared.json()).toEqual({ rows: [] });
  });

  it("400 VALIDATION: 必要経費算入額が賃借料を超える", async () => {
    const res = await br()["rent-details"].$put({
      param: param(),
      json: { rows: [{ ...rows[0], deductibleAmount: 1_200_001 }] } as never,
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});

describe("GET / POST /blue-return/:year/adjustments（FR-014〜016）", () => {
  let allocationId: string;

  beforeEach(async () => {
    await simple("地代家賃", "普通預金", 1_200_000, "2026-06-30");
    const put = await putAllocation();
    allocationId = (await okBody(put)).allocation.id;
  });

  const commit = (amount: number, over: Record<string, unknown> = {}) =>
    br().adjustments.$post({
      param: param(),
      json: {
        kind: "home_use",
        sourceId: allocationId,
        expected: { amount },
        ...over,
      } as never,
    });

  it("GET は差があるものだけ { proposals } で返す（年度末日付、事業主貸 / 地代家賃、対象外の税区分）", async () => {
    const res = await br().adjustments.$get({ param: param() });
    expect(res.status).toBe(200);
    const { proposals } = await okBody(res);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "home_use",
      sourceId: allocationId,
      breakdown: { bookAmount: 1_200_000, ratio: 3000, business: 360_000, home: 840_000 },
      journal: {
        date: "2026-12-31",
        lines: [
          {
            side: "debit",
            accountId: acc("事業主貸"),
            amount: 840_000,
            taxCategory: "OUT_OF_SCOPE",
          },
          {
            side: "credit",
            accountId: acc("地代家賃"),
            amount: 840_000,
            taxCategory: "OUT_OF_SCOPE",
          },
        ],
      },
    });
    // 振替の前は決算書が警告する
    const stale = await warningsOf("HOME_USE_ADJUSTMENT_STALE");
    expect(stale.map((w) => w.details?.difference)).toEqual([840_000]);
  });

  it("POST は 201 { journal, ref } で登録し、案と警告が消える。もう一度は 422 ADJUSTMENT_NOT_NEEDED", async () => {
    const res = await commit(840_000);
    expect(res.status).toBe(201);
    const { journal, ref } = await okBody(res);
    expect(journal).toMatchObject({ date: "2026-12-31" });
    expect(journal.lines.map((l) => [l.side, l.amount, l.taxCategory])).toEqual([
      ["debit", 840_000, "OUT_OF_SCOPE"],
      ["credit", 840_000, "OUT_OF_SCOPE"],
    ]);
    expect(ref).toEqual({
      journalId: journal.id,
      kind: "home_use",
      allocationId,
      assetId: null,
      fiscalYear: 2026,
    });

    const after = await br().adjustments.$get({ param: param() });
    expect((await okBody(after)).proposals).toEqual([]);
    expect(await warningsOf("HOME_USE_ADJUSTMENT_STALE")).toEqual([]);

    const again = await commit(840_000);
    expect(again.status).toBe(422);
    expect((await errorOf(again)).code).toBe("ADJUSTMENT_NOT_NEEDED");
  });

  it("409 ADJUSTMENT_CHANGED: 画面が見た金額と違う。details.proposal に新しい案、何も登録しない", async () => {
    const res = await commit(500_000);
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("ADJUSTMENT_CHANGED");
    expect(error.details).toMatchObject({
      expected: 500_000,
      actual: 840_000,
      proposal: { kind: "home_use", sourceId: allocationId },
    });
    const still = await br().adjustments.$get({ param: param() });
    expect((await okBody(still)).proposals).toHaveLength(1);
  });

  it("409 PERIOD_CLOSED: 締め済みの年度は登録できない", async () => {
    const closed = await e["fiscal-periods"][":year"].close.$post({ param: param() });
    expect(closed.status).toBe(200);
    const res = await commit(840_000);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("PERIOD_CLOSED");
  });

  it("400 VALIDATION: 入力の形が違う、按分の登録がない sourceId", async () => {
    const bad = await commit(0);
    expect(bad.status).toBe(400);
    const unknown = await commit(840_000, { sourceId: "0190f3a0-0000-7000-8000-000000000001" });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).code).toBe("VALIDATION");
  });
});

describe("法人の事業体", () => {
  it("按分・内訳・案はすべて 422 ENTITY_KIND_UNSUPPORTED", async () => {
    const created = await client.api.entities.$post({
      json: { name: "法人", kind: "corporation", fiscalStartMonth: 4, firstFiscalYear: 2026 },
    });
    const corpId = (await okBody(created)).entity.id;
    const p = { entityId: corpId, year: "2026" };
    const responses = [
      await br()["home-use"].$get({ param: p }),
      await br()["rent-details"].$get({ param: p }),
      await br()["rent-details"].$put({ param: p, json: { rows: [] } }),
      await br().adjustments.$get({ param: p }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe("ENTITY_KIND_UNSUPPORTED");
    }
  });
});
