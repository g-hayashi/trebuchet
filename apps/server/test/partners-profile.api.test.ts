import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, createTestEntity, errorOf } from "./helpers.ts";

// 011 US5 T025: contracts/http-api.md §1（POST /partners/profile・PUT /partners/:partnerId/profile）

let tmp: TempDataDir;
let entityId: string;

const e = client.api.entities[":entityId"];
const param = () => ({ entityId });

beforeEach(async () => {
  tmp = useTempDataDir("server-partners-profile");
  entityId = await createTestEntity();
});
afterEach(() => tmp.cleanup());

type ProfileJson = Parameters<(typeof e.partners.profile)["$post"]>[0]["json"];
const hourly = (over: Record<string, unknown> = {}) => ({
  billingType: "hourly" as const,
  unitPrice: 10_000,
  dueMonthsAfter: 1,
  dueDay: 31 as const,
  defaultItemName: "システム開発",
  ...over,
});
const body = (
  partner: Record<string, unknown> = {},
  billingTerms: Record<string, unknown> | null = hourly(),
) =>
  ({
    partner: { name: "株式会社A", honorific: "御中", ...partner },
    billingTerms,
  }) as ProfileJson;

const post = (json: ProfileJson) => e.partners.profile.$post({ param: param(), json });
const put = (partnerId: string, json: ProfileJson) =>
  e.partners[":partnerId"].profile.$put({ param: { ...param(), partnerId }, json });

const listPartners = async () => {
  const res = await e.partners.$get({ param: param() });
  if (res.status !== 200) throw new Error(String(res.status));
  return (await res.json()).partners;
};
const listTerms = async () => {
  const res = await e["billing-terms"].$get({ param: param() });
  if (res.status !== 200) throw new Error(String(res.status));
  return (await res.json()).terms;
};

describe("POST /partners/profile", () => {
  it("取引先と請求の条件を 201 で作る", async () => {
    const res = await post(body({ memo: "主要" }));
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    const json = await res.json();
    expect(json.partner).toMatchObject({ name: "株式会社A", memo: "主要", isActive: true });
    expect(json.billingTerms).toMatchObject({
      partnerId: json.partner.id,
      billingType: "hourly",
      unitPrice: 10_000,
    });
    expect((await listTerms()).map((t) => t.partnerId)).toEqual([json.partner.id]);
  });

  it("billingTerms が null なら取引先だけ作る", async () => {
    const res = await post(body({}, null));
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    expect((await res.json()).billingTerms).toBeNull();
    expect(await listTerms()).toEqual([]);
  });

  it("isActive: false で作れる", async () => {
    const res = await post(body({ isActive: false }, null));
    if (res.status !== 201) throw new Error(String(res.status));
    expect((await res.json()).partner.isActive).toBe(false);
  });

  it("時間単価型に月額を混ぜると 400 で取引先も作られない", async () => {
    const res = await post(body({}, hourly({ monthlyAmount: 1000 })));
    expect(res.status).toBe(400);
    expect(await listPartners()).toEqual([]);
  });

  it("同じ名前の取引先がすでにあれば 400 VALIDATION（今の規則）", async () => {
    await post(body({}, null));
    const res = await post(body());
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
    expect(await listPartners()).toHaveLength(1);
  });
});

describe("PUT /partners/:partnerId/profile", () => {
  const create = async () => {
    const res = await post(body());
    if (res.status !== 201) throw new Error(String(res.status));
    return (await res.json()).partner.id;
  };

  it("取引先と条件を 200 で更新し、使用停止にできる", async () => {
    const id = await create();
    const res = await put(
      id,
      body({ name: "株式会社A2", isActive: false }, hourly({ unitPrice: 12_000 })),
    );
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const json = await res.json();
    expect(json.partner).toMatchObject({ id, name: "株式会社A2", isActive: false });
    expect(json.billingTerms).toMatchObject({ unitPrice: 12_000 });
    expect((await listPartners())[0]).toMatchObject({ name: "株式会社A2", isActive: false });
  });

  it("billingTerms が null なら条件を消す", async () => {
    const id = await create();
    const res = await put(id, body({}, null));
    expect(res.status).toBe(200);
    expect(await listTerms()).toEqual([]);
  });

  it("条件の検証に失敗すると取引先の変更も巻き戻る", async () => {
    const id = await create();
    const res = await put(id, body({ name: "変更後" }, hourly({ unitPrice: undefined })));
    expect(res.status).toBe(400);
    expect((await listPartners())[0]?.name).toBe("株式会社A");
  });

  it("名前が別の取引先と重複すると 400 VALIDATION で何も変わらない", async () => {
    const id = await create();
    await post(body({ name: "B 社" }, null));
    const res = await put(id, body({ name: "B 社" }, hourly({ unitPrice: 99_000 })));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
    expect((await listTerms())[0]).toMatchObject({ unitPrice: 10_000 });
  });

  it("存在しない取引先は 400 VALIDATION（取引先が見つかりません）", async () => {
    const res = await put("0191f5a0-0000-7000-8000-000000000000", body());
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});
