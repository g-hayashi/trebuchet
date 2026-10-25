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

  it("償却の方法が特例以外なら 400 VALIDATION（形の検査）。DEPRECIATION_METHOD_UNSUPPORTED は domain の防御で、HTTP からは届かない", async () => {
    const res = await post({ method: "straight_line" });
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
