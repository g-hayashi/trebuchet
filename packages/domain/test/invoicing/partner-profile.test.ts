import type { BillingTermsInput } from "@trebuchet/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { savePartnerProfile } from "../../src/usecases/invoicing.ts";
import {
  type FakeInvoicingUnitOfWork,
  FixedClock,
  fakeInvoicingUnitOfWork,
  SequentialIds,
} from "../fakes.ts";

// 011 US5 T025: 取引先と請求の条件の一括の保存（R15。FR-034・FR-049）

let uow: FakeInvoicingUnitOfWork;
let deps: { uow: FakeInvoicingUnitOfWork; ids: SequentialIds; clock: FixedClock };

const EXISTING = "partner-1";

beforeEach(() => {
  uow = fakeInvoicingUnitOfWork();
  deps = { uow, ids: new SequentialIds(), clock: new FixedClock("2026-11-04T01:00:00.000Z") };
  uow.masters.state.partners.push({
    id: EXISTING,
    name: "株式会社A",
    honorific: "御中",
    memo: null,
    isActive: true,
  });
});

const hourly = (over: Partial<BillingTermsInput> = {}): BillingTermsInput => ({
  billingType: "hourly",
  unitPrice: 10_000,
  dueMonthsAfter: 1,
  dueDay: 31,
  defaultItemName: "システム開発",
  ...over,
});

const partner = (over: Record<string, unknown> = {}) => ({
  name: "B 商事",
  honorific: "様" as const,
  ...over,
});

describe("savePartnerProfile（R15）", () => {
  it("新規: 取引先と請求の条件を 1 回で作り、条件の create を記録する", () => {
    const r = savePartnerProfile(deps, { partner: partner(), billingTerms: hourly() });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.partner).toMatchObject({ name: "B 商事", honorific: "様", isActive: true });
    expect(r.value.billingTerms).toMatchObject({
      partnerId: r.value.partner.id,
      billingType: "hourly",
      unitPrice: 10_000,
    });
    expect(uow.masters.state.partners.map((p) => p.name)).toContain("B 商事");
    expect(uow.invoicing.getBillingTerms(r.value.partner.id)).not.toBeNull();
    expect(uow.invoicing.audits).toMatchObject([{ targetType: "billing_terms", action: "create" }]);
  });

  it("billingTerms が null なら取引先だけ保存し、条件は作らない", () => {
    const r = savePartnerProfile(deps, { partner: partner(), billingTerms: null });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.billingTerms).toBeNull();
    expect(uow.invoicing.getBillingTerms(r.value.partner.id)).toBeNull();
  });

  it("更新: 名前・使用停止・条件を変えられる", () => {
    uow.invoicing.upsertBillingTerms({
      partnerId: EXISTING,
      billingType: "hourly",
      unitPrice: 1_000,
      monthlyAmount: null,
      dueMonthsAfter: 1,
      dueDay: 31,
      defaultItemName: "旧",
      billingName: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const r = savePartnerProfile(
      deps,
      {
        partner: partner({ name: "株式会社A2", honorific: null, memo: "メモ", isActive: false }),
        billingTerms: hourly({ unitPrice: 12_000 }),
      },
      EXISTING,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.partner).toEqual({
      id: EXISTING,
      name: "株式会社A2",
      honorific: null,
      memo: "メモ",
      isActive: false,
    });
    expect(r.value.billingTerms).toMatchObject({ unitPrice: 12_000 });
    expect(uow.invoicing.audits.at(-1)).toMatchObject({
      targetType: "billing_terms",
      action: "update",
    });
  });

  it("更新で billingTerms が null なら既存の条件を外す（void の記録）", () => {
    uow.invoicing.upsertBillingTerms({
      partnerId: EXISTING,
      billingType: "hourly",
      unitPrice: 1_000,
      monthlyAmount: null,
      dueMonthsAfter: 1,
      dueDay: 31,
      defaultItemName: "旧",
      billingName: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const r = savePartnerProfile(
      deps,
      { partner: partner({ name: "株式会社A" }), billingTerms: null },
      EXISTING,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.billingTerms).toBeNull();
    expect(uow.invoicing.getBillingTerms(EXISTING)).toBeNull();
    expect(uow.invoicing.audits.at(-1)).toMatchObject({
      targetType: "billing_terms",
      action: "void",
    });
  });

  it("条件の検証に失敗したら取引先も保存されない（巻き戻る）", () => {
    const before = structuredClone(uow.masters.state.partners);
    const r = savePartnerProfile(deps, {
      partner: partner({ name: "新しい取引先" }),
      // 時間単価型に月額を混ぜる（型に合わない）
      billingTerms: hourly({ monthlyAmount: 300_000 }),
    });
    expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(uow.masters.state.partners).toEqual(before);
    expect(uow.invoicing.audits).toHaveLength(0);
  });

  it("条件の書き込み後に失敗しても取引先の変更は残らない（名前の重複は取引先側で拒む）", () => {
    uow.masters.state.partners.push({
      id: "partner-2",
      name: "C 社",
      honorific: null,
      memo: null,
      isActive: true,
    });
    const r = savePartnerProfile(
      deps,
      { partner: partner({ name: "C 社" }), billingTerms: hourly() },
      EXISTING,
    );
    expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(uow.masters.state.partners.find((p) => p.id === EXISTING)?.name).toBe("株式会社A");
    expect(uow.invoicing.getBillingTerms(EXISTING)).toBeNull();
  });

  it("存在しない partnerId は VALIDATION（取引先が見つかりません）で何も書かない", () => {
    const r = savePartnerProfile(
      deps,
      { partner: partner(), billingTerms: hourly() },
      "no-such-partner",
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", details: { partnerId: "no-such-partner" } },
    });
    expect(uow.invoicing.audits).toHaveLength(0);
  });
});
