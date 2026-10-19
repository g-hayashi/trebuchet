import { describe, expect, it } from "vitest";
import { INDIVIDUAL_ACCOUNTS } from "../src/seed/accounts.individual.ts";
import { type CreateEntityInput, createEntity } from "../src/usecases/create-entity.ts";
import { FixedClock, InMemoryMasterRepository, InMemoryRegistry, SequentialIds } from "./fakes.ts";

function setup() {
  const registry = new InMemoryRegistry();
  const tenants = new Map<string, InMemoryMasterRepository>();
  const deps = {
    registry,
    openTenant: (entityId: string) => {
      const repo = tenants.get(entityId) ?? new InMemoryMasterRepository();
      tenants.set(entityId, repo);
      return repo;
    },
    ids: new SequentialIds(),
    clock: new FixedClock("2026-10-18T01:02:03.000Z"),
  };
  return { deps, registry, tenants };
}

const individual: CreateEntityInput = {
  name: "個人事業",
  kind: "individual",
  fiscalStartMonth: 1,
  firstFiscalYear: 2026,
};

describe("createEntity（US1）", () => {
  it("事業体を registry に登録し、テナントにプロファイル・初期の科目・会計期間・消費税の設定を作る", () => {
    const { deps, registry, tenants } = setup();
    const result = createEntity(deps, individual);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entity = result.value;
    expect(entity).toMatchObject({
      name: "個人事業",
      kind: "individual",
      fiscalStartMonth: 1,
      createdAt: "2026-10-18T01:02:03.000Z",
    });

    expect(registry.listEntities()).toEqual([
      { id: entity.id, name: "個人事業", kind: "individual", createdAt: entity.createdAt },
    ]);

    const tenant = tenants.get(entity.id);
    expect(tenant).toBeDefined();
    if (tenant === undefined) return;
    expect(tenant.getProfile()).toEqual(entity);

    const accounts = tenant.listAccounts();
    expect(accounts.map((a) => a.code)).toEqual(
      [...INDIVIDUAL_ACCOUNTS].sort((a, b) => a.sortOrder - b.sortOrder).map((a) => a.code),
    );
    for (const a of accounts) {
      expect(a.isSystem).toBe(true);
      expect(a.isActive).toBe(true);
    }
    expect(new Set(accounts.map((a) => a.id)).size).toBe(accounts.length);

    expect(tenant.listFiscalPeriods()).toEqual([
      {
        id: expect.any(String),
        fiscalYear: 2026,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        status: "open",
        closedAt: null,
      },
    ]);
    expect(tenant.listTaxSettings()).toEqual([
      {
        id: expect.any(String),
        effectiveFrom: "2026-01-01",
        taxpayerStatus: "exempt",
        accountingMethod: "tax_included",
      },
    ]);
  });

  it("kind が corporation でも個人用の初期セットで作られ、期首月から1年の会計期間になる", () => {
    const { deps, tenants } = setup();
    const result = createEntity(deps, {
      name: "法人",
      kind: "corporation",
      fiscalStartMonth: 4,
      firstFiscalYear: 2026,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tenant = tenants.get(result.value.id);
    expect(tenant?.listAccounts()).toHaveLength(INDIVIDUAL_ACCOUNTS.length);
    expect(tenant?.listFiscalPeriods()).toMatchObject([
      { fiscalYear: 2026, startDate: "2026-04-01", endDate: "2027-03-31", status: "open" },
    ]);
    expect(tenant?.listTaxSettings()).toMatchObject([{ effectiveFrom: "2026-04-01" }]);
  });

  it("うるう年の2月始まりでも、会計期間の終了日は翌年の開始月の前日", () => {
    const { deps, tenants } = setup();
    const result = createEntity(deps, {
      name: "法人",
      kind: "corporation",
      fiscalStartMonth: 3,
      firstFiscalYear: 2027,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(tenants.get(result.value.id)?.listFiscalPeriods()).toMatchObject([
      { startDate: "2027-03-01", endDate: "2028-02-29" },
    ]);
  });

  it("名称は前後の空白を除いて保存する", () => {
    const { deps } = setup();
    const result = createEntity(deps, { ...individual, name: "  個人事業  " });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.name).toBe("個人事業");
  });

  it.each([
    { name: "", label: "空の名称" },
    { name: "あ".repeat(101), label: "101文字の名称" },
    { fiscalStartMonth: 13, label: "期首月 13" },
    { fiscalStartMonth: 0, label: "期首月 0" },
    { firstFiscalYear: 1999, label: "年度 1999" },
    { kind: "individual" as const, fiscalStartMonth: 4, label: "個人で期首月が1以外" },
  ])("$label は VALIDATION で、何も書き込まない", ({ label: _, ...patch }) => {
    const { deps, registry, tenants } = setup();
    const result = createEntity(deps, { ...individual, ...patch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(registry.listEntities()).toEqual([]);
    expect(tenants.size).toBe(0);
  });

  it("テナントへの投入が失敗したら、ロールバックして registry に登録しない", () => {
    const { deps, registry, tenants } = setup();
    const failing = new InMemoryMasterRepository();
    failing.failOnInsertAccountAt = 5;
    const result = () =>
      createEntity(
        {
          ...deps,
          openTenant: (id) => {
            tenants.set(id, failing);
            return failing;
          },
        },
        individual,
      );
    expect(result).toThrow("insertAccount failed");
    expect(registry.listEntities()).toEqual([]);
    expect(failing.getProfile()).toBeUndefined();
    expect(failing.listAccounts()).toEqual([]);
  });

  it("registry への登録が失敗したら例外になり、事業体は一覧に現れない", () => {
    const { deps, registry } = setup();
    registry.failOnInsert = true;
    expect(() => createEntity(deps, individual)).toThrow("registry insert failed");
    expect(registry.listEntities()).toEqual([]);
  });
});
