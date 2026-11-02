import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLookup, client, createTestEntity, errorOf, okBody } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;
let acc: (name: string) => string;

const e = client.api.entities[":entityId"];
const assets = e["fixed-assets"];
const one = () => assets[":assetId"];

beforeEach(async () => {
  tmp = useTempDataDir("server-fixed-assets");
  entityId = await createTestEntity();
  acc = await accountLookup(entityId);
});
afterEach(() => tmp.cleanup());

const body = (over: Record<string, unknown> = {}) => ({
  name: "ノートパソコン",
  acquiredOn: "2026-06-15",
  acquisitionCost: 200_000,
  method: "small_asset_28_2",
  businessRatio: 10000,
  assetAccountId: acc("工具器具備品"),
  ...over,
});

type PostJson = Parameters<typeof assets.$post>[0]["json"];
const post = (over: Record<string, unknown> = {}) =>
  assets.$post({ param: { entityId }, json: body(over) as PostJson });

const create = async (over: Record<string, unknown> = {}) => {
  const res = await post(over);
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return (await okBody(res)).asset;
};

describe("POST /fixed-assets（FR-018〜020）", () => {
  it("201 で { asset } を返す", async () => {
    const res = await post({ note: "業務用" });
    expect(res.status).toBe(201);
    const { asset } = await okBody(res);
    expect(asset).toMatchObject({
      name: "ノートパソコン",
      acquisitionCost: 200_000,
      method: "small_asset_28_2",
      businessRatio: 10000,
      note: "業務用",
      disposedOn: null,
      linkedJournalId: null,
    });
  });

  it("422: 資産の勘定が資産の科目でなければ ASSET_ACCOUNT_INVALID", async () => {
    const res = await post({ assetAccountId: acc("地代家賃") });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("ASSET_ACCOUNT_INVALID");
  });

  it("422: 取得価額が基準額以上なら SMALL_ASSET_OVER_THRESHOLD（details.threshold）", async () => {
    const res = await post({ acquisitionCost: 400_000 });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("SMALL_ASSET_OVER_THRESHOLD");
    expect(error.details).toMatchObject({ threshold: 400_000 });
  });

  it("422: 同じ年の合計が上限を超えれば SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED（details.limit・total）", async () => {
    for (let i = 0; i < 7; i++) await create({ acquisitionCost: 399_000, name: `備品${i}` });
    const res = await post({ acquisitionCost: 399_000 });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED");
    expect(error.details).toMatchObject({ limit: 3_000_000, total: 8 * 399_000 });
  });

  it("422: 特例の適用期間の外の取得なら SMALL_ASSET_NOT_APPLICABLE", async () => {
    const res = await post({ acquiredOn: "2030-01-01" });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("SMALL_ASSET_NOT_APPLICABLE");
  });

  it("償却の方法が 3 つ以外なら 400 VALIDATION（形の検査）。DEPRECIATION_METHOD_UNSUPPORTED は domain の防御で、HTTP からは届かない", async () => {
    const res = await post({ method: "declining_balance" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("422 のとき何も登録されない", async () => {
    await post({ acquisitionCost: 400_000 });
    const res = await assets.$get({ param: { entityId }, query: {} });
    expect((await okBody(res)).assets).toEqual([]);
  });
});

describe("GET /fixed-assets", () => {
  it("?year= を付けると各資産に depreciation（取得した年は全額償却）を付ける", async () => {
    const asset = await create({ businessRatio: 5000 });
    const res = await assets.$get({ param: { entityId }, query: { year: "2026" } });
    expect(res.status).toBe(200);
    const { assets: rows } = await okBody(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: asset.id,
      depreciation: {
        cost: 200_000,
        base: 200_000,
        ordinary: 200_000,
        total: 200_000,
        businessRatio: 5000,
        deductible: 100_000,
        closingBookValue: 0,
      },
    });
    const next = await assets.$get({ param: { entityId }, query: { year: "2027" } });
    expect((await okBody(next)).assets[0]?.depreciation).toMatchObject({ total: 0, deductible: 0 });
  });

  it("year がなければ depreciation は null", async () => {
    await create();
    const res = await assets.$get({ param: { entityId }, query: {} });
    expect((await okBody(res)).assets[0]?.depreciation).toBeNull();
  });

  it("year の形が違えば 400 VALIDATION", async () => {
    const res = await assets.$get({ param: { entityId }, query: { year: "26" } });
    expect(res.status).toBe(400);
  });
});

describe("PUT /fixed-assets/:assetId", () => {
  it("200 で { asset } を返し、同じ ID のまま更新する（自分自身を年間の上限に数えない）", async () => {
    for (let i = 0; i < 6; i++) await create({ acquisitionCost: 399_000, name: `備品${i}` });
    const asset = await create({ acquisitionCost: 399_000 }); // 合計 2,793,000
    const res = await one().$put({
      param: { entityId, assetId: asset.id },
      json: body({
        acquisitionCost: 399_000,
        businessRatio: 5000,
        reason: "割合の見直し",
      }) as never,
    });
    expect(res.status).toBe(200);
    expect((await okBody(res)).asset).toMatchObject({
      id: asset.id,
      businessRatio: 5000,
      createdAt: asset.createdAt,
    });
    const list = await assets.$get({ param: { entityId }, query: {} });
    expect((await okBody(list)).assets).toHaveLength(7);
  });

  it("422 のとき資産は変わらない。存在しない ID は 400 VALIDATION", async () => {
    const asset = await create();
    const bad = await one().$put({
      param: { entityId, assetId: asset.id },
      json: body({ assetAccountId: acc("地代家賃") }) as never,
    });
    expect(bad.status).toBe(422);
    expect((await errorOf(bad)).code).toBe("ASSET_ACCOUNT_INVALID");
    const list = await assets.$get({ param: { entityId }, query: {} });
    expect((await okBody(list)).assets[0]).toMatchObject({ assetAccountId: acc("工具器具備品") });

    const missing = await one().$put({
      param: { entityId, assetId: "0190f3a0-0000-7000-8000-000000000001" },
      json: body() as never,
    });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("VALIDATION");
  });
});

describe("POST /fixed-assets/:assetId/dispose", () => {
  it("200 で除却の日を記録する。台帳には残る（物理削除しない）", async () => {
    const asset = await create();
    const res = await one().dispose.$post({
      param: { entityId, assetId: asset.id },
      json: { disposedOn: "2026-12-01", reason: "廃棄" },
    });
    expect(res.status).toBe(200);
    expect((await okBody(res)).asset).toMatchObject({ id: asset.id, disposedOn: "2026-12-01" });
    const list = await assets.$get({ param: { entityId }, query: { year: "2026" } });
    expect((await okBody(list)).assets).toHaveLength(1);
  });

  it("取得の日より前の除却の日・存在しない資産は 400 VALIDATION。形が違えば 400", async () => {
    const asset = await create();
    const early = await one().dispose.$post({
      param: { entityId, assetId: asset.id },
      json: { disposedOn: "2026-06-14", reason: "廃棄" },
    });
    expect(early.status).toBe(400);
    expect((await errorOf(early)).code).toBe("VALIDATION");
    const missing = await one().dispose.$post({
      param: { entityId, assetId: "0190f3a0-0000-7000-8000-000000000001" },
      json: { disposedOn: "2026-12-01", reason: "廃棄" },
    });
    expect(missing.status).toBe(400);
    const malformed = await one().dispose.$post({
      param: { entityId, assetId: asset.id },
      json: { disposedOn: "2026-13-01", reason: "廃棄" },
    });
    expect(malformed.status).toBe(400);
    const list = await assets.$get({ param: { entityId }, query: {} });
    expect((await okBody(list)).assets[0]?.disposedOn).toBeNull();
  });
});

const straightLine = (over: Record<string, unknown> = {}) => ({
  name: "機材A",
  acquiredOn: "2026-07-10",
  inServiceOn: "2026-07-10",
  acquisitionCost: 500_000,
  method: "straight_line",
  usefulLifeYears: 4,
  businessRatio: 10000,
  ...over,
});

describe("定額法（009 US1。FR-001〜002）", () => {
  it("定額法を登録でき、?year= の depreciation に償却率・月数・償却費・未償却残高が出る", async () => {
    const asset = await create(straightLine());
    expect(asset).toMatchObject({
      method: "straight_line",
      usefulLifeYears: 4,
      inServiceOn: "2026-07-10",
      priorAccumulated: 0,
      priorThroughYear: null,
      disposalKind: null,
    });
    const res = await assets.$get({ param: { entityId }, query: { year: "2026" } });
    const { assets: rows } = await okBody(res);
    expect(rows[0]).toMatchObject({
      id: asset.id,
      depreciationError: null,
      depreciation: {
        method: "straight_line",
        ratePermille: 250,
        months: 6,
        total: 62_500,
        deductible: 62_500,
        closingBookValue: 437_500,
      },
    });
  });

  it("前年までの累計と年を保存する", async () => {
    const asset = await create(
      straightLine({
        acquiredOn: "2025-01-10",
        inServiceOn: null,
        priorAccumulated: 100_000,
        priorThroughYear: 2025,
      }),
    );
    expect(asset).toMatchObject({ priorAccumulated: 100_000, priorThroughYear: 2025 });
  });

  it("422: 耐用年数が率の表になければ USEFUL_LIFE_UNSUPPORTED（details.usefulLifeYears）", async () => {
    const res = await post(straightLine({ usefulLifeYears: 1 }));
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("USEFUL_LIFE_UNSUPPORTED");
    expect(error.details).toMatchObject({ usefulLifeYears: 1 });
  });

  it("422: 累計が取得価額 - 1 を超えれば PRIOR_ACCUMULATED_INVALID", async () => {
    const res = await post(
      straightLine({ priorAccumulated: 500_000, priorThroughYear: 2025, acquiredOn: "2024-01-10" }),
    );
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("PRIOR_ACCUMULATED_INVALID");
  });

  it("400: 累計が負なら VALIDATION、disposalKind の不明値も 400", async () => {
    const neg = await post(straightLine({ priorAccumulated: -1 }));
    expect(neg.status).toBe(400);
    const asset = await create(straightLine());
    const bad = await one().dispose.$post({
      param: { entityId, assetId: asset.id },
      json: { disposedOn: "2026-10-05", reason: "x", disposalKind: "gift" } as never,
    });
    expect(bad.status).toBe(400);
  });
});

describe("除却の種類（009 FR-009）", () => {
  const br = () => e["blue-return"][":year"];
  const proposalFor = async (assetId: string) => {
    const got = await br().adjustments.$get({ param: { entityId, year: "2026" } });
    const { proposals } = await okBody(got);
    return proposals.find((p) => p.sourceId === assetId);
  };

  it("dispose の disposalKind を保存し、省略は scrap。案の内訳に反映される", async () => {
    const scrap = await create(straightLine({ name: "廃棄する機材" }));
    const sale = await create(straightLine({ name: "売却する機材" }));
    const r1 = await one().dispose.$post({
      param: { entityId, assetId: scrap.id },
      json: { disposedOn: "2026-10-05", reason: "廃棄" },
    });
    expect((await okBody(r1)).asset).toMatchObject({ disposalKind: "scrap" });
    const r2 = await one().dispose.$post({
      param: { entityId, assetId: sale.id },
      json: { disposedOn: "2026-10-05", reason: "売却", disposalKind: "sale" },
    });
    expect((await okBody(r2)).asset).toMatchObject({ disposalKind: "sale" });
    expect((await proposalFor(scrap.id))?.breakdown).toMatchObject({ disposalKind: "scrap" });
    expect((await proposalFor(sale.id))?.breakdown).toMatchObject({ disposalKind: "sale" });
  });
});

describe("償却の仕訳があるときの変更の制限（009/R12）", () => {
  const br = () => e["blue-return"][":year"];

  const registerDepreciation = async (assetId: string, amount: number) => {
    const res = await br().adjustments.$post({
      param: { entityId, year: "2026" },
      json: { kind: "depreciation", sourceId: assetId, expected: { amount } } as never,
    });
    if (res.status !== 201) throw new Error(`commit failed: ${res.status}`);
  };

  it("409 DEPRECIATION_JOURNAL_EXISTS（details.years）: 計算に効く項目の PUT と dispose。名称だけの PUT は通る", async () => {
    const asset = await create(straightLine());
    await registerDepreciation(asset.id, 62_500);
    const full = (over: Record<string, unknown>) =>
      ({ ...asset, ...straightLine(), assetAccountId: asset.assetAccountId, ...over }) as never;

    const put = await one().$put({
      param: { entityId, assetId: asset.id },
      json: full({ acquisitionCost: 600_000, reason: "訂正" }),
    });
    expect(put.status).toBe(409);
    const putError = await errorOf(put);
    expect(putError.code).toBe("DEPRECIATION_JOURNAL_EXISTS");
    expect(putError.details).toMatchObject({ years: [2026] });

    const dispose = await one().dispose.$post({
      param: { entityId, assetId: asset.id },
      json: { disposedOn: "2026-10-05", reason: "廃棄" },
    });
    expect(dispose.status).toBe(409);
    expect((await errorOf(dispose)).code).toBe("DEPRECIATION_JOURNAL_EXISTS");

    const rename = await one().$put({
      param: { entityId, assetId: asset.id },
      json: full({ name: "機材A（改）", reason: "名称の修正" }),
    });
    expect(rename.status).toBe(200);
  });

  it("少額の特例の資産にも効く", async () => {
    const asset = await create();
    await registerDepreciation(asset.id, 200_000);
    const dispose = await one().dispose.$post({
      param: { entityId, assetId: asset.id },
      json: { disposedOn: "2026-12-01", reason: "廃棄" },
    });
    expect(dispose.status).toBe(409);
  });
});

describe("減価償却の案（FR-021〜023）", () => {
  it("資産を登録すると案が出て、確定すると3ページと欄18 が一致して案が消える", async () => {
    const asset = await create();
    const br = e["blue-return"][":year"];
    const param = { entityId, year: "2026" };
    const got = await br.adjustments.$get({ param });
    const { proposals } = await okBody(got);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: "depreciation", sourceId: asset.id });
    const commit = await br.adjustments.$post({
      param,
      json: {
        kind: "depreciation",
        sourceId: asset.id,
        expected: { amount: 200_000 },
      } as never,
    });
    expect(commit.status).toBe(201);
    const after = await br.adjustments.$get({ param });
    expect((await okBody(after)).proposals).toEqual([]);
  });
});

const lumpSum = (over: Record<string, unknown> = {}) => ({
  name: "プリンター一式",
  acquiredOn: "2026-07-10",
  acquisitionCost: 150_000,
  method: "lump_sum",
  businessRatio: 10000,
  assetAccountId: acc("一括償却資産"),
  ...over,
});

describe("一括償却資産（009 US2。FR-003、FR-010〜011）", () => {
  it("登録でき、?year= の depreciation に年の額・未償却残高が出る（月割りしない。除却損は 0）", async () => {
    const asset = await create(lumpSum());
    expect(asset).toMatchObject({ method: "lump_sum", usefulLifeYears: null, disposalKind: null });
    for (const [year, total, closing] of [
      ["2026", 50_000, 100_000],
      ["2028", 50_000, 0],
      ["2029", 0, 0],
    ] as const) {
      const res = await assets.$get({ param: { entityId }, query: { year } });
      const { assets: rows } = await okBody(res);
      expect(rows[0]).toMatchObject({
        id: asset.id,
        depreciationError: null,
        depreciation: {
          method: "lump_sum",
          ratePermille: null,
          months: null,
          total,
          closingBookValue: closing,
          disposalAmount: 0,
          disposalDeductible: 0,
        },
      });
    }
  });

  it("除却しても翌年度以後の額は変わらない", async () => {
    const asset = await create(lumpSum({ acquisitionCost: 100_000 }));
    const res = await one().dispose.$post({
      param: { entityId, assetId: asset.id },
      json: { disposedOn: "2026-10-05", reason: "処分", disposalKind: "scrap" },
    });
    expect(res.status).toBe(200);
    const totals: number[] = [];
    for (const year of ["2026", "2027", "2028"]) {
      const list = await assets.$get({ param: { entityId }, query: { year } });
      totals.push((await okBody(list)).assets[0]?.depreciation?.total ?? -1);
    }
    expect(totals).toEqual([33_333, 33_333, 33_334]);
  });

  it("422: 取得価額が範囲外（10 万円未満、20 万円以上）なら LUMP_SUM_COST_OUT_OF_RANGE（details.min・max）", async () => {
    for (const cost of [99_999, 200_000]) {
      const res = await post(lumpSum({ acquisitionCost: cost }));
      expect(res.status).toBe(422);
      const error = await errorOf(res);
      expect(error.code).toBe("LUMP_SUM_COST_OUT_OF_RANGE");
      expect(error.details).toMatchObject({ min: 100_000, max: 200_000 });
    }
    const list = await assets.$get({ param: { entityId }, query: {} });
    expect((await okBody(list)).assets).toEqual([]);
  });

  it("422: 累計が取得価額を超えれば PRIOR_ACCUMULATED_INVALID。耐用年数を持つと VALIDATION", async () => {
    const prior = await post(lumpSum({ priorAccumulated: 150_001, priorThroughYear: 2026 }));
    expect(prior.status).toBe(422);
    expect((await errorOf(prior)).code).toBe("PRIOR_ACCUMULATED_INVALID");
    const life = await post(lumpSum({ usefulLifeYears: 4 }));
    expect(life.status).toBe(400);
    expect((await errorOf(life)).code).toBe("VALIDATION");
  });

  it("一括償却は少額の特例の年間の上限の集計に入らない", async () => {
    for (let i = 0; i < 7; i++) await create({ acquisitionCost: 399_000, name: `備品${i}` });
    await create(lumpSum({ acquisitionCost: 199_999, acquiredOn: "2026-06-15" }));
    // 少額 2,793,000 円 + 207,000 円 = 上限 3,000,000 円ちょうど
    const res = await post({ acquisitionCost: 207_000, name: "備品8" });
    expect(res.status).toBe(201);
  });

  it("案: 供用の年の案が出て、確定すると案が消える", async () => {
    const asset = await create(lumpSum());
    const br = e["blue-return"][":year"];
    const param = { entityId, year: "2026" };
    const { proposals } = await okBody(await br.adjustments.$get({ param }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "depreciation",
      sourceId: asset.id,
      breakdown: { method: "lump_sum", depreciation: 50_000, disposalAmount: 0 },
    });
    const commit = await br.adjustments.$post({
      param,
      json: { kind: "depreciation", sourceId: asset.id, expected: { amount: 50_000 } } as never,
    });
    expect(commit.status).toBe(201);
    expect((await okBody(await br.adjustments.$get({ param }))).proposals).toEqual([]);
  });
});
