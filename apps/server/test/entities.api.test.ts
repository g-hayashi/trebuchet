import { randomUUIDv7 } from "node:crypto";
import { DrizzleMasterRepository, openTenant } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { INDIVIDUAL_ACCOUNTS } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, createTestEntity, errorOf } from "./helpers.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server-entities");
});
afterEach(() => tmp.cleanup());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("POST /api/entities", () => {
  it("201 で事業体を作成し、初期の科目・会計期間・消費税の設定が入る", async () => {
    const res = await client.api.entities.$post({
      json: { name: " 個人事業 ", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
    });
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    const { entity } = await res.json();
    expect(entity).toEqual({
      id: expect.stringMatching(UUID),
      name: "個人事業",
      kind: "individual",
      fiscalStartMonth: 1,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });

    const param = { entityId: entity.id };
    const accounts = await client.api.entities[":entityId"].accounts.$get({ param });
    expect(accounts.status).toBe(200);
    if (accounts.status !== 200) return;
    expect((await accounts.json()).accounts).toHaveLength(INDIVIDUAL_ACCOUNTS.length);

    const periods = await client.api.entities[":entityId"]["fiscal-periods"].$get({ param });
    if (periods.status !== 200) throw new Error(String(periods.status));
    expect((await periods.json()).fiscalPeriods).toEqual([
      {
        id: expect.stringMatching(UUID),
        fiscalYear: 2026,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        status: "open",
        closedAt: null,
      },
    ]);

    const settings = await client.api.entities[":entityId"]["tax-settings"].$get({ param });
    if (settings.status !== 200) throw new Error(String(settings.status));
    expect((await settings.json()).taxSettings).toEqual([
      {
        id: expect.stringMatching(UUID),
        effectiveFrom: "2026-01-01",
        taxpayerStatus: "exempt",
        accountingMethod: "tax_included",
      },
    ]);
  });

  it("法人でも 201 で作成でき、期首月は指定どおり", async () => {
    const res = await client.api.entities.$post({
      json: { name: "株式会社X", kind: "corporation", fiscalStartMonth: 4, firstFiscalYear: 2026 },
    });
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    const { entity } = await res.json();
    const periods = await client.api.entities[":entityId"]["fiscal-periods"].$get({
      param: { entityId: entity.id },
    });
    if (periods.status !== 200) throw new Error(String(periods.status));
    expect((await periods.json()).fiscalPeriods).toMatchObject([
      { fiscalYear: 2026, startDate: "2026-04-01", endDate: "2027-03-31" },
    ]);
  });

  it.each([
    { name: "", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
    { name: "個人", kind: "individual", fiscalStartMonth: 13, firstFiscalYear: 2026 },
    { name: "個人", kind: "other", fiscalStartMonth: 1, firstFiscalYear: 2026 },
    { name: "個人", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 1999 },
  ])("スキーマに合わない入力は 400 VALIDATION: %j", async (json) => {
    const res = await client.api.entities.$post({ json: json as never });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("個人事業で期首月が1月以外なら 400 VALIDATION（ドメインの検証）", async () => {
    const res = await client.api.entities.$post({
      json: { name: "個人", kind: "individual", fiscalStartMonth: 4, firstFiscalYear: 2026 },
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      code: "VALIDATION",
      details: { field: "fiscalStartMonth" },
    });
  });
});

describe("GET /api/entities", () => {
  it("事業体がなければ空の一覧", async () => {
    const res = await client.api.entities.$get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entities: [] });
  });

  it("作成した事業体を作成の順に返す", async () => {
    const a = await createTestEntity("事業A");
    const b = await createTestEntity("事業B");
    const res = await client.api.entities.$get();
    const { entities } = await res.json();
    expect(entities.map((e) => [e.id, e.name, e.kind])).toEqual([
      [a, "事業A", "individual"],
      [b, "事業B", "individual"],
    ]);
    expect(entities.map((e) => e.demo)).toEqual([false, false]);
  });
});

describe("PATCH /api/entities/:entityId", () => {
  it("名称を変更でき、registry とテナントのプロファイルの両方に反映される", async () => {
    const id = await createTestEntity("旧名称");
    const res = await client.api.entities[":entityId"].$patch({
      param: { entityId: id },
      json: { name: "新名称" },
    });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect((await res.json()).entity).toMatchObject({ id, name: "新名称", kind: "individual" });

    const list = await (await client.api.entities.$get()).json();
    expect(list.entities.map((e) => e.name)).toEqual(["新名称"]);
    expect(new DrizzleMasterRepository(openTenant(id)).getProfile()?.name).toBe("新名称");
  });

  it("空の名称は 400 VALIDATION で、変更されない", async () => {
    const id = await createTestEntity("旧名称");
    const res = await client.api.entities[":entityId"].$patch({
      param: { entityId: id },
      json: { name: "  " },
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
    const list = await (await client.api.entities.$get()).json();
    expect(list.entities.map((e) => e.name)).toEqual(["旧名称"]);
  });

  it("存在しない事業体は 404 ENTITY_NOT_FOUND", async () => {
    const res = await client.api.entities[":entityId"].$patch({
      param: { entityId: randomUUIDv7() },
      json: { name: "新名称" },
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("ENTITY_NOT_FOUND");
  });
});
