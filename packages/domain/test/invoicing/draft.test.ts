import type { BillingTerms, InvoiceDraft, InvoiceSettings } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { buildInvoiceDraft } from "../../src/invoicing/draft.ts";
import { effectiveTaxDisplay } from "../../src/invoicing/tax.ts";
import { loadContext } from "../../src/usecases/create-journal.ts";
import { draftInvoices, getWorkHours, saveWorkHours } from "../../src/usecases/invoicing.ts";
import { invoiceRecord, setupInvoicing } from "../invoicing-setup.ts";

// 005 US1: 工数と請求書の案（R3・R7・R8・R10、FR-005・006・016、H:§3.1〜§3.3）

const TODAY = "2026-10-31";

const hourly = (over: Partial<BillingTerms> = {}): BillingTerms => ({
  partnerId: "p-1",
  billingType: "hourly",
  unitPrice: 10_000,
  monthlyAmount: null,
  dueMonthsAfter: 1,
  dueDay: 31,
  defaultItemName: "業務委託",
  billingName: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});
const monthly = (over: Partial<BillingTerms> = {}): BillingTerms =>
  hourly({ billingType: "monthly", unitPrice: null, monthlyAmount: 300_000, ...over });

const settings = (over: Partial<InvoiceSettings> = {}): InvoiceSettings => ({
  issuerName: "山田 太郎",
  tradeName: null,
  address: "東京都千代田区",
  contact: "taro@example.com",
  bankAccount: "○○銀行",
  registrationNumber: null,
  taxDisplay: "separate",
  nextSeq: 1,
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const PARTNER = { id: "p-1", name: "株式会社A" };

describe("buildInvoiceDraft（免税の事業者）", () => {
  const { masters } = setupInvoicing();
  const ctx = loadContext(masters);
  const build = (over: Partial<Parameters<typeof buildInvoiceDraft>[0]> = {}) =>
    buildInvoiceDraft({
      terms: hourly(),
      partner: PARTNER,
      halfHours: 241,
      month: "2026-10",
      settings: settings(),
      today: TODAY,
      activeInvoices: [],
      ctx,
      ...over,
    });
  const draftOf = (outcome: ReturnType<typeof buildInvoiceDraft>): InvoiceDraft => {
    if (outcome.kind !== "draft") throw new Error(`expected draft: ${outcome.reason}`);
    return outcome.draft;
  };

  it("US1 Acceptance 1: 120.5 時間 × 10,000 円 = 1,205,000 円、支払期限は翌月末", () => {
    const draft = draftOf(build());
    expect(draft).toMatchObject({
      partnerId: "p-1",
      targetMonth: "2026-10",
      issueDate: TODAY,
      salesDate: "2026-10-31",
      dueDate: "2026-11-30",
      total: 1_205_000,
      warnings: [],
    });
    expect(draft.items).toEqual([
      {
        name: "10月分 業務委託",
        quantity: 120.5,
        unit: "時間",
        unitPrice: 10_000,
        amount: 1_205_000,
        taxCategory: "OUT_OF_SCOPE",
      },
    ]);
  });

  it("US1 Acceptance 2: 月額定額型は工数なしで月額の 1 行", () => {
    const draft = draftOf(build({ terms: monthly(), halfHours: null }));
    expect(draft.items).toEqual([
      { name: "10月分 業務委託", amount: 300_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
    expect(draft.total).toBe(300_000);
  });

  it("工数がない時間単価型は NO_HOURS、0 時間は ZERO_HOURS でスキップ", () => {
    expect(build({ halfHours: null })).toEqual({ kind: "skipped", reason: "NO_HOURS" });
    expect(build({ halfHours: 0 })).toEqual({ kind: "skipped", reason: "ZERO_HOURS" });
  });

  it("Edge Case: 0.5 時間 × 10,001 円 = 5,000 円（1 円未満は明細ごとに切り捨て）", () => {
    const draft = draftOf(build({ terms: hourly({ unitPrice: 10_001 }), halfHours: 1 }));
    expect(draft.items[0]).toMatchObject({ quantity: 0.5, amount: 5_000 });
    expect(draft.total).toBe(5_000);
  });

  it("免税の期間は、設定が別記でも税込のみ（R10）。税率なしなので別記の内訳は空", () => {
    const draft = draftOf(build({ settings: settings({ taxDisplay: "separate" }) }));
    expect(draft.taxDisplay).toBe("inclusive_only");
    expect(draft.taxBreakdown).toEqual([]);
  });

  it("支払期限は条件の「N か月後・D 日」で決まる（0 か月後 10 日 → 同月 10 日）", () => {
    const draft = draftOf(build({ terms: hourly({ dueMonthsAfter: 0, dueDay: 10 }) }));
    expect(draft.dueDate).toBe("2026-10-10");
  });

  it("売上の計上日は対象月の末日（2 月は閏年を考える）、品名は 1 桁の月に 0 を付けない", () => {
    const feb = draftOf(build({ month: "2026-02" }));
    expect(feb.salesDate).toBe("2026-02-28");
    expect(feb.items[0]?.name).toBe("2月分 業務委託");
    expect(draftOf(build({ month: "2028-02" })).salesDate).toBe("2028-02-29");
  });

  it("同じ取引先・対象月の取消でない請求書があれば INVOICE_DUPLICATE_MONTH の警告（FR-016）", () => {
    const draft = draftOf(
      build({ activeInvoices: [{ invoiceNo: "20261001-001" }, { invoiceNo: "20261005-002" }] }),
    );
    expect(draft.warnings).toHaveLength(1);
    expect(draft.warnings[0]).toMatchObject({
      code: "INVOICE_DUPLICATE_MONTH",
      details: { invoices: ["20261001-001", "20261005-002"] },
    });
  });
});

describe("buildInvoiceDraft（課税事業者）", () => {
  const { masters } = setupInvoicing({ taxable: true });
  const ctx = loadContext(masters);
  const build = (over: Partial<Parameters<typeof buildInvoiceDraft>[0]> = {}) => {
    const outcome = buildInvoiceDraft({
      terms: hourly(),
      partner: PARTNER,
      halfHours: 241,
      month: "2026-10",
      settings: settings({ taxDisplay: "separate" }),
      today: TODAY,
      activeInvoices: [],
      ctx,
      ...over,
    });
    if (outcome.kind !== "draft") throw new Error("expected draft");
    return outcome.draft;
  };

  it("明細の税区分は計上日の既定（売上 10%）、別記の内訳は税率ごとに 1 回の切り捨て", () => {
    const draft = build();
    expect(draft.items[0]?.taxCategory).toBe("SALES_10");
    expect(draft.taxDisplay).toBe("separate");
    // 1,205,000 × 10 / 110 = 109,545.45... → 109,545
    expect(draft.taxBreakdown).toEqual([
      { rate: 10, inclusive: 1_205_000, tax: 109_545, exclusive: 1_095_455 },
    ]);
  });

  it("設定が税込のみ・設定なしなら、課税でも税込のみ", () => {
    expect(build({ settings: settings({ taxDisplay: "inclusive_only" }) }).taxDisplay).toBe(
      "inclusive_only",
    );
    expect(build({ settings: null }).taxDisplay).toBe("inclusive_only");
  });

  it("effectiveTaxDisplay: 計上日が免税・設定の空白なら税込のみ", () => {
    expect(effectiveTaxDisplay("separate", "2026-10-31", ctx.taxSettings)).toBe("separate");
    expect(effectiveTaxDisplay("separate", "2024-12-31", ctx.taxSettings)).toBe("inclusive_only");
  });
});

describe("getWorkHours・saveWorkHours（FR-005）", () => {
  it("時間単価型の有効な取引先だけが並ぶ。未入力は hours: null", () => {
    const t = setupInvoicing();
    const a = t.addPartner({ name: "A 社" });
    const b = t.addPartner({ name: "B 社" });
    const m = t.addPartner({ name: "月額社" });
    const stopped = t.addPartner({ name: "停止社", isActive: false });
    t.setTerms(a.id);
    t.setTerms(b.id);
    t.setTerms(m.id, { billingType: "monthly", unitPrice: null, monthlyAmount: 100_000 });
    t.setTerms(stopped.id);
    t.addPartner({ name: "条件なし" });

    const saved = saveWorkHours(t.deps, "2026-10", {
      entries: [{ partnerId: a.id, hours: 120.5 }],
    });
    expect(saved).toEqual({
      ok: true,
      value: [
        { partnerId: a.id, hours: 120.5 },
        { partnerId: b.id, hours: null },
      ],
    });
    expect(getWorkHours(t.deps, "2026-10")).toEqual(saved);
    // 別の月は未入力
    const other = getWorkHours(t.deps, "2026-09");
    expect(other.ok && other.value.every((e) => e.hours === null)).toBe(true);
  });

  it("上書きで保存し、作成と更新を work_hours の記録に残す", () => {
    const t = setupInvoicing();
    const a = t.addPartner();
    t.setTerms(a.id);
    saveWorkHours(t.deps, "2026-10", { entries: [{ partnerId: a.id, hours: 10 }] });
    saveWorkHours(t.deps, "2026-10", { entries: [{ partnerId: a.id, hours: 0 }] });
    expect(t.invoicing.getWorkHours(a.id, "2026-10")?.halfHours).toBe(0);
    expect(t.invoicing.audits.map((e) => [e.targetType, e.action])).toEqual([
      ["work_hours", "create"],
      ["work_hours", "update"],
    ]);
  });

  it("時間単価型でない・使用停止・存在しない取引先、0.5 の倍数でない工数は VALIDATION で何も保存しない", () => {
    const t = setupInvoicing();
    const a = t.addPartner();
    const m = t.addPartner();
    const stopped = t.addPartner({ isActive: false });
    t.setTerms(a.id);
    t.setTerms(m.id, { billingType: "monthly", unitPrice: null, monthlyAmount: 1 });
    t.setTerms(stopped.id);
    for (const partnerId of [m.id, stopped.id, "no-such-partner"]) {
      const r = saveWorkHours(t.deps, "2026-10", {
        entries: [
          { partnerId: a.id, hours: 5 },
          { partnerId, hours: 1 },
        ],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("VALIDATION");
        expect(r.error.details).toMatchObject({ field: "partnerId", partnerId });
      }
    }
    const fraction = saveWorkHours(t.deps, "2026-10", {
      entries: [{ partnerId: a.id, hours: 1.25 }],
    });
    expect(fraction.ok).toBe(false);
    expect(t.invoicing.state.workHours).toEqual([]);
  });
});

describe("draftInvoices（H:§3.3）", () => {
  it("条件のある有効な取引先すべての案と、スキップした取引先を返す（保存しない）", () => {
    const t = setupInvoicing();
    t.setSettings();
    const a = t.addPartner({ name: "A 社", honorific: "御中" });
    const b = t.addPartner({ name: "B 社" });
    const zero = t.addPartner({ name: "C 社" });
    const m = t.addPartner({ name: "D 社" });
    const stopped = t.addPartner({ name: "停止社", isActive: false });
    t.addPartner({ name: "条件なし" });
    for (const p of [a, b, zero, stopped]) t.setTerms(p.id);
    t.setTerms(m.id, { billingType: "monthly", unitPrice: null, monthlyAmount: 80_000 });
    saveWorkHours(t.deps, "2026-10", {
      entries: [
        { partnerId: a.id, hours: 100 },
        { partnerId: zero.id, hours: 0 },
      ],
    });

    const r = draftInvoices(t.deps, { month: "2026-10" }, TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.drafts.map((d) => [d.partnerId, d.total])).toEqual([
      [a.id, 1_000_000],
      [m.id, 80_000],
    ]);
    expect(r.value.skipped).toEqual([
      { partnerId: b.id, reason: "NO_HOURS" },
      { partnerId: zero.id, reason: "ZERO_HOURS" },
    ]);
    expect(t.invoicing.state.invoices).toEqual([]);
    expect(t.ledger.journals).toEqual([]);
  });

  it("partnerIds を渡すとその取引先だけ。条件がなければ BILLING_TERMS_MISSING、使用停止は対象外", () => {
    const t = setupInvoicing();
    const a = t.addPartner();
    const bare = t.addPartner();
    const stopped = t.addPartner({ isActive: false });
    t.setTerms(a.id);
    t.setTerms(stopped.id);
    saveWorkHours(t.deps, "2026-10", { entries: [{ partnerId: a.id, hours: 1 }] });

    const only = draftInvoices(t.deps, { month: "2026-10", partnerIds: [a.id, stopped.id] }, TODAY);
    expect(only.ok && only.value.drafts.map((d) => d.partnerId)).toEqual([a.id]);
    expect(only.ok && only.value.skipped).toEqual([]);

    const missing = draftInvoices(t.deps, { month: "2026-10", partnerIds: [bare.id] }, TODAY);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("BILLING_TERMS_MISSING");
      expect(missing.error.details).toMatchObject({ partnerId: bare.id });
    }
    const unknown = draftInvoices(t.deps, { month: "2026-10", partnerIds: ["nope"] }, TODAY);
    expect(!unknown.ok && unknown.error.code).toBe("VALIDATION");
  });

  it("重複の警告は取消済みの請求書を数えない", () => {
    const t = setupInvoicing();
    const a = t.addPartner();
    t.setTerms(a.id, { billingType: "monthly", unitPrice: null, monthlyAmount: 1_000 });
    t.invoicing.insertInvoice(
      invoiceRecord({
        id: "inv-voided",
        invoiceNo: "20261001-001",
        seq: 1,
        partnerId: a.id,
        voidedAt: "2026-10-02T00:00:00.000Z",
        voidReason: "誤り",
      }),
    );
    const none = draftInvoices(t.deps, { month: "2026-10" }, TODAY);
    expect(none.ok && none.value.drafts[0]?.warnings).toEqual([]);

    t.invoicing.insertInvoice(
      invoiceRecord({ id: "inv-live", invoiceNo: "20261003-002", seq: 2, partnerId: a.id }),
    );
    const warned = draftInvoices(t.deps, { month: "2026-10" }, TODAY);
    expect(warned.ok && warned.value.drafts[0]?.warnings[0]).toMatchObject({
      code: "INVOICE_DUPLICATE_MONTH",
      details: { invoices: ["20261003-002"] },
    });
    // 別の月は警告なし
    const other = draftInvoices(t.deps, { month: "2026-11" }, TODAY);
    expect(other.ok && other.value.drafts[0]?.warnings).toEqual([]);
  });
});
