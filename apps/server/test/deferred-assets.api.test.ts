import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLookup, client, createTestEntity, errorOf, okBody } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;
let acc: (name: string) => string;

const e = client.api.entities[":entityId"];
const list = e["deferred-assets"];
const one = () => list[":deferredAssetId"];
const amortizationOf = () => one().amortizations[":year"];
const br = () => e["blue-return"][":year"];

beforeEach(async () => {
  tmp = useTempDataDir("server-deferred-assets");
  entityId = await createTestEntity();
  acc = await accountLookup(entityId);
});
afterEach(() => tmp.cleanup());

const body = (over: Record<string, unknown> = {}) => ({
  name: "開業準備費",
  totalAmount: 600_000,
  openedOn: "2026-04-10",
  accountId: acc("開業費"),
  ...over,
});

type PostJson = Parameters<typeof list.$post>[0]["json"];
const post = (over: Record<string, unknown> = {}) =>
  list.$post({ param: { entityId }, json: body(over) as PostJson });

const create = async (over: Record<string, unknown> = {}) => {
  const res = await post(over);
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return (await okBody(res)).deferredAsset;
};

const decide = (deferredAssetId: string, year: number, amount: number) =>
  amortizationOf().$put({
    param: { entityId, deferredAssetId, year: String(year) },
    json: { amount },
  });

const commit = (deferredAssetId: string, year: number, amount: number) =>
  br().adjustments.$post({
    param: { entityId, year: String(year) },
    json: {
      kind: "deferred_amortization",
      sourceId: deferredAssetId,
      expected: { amount },
    } as never,
  });

describe("POST /deferred-assets（FR-012）", () => {
  it("201 で { deferredAsset } を返す", async () => {
    const res = await post({ note: "開業前の費用" });
    expect(res.status).toBe(201);
    const { deferredAsset } = await okBody(res);
    expect(deferredAsset).toMatchObject({
      name: "開業準備費",
      totalAmount: 600_000,
      openedOn: "2026-04-10",
      priorAccumulated: 0,
      priorThroughYear: null,
      note: "開業前の費用",
    });
    expect(deferredAsset.id).toBeTruthy();
  });

  it("422: 勘定が資産の科目でなければ ASSET_ACCOUNT_INVALID。何も登録されない", async () => {
    const res = await post({ accountId: acc("地代家賃") });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("ASSET_ACCOUNT_INVALID");
    const got = await list.$get({ param: { entityId }, query: {} });
    expect((await okBody(got)).deferredAssets).toEqual([]);
  });

  it("422: 総額を超える累計は PRIOR_ACCUMULATED_INVALID。総額が 0 以下は 400 VALIDATION", async () => {
    const prior = await post({ priorAccumulated: 600_001, priorThroughYear: 2025 });
    expect(prior.status).toBe(422);
    expect((await errorOf(prior)).code).toBe("PRIOR_ACCUMULATED_INVALID");
    const zero = await post({ totalAmount: 0 });
    expect(zero.status).toBe(400);
    expect((await errorOf(zero)).code).toBe("VALIDATION");
  });

  it("422: 開業日に適用される月数の税制の値がなければ TAX_PARAMETER_MISSING（details.key・date）", async () => {
    const res = await post({ openedOn: "2005-04-10" });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("TAX_PARAMETER_MISSING");
    expect(error.details).toMatchObject({
      key: "OPENING_COST_AMORTIZATION_MONTHS",
      date: "2005-04-10",
    });
  });
});

describe("PUT /deferred-assets/:deferredAssetId（R12）", () => {
  const put = (deferredAssetId: string, over: Record<string, unknown> = {}) =>
    one().$put({
      param: { entityId, deferredAssetId },
      json: body({ reason: "見直し", ...over }) as never,
    });

  it("仕訳がなければ 200 で { deferredAsset }。同じ ID・作成日時のまま更新する", async () => {
    const asset = await create();
    const res = await put(asset.id, { totalAmount: 700_000 });
    expect(res.status).toBe(200);
    expect((await okBody(res)).deferredAsset).toMatchObject({
      id: asset.id,
      totalAmount: 700_000,
      createdAt: asset.createdAt,
    });
  });

  it("開業費がなければ 400 VALIDATION", async () => {
    const res = await put("missing");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("有効な償却の仕訳があれば、計算に効く項目の変更は 409 DEPRECIATION_JOURNAL_EXISTS（details.years）。名称だけの変更は通る", async () => {
    const asset = await create();
    expect((await decide(asset.id, 2026, 90_000)).status).toBe(200);
    expect((await commit(asset.id, 2026, 90_000)).status).toBe(201);

    const changed = await put(asset.id, { totalAmount: 700_000 });
    expect(changed.status).toBe(409);
    const error = await errorOf(changed);
    expect(error.code).toBe("DEPRECIATION_JOURNAL_EXISTS");
    expect(error.details).toMatchObject({ years: [2026] });

    const renamed = await put(asset.id, { name: "開業準備費（改）" });
    expect(renamed.status).toBe(200);
    expect((await okBody(renamed)).deferredAsset).toMatchObject({ name: "開業準備費（改）" });
  });
});

describe("GET /deferred-assets", () => {
  it("year がなければ amortization は null", async () => {
    await create();
    const res = await list.$get({ param: { entityId }, query: {} });
    expect(res.status).toBe(200);
    const { deferredAssets } = await okBody(res);
    expect(deferredAssets).toHaveLength(1);
    expect(deferredAssets[0]?.amortization).toBeNull();
  });

  it("?year= を付けると各開業費に amortization（期首残高・目安・決定・登録済み）を付ける", async () => {
    const asset = await create();
    const res = await list.$get({ param: { entityId }, query: { year: "2026" } });
    expect(res.status).toBe(200);
    const { deferredAssets } = await okBody(res);
    expect(deferredAssets[0]).toMatchObject({
      id: asset.id,
      amortization: {
        fiscalYear: 2026,
        openingBalance: 600_000,
        decision: null,
        registered: false,
        closingBalance: 600_000,
      },
    });
    expect(deferredAssets[0]?.amortization?.target).toBeGreaterThan(0);
  });
});

describe("PUT /deferred-assets/:deferredAssetId/amortizations/:year（FR-014〜015）", () => {
  it("200 で { amortization, proposal }。決定を保存し、一覧の amortization にも出る。仕訳はまだない", async () => {
    const asset = await create();
    const res = await decide(asset.id, 2026, 90_000);
    expect(res.status).toBe(200);
    const body = await okBody(res);
    expect(body.amortization).toMatchObject({
      fiscalYear: 2026,
      openingBalance: 600_000,
      closingBalance: 510_000,
      registered: false,
      decision: { amount: 90_000 },
    });
    expect(body.proposal).toMatchObject({
      kind: "deferred_amortization",
      sourceId: asset.id,
      breakdown: { amount: 90_000 },
    });
    const got = await list.$get({ param: { entityId }, query: { year: "2026" } });
    expect((await okBody(got)).deferredAssets[0]?.amortization).toMatchObject({
      decision: { amount: 90_000 },
    });
  });

  it("0 円は記録だけで proposal は null", async () => {
    const asset = await create();
    const res = await decide(asset.id, 2026, 0);
    expect(res.status).toBe(200);
    const body = await okBody(res);
    expect(body.proposal).toBeNull();
    expect(body.amortization.decision).toMatchObject({ amount: 0 });
  });

  it("422: 上限を超えれば DEFERRED_AMORTIZATION_OVER_LIMIT（details.limit）。決定は保存されない", async () => {
    const asset = await create();
    const res = await decide(asset.id, 2026, 600_001);
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("DEFERRED_AMORTIZATION_OVER_LIMIT");
    expect(error.details).toMatchObject({ limit: 600_000 });
    const got = await list.$get({ param: { entityId }, query: { year: "2026" } });
    expect((await okBody(got)).deferredAssets[0]?.amortization?.decision).toBeNull();
  });

  it("400: 額が負・小数なら VALIDATION。開業費がなければ VALIDATION", async () => {
    const asset = await create();
    for (const amount of [-1, 1.5]) {
      const res = await decide(asset.id, 2026, amount);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
    const missing = await decide("missing", 2026, 1000);
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("VALIDATION");
  });

  it("409: 仕訳を登録した年度の決定の変更は DEPRECIATION_JOURNAL_EXISTS", async () => {
    const asset = await create();
    await decide(asset.id, 2026, 90_000);
    expect((await commit(asset.id, 2026, 90_000)).status).toBe(201);
    const res = await decide(asset.id, 2026, 80_000);
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("DEPRECIATION_JOURNAL_EXISTS");
    expect(error.details).toMatchObject({ years: [2026] });
  });

  it("締め済みの年度は 409 PERIOD_CLOSED", async () => {
    const asset = await create();
    const closed = await e["fiscal-periods"][":year"].close.$post({
      param: { entityId, year: "2026" },
    });
    expect(closed.status).toBe(200);
    const res = await decide(asset.id, 2026, 90_000);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("PERIOD_CLOSED");
  });
});

describe("決算整理の案（FR-016〜017）", () => {
  it("決定後に adjustments の案に開業費が出て、確定すると仕訳が登録され案が消える", async () => {
    const asset = await create();
    await decide(asset.id, 2026, 90_000);
    const param = { entityId, year: "2026" };
    const { proposals } = await okBody(await br().adjustments.$get({ param }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "deferred_amortization",
      sourceId: asset.id,
      breakdown: { amount: 90_000, openingBalance: 600_000 },
    });

    const res = await commit(asset.id, 2026, 90_000);
    expect(res.status).toBe(201);
    const { journal, ref } = await okBody(res);
    expect(journal.status).toBe("active");
    expect(ref).toMatchObject({
      kind: "deferred_amortization",
      deferredAssetId: asset.id,
      fiscalYear: 2026,
      journalId: journal.id,
    });
    expect((await okBody(await br().adjustments.$get({ param }))).proposals).toEqual([]);

    const got = await list.$get({ param: { entityId }, query: { year: "2026" } });
    expect((await okBody(got)).deferredAssets[0]?.amortization).toMatchObject({
      registered: true,
      closingBalance: 510_000,
    });
  });
});
