import type { BillingTermsInput, InvoiceSettingsInput } from "@trebuchet/schema";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteBillingTerms,
  getInvoiceSettings,
  isIssuerComplete,
  listBillingTerms,
  saveBillingTerms,
  saveInvoiceSettings,
} from "../../src/usecases/invoicing.ts";
import { FakeInvoicingUnitOfWork, FixedClock, SequentialIds } from "../fakes.ts";

// 005 US4: 発行者の設定と請求の条件（FR-001〜004。R4・R5・R6・R23）

let uow: FakeInvoicingUnitOfWork;
let deps: { uow: FakeInvoicingUnitOfWork; ids: SequentialIds; clock: FixedClock };

const PARTNER = "partner-1";

beforeEach(() => {
  uow = new FakeInvoicingUnitOfWork();
  deps = { uow, ids: new SequentialIds(), clock: new FixedClock("2026-10-24T09:00:00.000Z") };
  uow.masters.state.partners.push(
    { id: PARTNER, name: "株式会社A", honorific: "御中", memo: null, isActive: true },
    { id: "partner-2", name: "B 商事", honorific: "様", memo: null, isActive: false },
  );
});

const settingsInput = (over: Partial<InvoiceSettingsInput> = {}): InvoiceSettingsInput => ({
  issuerName: "山田 太郎",
  address: "東京都千代田区",
  contact: "taro@example.com",
  bankAccount: "○○銀行 普通 1234567",
  taxDisplay: "inclusive_only",
  nextSeq: 1,
  ...over,
});

const hourly = (over: Partial<BillingTermsInput> = {}): BillingTermsInput => ({
  billingType: "hourly",
  unitPrice: 10_000,
  dueMonthsAfter: 1,
  dueDay: 31,
  defaultItemName: "システム開発",
  ...over,
});

const monthly = (over: Partial<BillingTermsInput> = {}): BillingTermsInput => ({
  billingType: "monthly",
  monthlyAmount: 300_000,
  dueMonthsAfter: 2,
  dueDay: 25,
  defaultItemName: "顧問料",
  billingName: "A 社 経理部",
  ...over,
});

describe("getInvoiceSettings", () => {
  it("設定がなければ settings: null、minimumNextSeq は 1", () => {
    const r = getInvoiceSettings(deps);
    expect(r).toEqual({ ok: true, value: { settings: null, minimumNextSeq: 1 } });
  });

  it("minimumNextSeq は発行済みの最大の seq + 1", () => {
    uow.invoicing.registerIssuedSeq(7);
    uow.invoicing.registerIssuedSeq(3);
    const r = getInvoiceSettings(deps);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.minimumNextSeq).toBe(8);
  });
});

describe("saveInvoiceSettings（FR-003, FR-004）", () => {
  it("保存して読み戻せる（任意の項目は null になる）", () => {
    const saved = saveInvoiceSettings(deps, settingsInput({ nextSeq: 43 }));
    if (!saved.ok) throw new Error("expected ok");
    expect(saved.value).toMatchObject({
      issuerName: "山田 太郎",
      tradeName: null,
      registrationNumber: null,
      nextSeq: 43,
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
    const read = getInvoiceSettings(deps);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value.settings).toEqual(saved.value);
  });

  it("上書きできる（屋号・登録番号）", () => {
    saveInvoiceSettings(deps, settingsInput());
    const r = saveInvoiceSettings(
      deps,
      settingsInput({ tradeName: "山田設計", registrationNumber: "T1234567890123" }),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.value).toMatchObject({ tradeName: "山田設計", registrationNumber: "T1234567890123" });
  });

  it("nextSeq が発行済みの最大の seq 以下なら INVOICE_SEQ_TOO_LOW（details.minimum）。保存も記録もされない", () => {
    uow.invoicing.registerIssuedSeq(5);
    const r = saveInvoiceSettings(deps, settingsInput({ nextSeq: 5 }));
    expect(r).toMatchObject({
      ok: false,
      error: { code: "INVOICE_SEQ_TOO_LOW", details: { minimum: 6 } },
    });
    expect(uow.invoicing.audits).toHaveLength(0);
    const read = getInvoiceSettings(deps);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value.settings).toBeNull();
  });

  it("nextSeq が最大の seq + 1 ちょうどなら保存できる", () => {
    uow.invoicing.registerIssuedSeq(5);
    expect(saveInvoiceSettings(deps, settingsInput({ nextSeq: 6 })).ok).toBe(true);
  });

  it("invoice_settings の create・update を記録する（同じトランザクション）", () => {
    const first = saveInvoiceSettings(deps, settingsInput());
    const second = saveInvoiceSettings(deps, settingsInput({ issuerName: "山田 次郎" }));
    if (!first.ok || !second.ok) throw new Error("expected ok");
    const [a, b] = uow.invoicing.audits;
    expect(a).toMatchObject({
      targetType: "invoice_settings",
      action: "create",
      beforeJson: null,
      occurredAt: "2026-10-24T09:00:00.000Z",
    });
    expect(JSON.parse(a?.afterJson ?? "")).toMatchObject({ issuerName: "山田 太郎" });
    expect(b).toMatchObject({ targetType: "invoice_settings", action: "update" });
    expect(JSON.parse(b?.beforeJson ?? "")).toMatchObject({ issuerName: "山田 太郎" });
    expect(JSON.parse(b?.afterJson ?? "")).toMatchObject({ issuerName: "山田 次郎" });
  });
});

describe("isIssuerComplete（R5）", () => {
  const settings = (over: Record<string, string> = {}) => {
    const saved = saveInvoiceSettings(deps, settingsInput());
    if (!saved.ok) throw new Error("expected ok");
    return { ...saved.value, ...over };
  };

  it("設定がなければ 4 項目すべてが欠けている", () => {
    expect(isIssuerComplete(null)).toEqual({
      complete: false,
      missing: ["issuerName", "address", "contact", "bankAccount"],
    });
  });

  it("4 項目が埋まっていれば complete", () => {
    expect(isIssuerComplete(settings())).toEqual({ complete: true, missing: [] });
  });

  it("空（空白だけを含む）の項目を欠けとして返す", () => {
    expect(isIssuerComplete(settings({ address: "", bankAccount: "  \n" }))).toEqual({
      complete: false,
      missing: ["address", "bankAccount"],
    });
  });
});

describe("saveBillingTerms（FR-001, FR-002）", () => {
  it("時間単価型を保存して一覧に出る（partnerName・honorific・partnerActive 付き）", () => {
    const saved = saveBillingTerms(deps, PARTNER, hourly());
    if (!saved.ok) throw new Error("expected ok");
    expect(saved.value).toMatchObject({
      partnerId: PARTNER,
      billingType: "hourly",
      unitPrice: 10_000,
      monthlyAmount: null,
      dueMonthsAfter: 1,
      dueDay: 31,
      defaultItemName: "システム開発",
      billingName: null,
    });
    const list = listBillingTerms(deps);
    if (!list.ok) throw new Error("expected ok");
    expect(list.value).toEqual([
      {
        ...saved.value,
        partnerName: "株式会社A",
        honorific: "御中",
        partnerActive: true,
      },
    ]);
  });

  it("月額定額型は monthlyAmount と宛名を保存し、unitPrice は null", () => {
    const saved = saveBillingTerms(deps, "partner-2", monthly());
    if (!saved.ok) throw new Error("expected ok");
    expect(saved.value).toMatchObject({
      billingType: "monthly",
      unitPrice: null,
      monthlyAmount: 300_000,
      dueMonthsAfter: 2,
      dueDay: 25,
      billingName: "A 社 経理部",
    });
    const list = listBillingTerms(deps);
    if (!list.ok) throw new Error("expected ok");
    expect(list.value[0]).toMatchObject({ partnerId: "partner-2", partnerActive: false });
  });

  it("型を切り替えて上書きできる（旧型の金額は消える）", () => {
    saveBillingTerms(deps, PARTNER, hourly());
    const r = saveBillingTerms(deps, PARTNER, monthly());
    if (!r.ok) throw new Error("expected ok");
    expect(r.value).toMatchObject({
      billingType: "monthly",
      unitPrice: null,
      monthlyAmount: 300_000,
    });
    const list = listBillingTerms(deps);
    if (!list.ok) throw new Error("expected ok");
    expect(list.value).toHaveLength(1);
  });

  it("取引先がなければ VALIDATION（details.field = partnerId）", () => {
    const r = saveBillingTerms(deps, "nope", hourly());
    expect(r).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", details: { field: "partnerId" } },
    });
    expect(uow.invoicing.audits).toHaveLength(0);
  });

  it("型に合わない金額は VALIDATION（防御。HTTP では Zod が先に止める）", () => {
    const r = saveBillingTerms(deps, PARTNER, hourly({ unitPrice: undefined, monthlyAmount: 5 }));
    expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    const r2 = saveBillingTerms(deps, PARTNER, monthly({ monthlyAmount: undefined, unitPrice: 5 }));
    expect(r2).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("billing_terms の create・update を記録する", () => {
    saveBillingTerms(deps, PARTNER, hourly());
    saveBillingTerms(deps, PARTNER, hourly({ unitPrice: 12_000 }));
    const [a, b] = uow.invoicing.audits;
    expect(a).toMatchObject({ targetType: "billing_terms", targetId: PARTNER, action: "create" });
    expect(b).toMatchObject({ targetType: "billing_terms", targetId: PARTNER, action: "update" });
    expect(JSON.parse(b?.beforeJson ?? "")).toMatchObject({ unitPrice: 10_000 });
    expect(JSON.parse(b?.afterJson ?? "")).toMatchObject({ unitPrice: 12_000 });
  });
});

describe("deleteBillingTerms（FR-001）", () => {
  it("条件を外す。他の取引先の条件は残る", () => {
    saveBillingTerms(deps, PARTNER, hourly());
    saveBillingTerms(deps, "partner-2", monthly());
    const r = deleteBillingTerms(deps, PARTNER);
    expect(r.ok).toBe(true);
    const list = listBillingTerms(deps);
    if (!list.ok) throw new Error("expected ok");
    expect(list.value.map((t) => t.partnerId)).toEqual(["partner-2"]);
  });

  it("外したことを記録する（変更前の内容を残す）", () => {
    saveBillingTerms(deps, PARTNER, hourly());
    deleteBillingTerms(deps, PARTNER);
    const last = uow.invoicing.audits.at(-1);
    expect(last).toMatchObject({
      targetType: "billing_terms",
      targetId: PARTNER,
      action: "void",
      afterJson: null,
    });
    expect(JSON.parse(last?.beforeJson ?? "")).toMatchObject({ unitPrice: 10_000 });
  });

  it("条件がなくても成功する（記録は増えない）", () => {
    expect(deleteBillingTerms(deps, PARTNER).ok).toBe(true);
    expect(uow.invoicing.audits).toHaveLength(0);
  });
});
