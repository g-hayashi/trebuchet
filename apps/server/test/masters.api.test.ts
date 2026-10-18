import { randomUUIDv7 } from "node:crypto";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { TAX_CATEGORIES } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, createTestEntity, errorOf } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;
beforeEach(async () => {
  tmp = useTempDataDir("server-masters");
  entityId = await createTestEntity();
});
afterEach(() => tmp.cleanup());

const e = client.api.entities[":entityId"];
const param = () => ({ entityId });

async function listAccounts() {
  const res = await e.accounts.$get({ param: param() });
  if (res.status !== 200) throw new Error(String(res.status));
  return (await res.json()).accounts;
}

async function accountByName(name: string) {
  const found = (await listAccounts()).find((a) => a.name === name);
  if (found === undefined) throw new Error(`account not found: ${name}`);
  return found;
}

describe("勘定科目", () => {
  it("GET accounts は sort_order の順（同じ値はコードの順）", async () => {
    const accounts = await listAccounts();
    const sorted = [...accounts].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code),
    );
    expect(accounts).toEqual(sorted);
    expect(accounts[0]).toMatchObject({ code: "1010", name: "現金", isSystem: true });
  });

  it("POST accounts は 201 で、コードが自動採番され、一覧の決算書の順の位置に入る", async () => {
    const res = await e.accounts.$post({
      param: param(),
      json: { name: "車両費", category: "expense", reportSection: "PL_EXPENSE", reportLine: 25 },
    });
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    const { account } = await res.json();
    expect(account).toMatchObject({
      name: "車両費",
      category: "expense",
      normalSide: "debit",
      reportLine: 25,
      isSystem: false,
      isActive: true,
    });
    expect(account.code).toMatch(/^5\d{3}$/);
    const accounts = await listAccounts();
    const index = accounts.findIndex((a) => a.id === account.id);
    expect(accounts[index - 1]?.reportLine).toBeLessThanOrEqual(25);
  });

  it("POST accounts で同じ名前は 400 VALIDATION", async () => {
    const res = await e.accounts.$post({
      param: param(),
      json: { name: "現金", category: "asset", reportSection: "BS_ASSET" },
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("PATCH accounts で名称の変更と使用停止ができる", async () => {
    const target = await accountByName("雑費");
    const renamed = await e.accounts[":accountId"].$patch({
      param: { ...param(), accountId: target.id },
      json: { name: "その他経費" },
    });
    expect(renamed.status).toBe(200);
    if (renamed.status !== 200) return;
    expect((await renamed.json()).account).toEqual({ ...target, name: "その他経費" });

    const deactivated = await e.accounts[":accountId"].$patch({
      param: { ...param(), accountId: target.id },
      json: { isActive: false },
    });
    expect(deactivated.status).toBe(200);
    if (deactivated.status !== 200) return;
    expect((await deactivated.json()).account).toMatchObject({
      name: "その他経費",
      isActive: false,
    });
  });

  it("PATCH accounts で一部が失敗したら、ほかの変更も反映されない", async () => {
    const target = await accountByName("雑費");
    const res = await e.accounts[":accountId"].$patch({
      param: { ...param(), accountId: target.id },
      json: { name: "現金", isActive: false },
    });
    expect(res.status).toBe(400);
    expect(await accountByName("雑費")).toEqual(target);
  });

  it("PATCH accounts で変更する項目がなければ 400、存在しない科目は 422 ACCOUNT_NOT_FOUND", async () => {
    const target = await accountByName("雑費");
    const empty = await e.accounts[":accountId"].$patch({
      param: { ...param(), accountId: target.id },
      json: {},
    });
    expect(empty.status).toBe(400);
    const missing = await e.accounts[":accountId"].$patch({
      param: { ...param(), accountId: randomUUIDv7() },
      json: { name: "新しい名前" },
    });
    expect(missing.status).toBe(422);
    expect((await errorOf(missing)).code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("未使用の科目は DELETE で 204 になり、一覧から消える", async () => {
    const target = await accountByName("研修費");
    const res = await e.accounts[":accountId"].$delete({
      param: { ...param(), accountId: target.id },
    });
    expect(res.status).toBe(204);
    expect((await listAccounts()).some((a) => a.id === target.id)).toBe(false);
  });

  it("使用中（期首残高で参照）の科目の DELETE は 409 ACCOUNT_IN_USE", async () => {
    const cash = await accountByName("現金");
    const capital = await accountByName("元入金");
    const put = await e["fiscal-periods"][":year"]["opening-balances"].$put({
      param: { ...param(), year: "2026" },
      json: [
        { accountId: cash.id, side: "debit", amount: 1000 },
        { accountId: capital.id, side: "credit", amount: 1000 },
      ],
    });
    expect(put.status).toBe(200);
    const res = await e.accounts[":accountId"].$delete({
      param: { ...param(), accountId: cash.id },
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({
      code: "ACCOUNT_IN_USE",
      details: { accountId: cash.id },
    });
  });
});

describe("補助科目", () => {
  it("科目ごとに追加・一覧でき、同じ科目で同じ名前は 400", async () => {
    const bank = await accountByName("普通預金");
    const path = { param: { ...param(), accountId: bank.id } };
    const created = await e.accounts[":accountId"]["sub-accounts"].$post({
      ...path,
      json: { name: "A銀行" },
    });
    expect(created.status).toBe(201);
    if (created.status !== 201) return;
    const { subAccount } = await created.json();
    expect(subAccount).toMatchObject({ accountId: bank.id, name: "A銀行", isActive: true });

    const list = await e.accounts[":accountId"]["sub-accounts"].$get(path);
    if (list.status !== 200) throw new Error(String(list.status));
    expect((await list.json()).subAccounts).toEqual([subAccount]);

    const dup = await e.accounts[":accountId"]["sub-accounts"].$post({
      ...path,
      json: { name: "A銀行" },
    });
    expect(dup.status).toBe(400);
  });

  it("存在しない科目の補助科目は 422 ACCOUNT_NOT_FOUND", async () => {
    const res = await e.accounts[":accountId"]["sub-accounts"].$get({
      param: { ...param(), accountId: randomUUIDv7() },
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("取引先", () => {
  it("追加（201）・一覧・更新ができる", async () => {
    const created = await e.partners.$post({
      param: param(),
      json: { name: "株式会社A", honorific: "御中", memo: "主要取引先" },
    });
    expect(created.status).toBe(201);
    if (created.status !== 201) return;
    const { partner } = await created.json();
    expect(partner).toMatchObject({
      name: "株式会社A",
      honorific: "御中",
      memo: "主要取引先",
      isActive: true,
    });

    const updated = await e.partners[":partnerId"].$patch({
      param: { ...param(), partnerId: partner.id },
      json: { name: "株式会社A2", honorific: null },
    });
    expect(updated.status).toBe(200);
    if (updated.status !== 200) return;
    expect((await updated.json()).partner).toEqual({
      id: partner.id,
      name: "株式会社A2",
      honorific: null,
      memo: null,
      isActive: true,
    });

    const list = await e.partners.$get({ param: param() });
    if (list.status !== 200) throw new Error(String(list.status));
    expect((await list.json()).partners.map((p) => p.name)).toEqual(["株式会社A2"]);
  });

  it("敬称が不正なら 400 VALIDATION", async () => {
    const res = await e.partners.$post({
      param: param(),
      json: { name: "A", honorific: "殿" as never },
    });
    expect(res.status).toBe(400);
  });
});

describe("メモタグ", () => {
  it("追加（201）・一覧ができ、同じ名前は 400", async () => {
    const created = await e.tags.$post({ param: param(), json: { name: "出張" } });
    expect(created.status).toBe(201);
    const dup = await e.tags.$post({ param: param(), json: { name: "出張" } });
    expect(dup.status).toBe(400);
    const list = await e.tags.$get({ param: param() });
    if (list.status !== 200) throw new Error(String(list.status));
    expect((await list.json()).tags).toEqual([{ id: expect.any(String), name: "出張" }]);
  });
});

describe("税区分", () => {
  it("GET tax-categories は7つの税区分と税率を返す", async () => {
    const res = await e["tax-categories"].$get({ param: param() });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const body = await res.json();
    expect(body.taxCategories).toEqual(TAX_CATEGORIES);
    expect(body.taxRates).toHaveLength(4);
    for (const r of body.taxRates) expect(r.sourceUrl).not.toBe("");
  });
});

describe("消費税の設定", () => {
  it("PUT tax-settings で一括置換でき、GET は適用開始日の順", async () => {
    const res = await e["tax-settings"].$put({
      param: param(),
      json: [
        {
          effectiveFrom: "2027-01-01",
          taxpayerStatus: "general",
          accountingMethod: "tax_included",
        },
        { effectiveFrom: "2026-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
      ],
    });
    expect(res.status).toBe(200);
    const list = await e["tax-settings"].$get({ param: param() });
    if (list.status !== 200) throw new Error(String(list.status));
    expect((await list.json()).taxSettings.map((s) => s.effectiveFrom)).toEqual([
      "2026-01-01",
      "2027-01-01",
    ]);
  });

  it("適用開始日が重複していると 422 TAX_SETTING_GAP で、元の設定が残る", async () => {
    const res = await e["tax-settings"].$put({
      param: param(),
      json: [
        { effectiveFrom: "2026-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
        {
          effectiveFrom: "2026-01-01",
          taxpayerStatus: "general",
          accountingMethod: "tax_included",
        },
      ],
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("TAX_SETTING_GAP");
    const list = await e["tax-settings"].$get({ param: param() });
    if (list.status !== 200) throw new Error(String(list.status));
    expect((await list.json()).taxSettings).toMatchObject([
      { effectiveFrom: "2026-01-01", taxpayerStatus: "exempt" },
    ]);
  });

  it("空の配列は 400 VALIDATION", async () => {
    const res = await e["tax-settings"].$put({ param: param(), json: [] });
    expect(res.status).toBe(400);
  });
});

describe("会計期間", () => {
  it("POST fiscal-periods は 201 で翌年度を作り、GET は年度の順", async () => {
    const res = await e["fiscal-periods"].$post({ param: param() });
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    expect((await res.json()).fiscalPeriod).toMatchObject({
      fiscalYear: 2027,
      startDate: "2027-01-01",
      endDate: "2027-12-31",
      status: "open",
      closedAt: null,
    });
    const list = await e["fiscal-periods"].$get({ param: param() });
    if (list.status !== 200) throw new Error(String(list.status));
    expect((await list.json()).fiscalPeriods.map((p) => p.fiscalYear)).toEqual([2026, 2027]);
  });
});

describe("期首残高", () => {
  const ob = () => e["fiscal-periods"][":year"]["opening-balances"];

  it("最初は空で、貸借が一致すれば PUT で保存でき、GET で取得できる", async () => {
    const empty = await ob().$get({ param: { ...param(), year: "2026" } });
    expect(empty.status).toBe(200);
    if (empty.status !== 200) return;
    const emptyBody = await empty.json();
    expect(emptyBody.openingBalances).toEqual([]);
    expect(emptyBody.fiscalPeriod).toMatchObject({ fiscalYear: 2026 });

    const cash = await accountByName("現金");
    const bank = await accountByName("普通預金");
    const capital = await accountByName("元入金");
    const sub = await e.accounts[":accountId"]["sub-accounts"].$post({
      param: { ...param(), accountId: bank.id },
      json: { name: "A銀行" },
    });
    if (sub.status !== 201) throw new Error(String(sub.status));
    const { subAccount } = await sub.json();

    const rows = [
      { accountId: cash.id, side: "debit" as const, amount: 50_000 },
      { accountId: bank.id, subAccountId: subAccount.id, side: "debit" as const, amount: 250_000 },
      { accountId: capital.id, side: "credit" as const, amount: 300_000 },
    ];
    const put = await ob().$put({ param: { ...param(), year: "2026" }, json: rows });
    expect(put.status).toBe(200);
    if (put.status !== 200) return;
    const expected = [
      { accountId: cash.id, subAccountId: null, side: "debit", amount: 50_000 },
      { accountId: bank.id, subAccountId: subAccount.id, side: "debit", amount: 250_000 },
      { accountId: capital.id, subAccountId: null, side: "credit", amount: 300_000 },
    ].map((r) => ({ ...r, id: expect.any(String), fiscalPeriodId: emptyBody.fiscalPeriod.id }));
    expect((await put.json()).openingBalances).toEqual(expected);

    const got = await ob().$get({ param: { ...param(), year: "2026" } });
    if (got.status !== 200) throw new Error(String(got.status));
    expect((await got.json()).openingBalances).toEqual(expected);
  });

  it("貸借が一致しなければ 422 UNBALANCED（差額つき）で、保存されない", async () => {
    const cash = await accountByName("現金");
    const capital = await accountByName("元入金");
    const res = await ob().$put({
      param: { ...param(), year: "2026" },
      json: [
        { accountId: cash.id, side: "debit", amount: 500_000 },
        { accountId: capital.id, side: "credit", amount: 495_000 },
      ],
    });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "UNBALANCED",
      details: { debit: 500_000, credit: 495_000, diff: 5_000 },
    });
    const got = await ob().$get({ param: { ...param(), year: "2026" } });
    if (got.status !== 200) throw new Error(String(got.status));
    expect((await got.json()).openingBalances).toEqual([]);
  });

  it("金額が整数でなければ 400 VALIDATION", async () => {
    const cash = await accountByName("現金");
    const res = await ob().$put({
      param: { ...param(), year: "2026" },
      json: [{ accountId: cash.id, side: "debit", amount: 100.5 }],
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it.each(["2025", "abc", "2026.5"])(
    "存在しない・不正な年度 %s は 400 VALIDATION",
    async (year) => {
      const res = await ob().$get({ param: { ...param(), year } });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    },
  );
});

describe("テナントの分離", () => {
  it("別の事業体の科目は見えず、その科目 ID の操作は 422 ACCOUNT_NOT_FOUND", async () => {
    const other = await createTestEntity("別の事業");
    const otherCash = (
      await (await e.accounts.$get({ param: { entityId: other } })).json()
    ).accounts.find((a) => a.name === "現金");
    if (otherCash === undefined) throw new Error("no cash");
    expect((await listAccounts()).some((a) => a.id === otherCash.id)).toBe(false);
    const res = await e.accounts[":accountId"].$delete({
      param: { ...param(), accountId: otherCash.id },
    });
    expect(res.status).toBe(422);
  });
});
