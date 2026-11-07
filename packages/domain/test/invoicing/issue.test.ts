import type { InvoiceInput } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import {
  getInvoiceDetail,
  getJournalOrigin,
  issueInvoice,
  previewInvoiceCalculation,
} from "../../src/usecases/invoicing.ts";
import { invoiceRecord, setupInvoicing } from "../invoicing-setup.ts";
import { TODAY } from "../test-dates.ts";

// 005 US1: 請求書の発行の検査と写し（R6・R9・R10・R11、FR-008〜013・015・016、H:§3.4・§3.6・§6.1）

function ready(options: { taxable?: boolean; nextSeq?: number } = {}) {
  const t = setupInvoicing(options);
  t.setSettings({
    nextSeq: options.nextSeq ?? 43,
    tradeName: "山田設計",
    registrationNumber: null,
  });
  const partner = t.addPartner({ name: "株式会社A", honorific: null });
  t.setTerms(partner.id);
  const input = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
    partnerId: partner.id,
    targetMonth: "2026-10",
    items: [
      {
        name: "10月分 業務委託",
        quantity: 120.5,
        unit: "時間",
        unitPrice: 10_000,
        amount: 1_205_000,
      },
    ],
    ...over,
  });
  return { ...t, partner, input };
}

describe("issueInvoice（成功）", () => {
  it("番号 YYYYMMDD-043・売上の仕訳・写し（宛名・敬称・発行者・期限）を作り、次の通し番号を進める", () => {
    const t = ready();
    t.setTerms(t.partner.id, { billingName: "A 社 経理部" });
    const r = issueInvoice(t.deps, t.input({ issueDate: "2026-11-05" }), TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { invoice, journal } = r.value;

    expect(invoice).toMatchObject({
      invoiceNo: "20261105-043",
      partnerId: t.partner.id,
      targetMonth: "2026-10",
      issueDate: "2026-11-05",
      salesDate: "2026-10-31",
      dueDate: "2026-11-30",
      recipientName: "A 社 経理部",
      recipientHonorific: "御中",
      taxDisplay: "separate",
      total: 1_205_000,
      status: "unpaid",
      paid: 0,
      remaining: 1_205_000,
      overdue: false,
      journalId: journal.id,
      voidedAt: null,
      payments: [],
    });
    expect(invoice.issuer).toEqual({
      issuerName: "山田 太郎",
      tradeName: "山田設計",
      address: "東京都千代田区",
      contact: "taro@example.com",
      bankAccount: "○○銀行 普通 1234567",
      registrationNumber: null,
    });
    expect(invoice.items).toEqual([
      {
        lineNo: 1,
        name: "10月分 業務委託",
        quantity: 120.5,
        unit: "時間",
        unitPrice: 10_000,
        amount: 1_205_000,
        taxCategory: "OUT_OF_SCOPE",
        taxRate: null,
      },
    ]);
    expect(journal).toMatchObject({
      date: "2026-10-31",
      source: "invoice",
      memo: "請求書 20261105-043",
    });
    expect(journal.lines.map((l) => [l.side, l.amount, l.partnerId])).toEqual([
      ["debit", 1_205_000, t.partner.id],
      ["credit", 1_205_000, t.partner.id],
    ]);
    expect(t.invoicing.getInvoiceSettings()?.nextSeq).toBe(44);
    expect(t.invoicing.audits.map((a) => [a.targetType, a.action, a.targetId])).toEqual([
      ["invoice", "create", invoice.id],
    ]);
    expect(t.ledger.journals.filter((j) => j.source === "invoice")).toHaveLength(1);
  });

  it("宛名は条件に宛名がなければ取引先名、敬称は取引先の敬称、なければ 御中。発行日の既定は今日、計上日は対象月の末日", () => {
    const t = ready();
    const named = t.addPartner({ name: "B 商事", honorific: "様" });
    t.setTerms(named.id, { dueMonthsAfter: 0, dueDay: 10 });
    const r = issueInvoice(t.deps, t.input({ partnerId: named.id, targetMonth: "2026-02" }), TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.invoice).toMatchObject({
      recipientName: "B 商事",
      recipientHonorific: "様",
      issueDate: TODAY,
      salesDate: "2026-02-28",
      dueDate: "2026-02-10",
      invoiceNo: "20261031-043",
    });
  });

  it("課税事業者で別記: 税区分ごとに貸方 1 行、税率ごとの別記と仕訳の税額が一致（R10）", () => {
    const t = ready({ taxable: true });
    const r = issueInvoice(
      t.deps,
      t.input({
        items: [
          { name: "開発", amount: 110_000 },
          { name: "教材", amount: 55_000, taxCategory: "SALES_8R" },
          { name: "保守", amount: 11_000, taxCategory: "SALES_10" },
          { name: "実費", amount: 1_000, taxCategory: "OUT_OF_SCOPE" },
        ],
      }),
      TODAY,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { invoice, journal } = r.value;
    expect(invoice.taxDisplay).toBe("separate");
    expect(invoice.total).toBe(177_000);
    expect(invoice.items.map((i) => [i.taxCategory, i.taxRate])).toEqual([
      ["SALES_10", 10],
      ["SALES_8R", 8],
      ["SALES_10", 10],
      ["OUT_OF_SCOPE", null],
    ]);
    // 10%: 121,000 → 11,000、8%: 55,000 → 4,074
    expect(invoice.taxBreakdown).toEqual([
      { rate: 10, inclusive: 121_000, tax: 11_000, exclusive: 110_000 },
      { rate: 8, inclusive: 55_000, tax: 4_074, exclusive: 50_926 },
    ]);
    const credits = journal.lines.filter((l) => l.side === "credit");
    expect(credits.map((l) => [l.taxCategory, l.amount, l.taxAmount])).toEqual([
      ["SALES_10", 121_000, 11_000],
      ["SALES_8R", 55_000, 4_074],
      ["OUT_OF_SCOPE", 1_000, 0],
    ]);
    expect(journal.lines.find((l) => l.side === "debit")?.amount).toBe(177_000);
  });

  it("計上日が免税でも写しは表示の設定どおり", () => {
    const t = ready();
    t.setSettings({ nextSeq: 1, taxDisplay: "separate" });
    const r = issueInvoice(t.deps, t.input(), TODAY);
    expect(r.ok && r.value.invoice.taxDisplay).toBe("separate");
  });

  it("数量だけ・単価だけの明細は金額をそのまま使う", () => {
    const t = ready();
    const r = issueInvoice(
      t.deps,
      t.input({
        items: [
          { name: "式", quantity: 2, amount: 1_000 },
          { name: "単価だけ", unitPrice: 3_000, amount: 2_500 },
        ],
      }),
      TODAY,
    );
    expect(r.ok && r.value.invoice.items.map((i) => [i.quantity, i.unitPrice, i.amount])).toEqual([
      [2, null, 1_000],
      [null, 3_000, 2_500],
    ]);
  });
});

describe("issueInvoice（検査。何も書かない）", () => {
  const untouched = (t: ReturnType<typeof ready>) => {
    expect(t.ledger.journals).toEqual([]);
    expect(t.invoicing.state.invoices).toEqual([]);
    expect(t.invoicing.state.items).toEqual([]);
    expect(t.invoicing.audits).toEqual([]);
  };

  it("発行者の設定がない・必須の項目が空なら INVOICE_ISSUER_INCOMPLETE（details.fields）", () => {
    const t = ready();
    t.invoicing.state.settings = null;
    const none = issueInvoice(t.deps, t.input(), TODAY);
    expect(!none.ok && none.error.code).toBe("INVOICE_ISSUER_INCOMPLETE");

    t.setSettings({ address: " ", bankAccount: "" });
    const empty = issueInvoice(t.deps, t.input(), TODAY);
    expect(!empty.ok && empty.error.details).toMatchObject({ fields: ["address", "bankAccount"] });
    untouched(t);
  });

  it("取引先の使用停止は PARTNER_INACTIVE、存在しない取引先は VALIDATION、条件がなければ BILLING_TERMS_MISSING", () => {
    const t = ready();
    t.masters.updatePartner({ ...t.partner, isActive: false });
    const stopped = issueInvoice(t.deps, t.input(), TODAY);
    expect(!stopped.ok && stopped.error.code).toBe("PARTNER_INACTIVE");

    const unknown = issueInvoice(t.deps, t.input({ partnerId: "nobody" }), TODAY);
    expect(!unknown.ok && unknown.error.code).toBe("VALIDATION");

    const bare = t.addPartner();
    const noTerms = issueInvoice(t.deps, t.input({ partnerId: bare.id }), TODAY);
    expect(!noTerms.ok && noTerms.error.code).toBe("BILLING_TERMS_MISSING");
    untouched(t);
  });

  it("同じ取引先・対象月の有効な請求書があれば INVOICE_DUPLICATE_MONTH。confirmDuplicate で発行できる。取消済みは数えない", () => {
    const t = ready();
    t.invoicing.insertInvoice(
      invoiceRecord({
        id: "voided",
        invoiceNo: "20261001-001",
        seq: 1,
        partnerId: t.partner.id,
        voidedAt: "2026-10-02T00:00:00.000Z",
        voidReason: "誤り",
      }),
    );
    expect(issueInvoice(t.deps, t.input(), TODAY).ok).toBe(true);

    const dup = issueInvoice(t.deps, t.input(), TODAY);
    expect(!dup.ok && dup.error.code).toBe("INVOICE_DUPLICATE_MONTH");
    expect(!dup.ok && dup.error.details).toMatchObject({ invoices: ["20261031-043"] });
    expect(t.invoicing.state.invoices).toHaveLength(2);

    const confirmed = issueInvoice(t.deps, t.input({ confirmDuplicate: true }), TODAY);
    expect(confirmed.ok && confirmed.value.invoice.invoiceNo).toBe("20261031-044");
  });

  it("数量 × 単価と金額が一致しない・明細が 0 行か 6 行以上・日付が不正なら VALIDATION", () => {
    const t = ready();
    const cases: Partial<InvoiceInput>[] = [
      { items: [{ name: "x", quantity: 1, unitPrice: 1000, amount: 999 }] },
      { items: [] },
      { items: Array.from({ length: 6 }, (_, i) => ({ name: `n${i}`, amount: 1 })) },
      { items: [{ name: "x", quantity: 1.25, unitPrice: 1000, amount: 1250 }] },
      { items: [{ name: " ", amount: 100 }] },
      { items: [{ name: "x", amount: 0 }] },
      { issueDate: "2026-02-30" },
      { salesDate: "2026-13-01" },
    ];
    for (const over of cases) {
      const r = issueInvoice(t.deps, t.input(over), TODAY);
      expect(!r.ok && r.error.code, JSON.stringify(over)).toBe("VALIDATION");
    }
    untouched(t);
  });

  it("001 の検査のエラーをそのまま返し、仕訳も請求書も番号も残さない（PERIOD_CLOSED・OUT_OF_PERIOD・TAX_SETTING_GAP）", () => {
    const t = ready();
    const before = t.invoicing.getInvoiceSettings();
    t.closeYear(2026);
    const closed = issueInvoice(t.deps, t.input(), TODAY);
    expect(!closed.ok && closed.error.code).toBe("PERIOD_CLOSED");

    const outside = issueInvoice(t.deps, t.input({ salesDate: "2030-01-31" }), TODAY);
    expect(!outside.ok && outside.error.code).toBe("OUT_OF_PERIOD");

    t.masters.replaceTaxSettings([
      {
        id: "gap",
        effectiveFrom: "2025-07-01",
        taxpayerStatus: "general",
        accountingMethod: "tax_included",
      },
    ]);
    const gap = issueInvoice(t.deps, t.input({ salesDate: "2025-03-31" }), TODAY);
    expect(!gap.ok && gap.error.code).toBe("TAX_SETTING_GAP");
    expect(t.invoicing.getInvoiceSettings()).toEqual(before);
    untouched(t);
  });
});

describe("getInvoiceDetail・getJournalOrigin", () => {
  it("存在しない請求書は INVOICE_NOT_FOUND（details.invoiceId）", () => {
    const t = ready();
    const r = getInvoiceDetail(t.deps, "missing", TODAY);
    expect(!r.ok && r.error.code).toBe("INVOICE_NOT_FOUND");
    expect(!r.ok && r.error.details).toEqual({ invoiceId: "missing" });
  });

  it("詳細の状態・残額は消し込みから導く（取消済みの消し込みは数えない）", () => {
    const t = ready();
    const r = issueInvoice(t.deps, t.input(), TODAY);
    if (!r.ok) throw new Error("expected ok");
    const id = r.value.invoice.id;
    t.invoicing.state.payments.push(
      {
        id: "pay-1",
        invoiceId: id,
        receivedOn: "2026-11-10",
        amount: 1_000_000,
        feeAmount: 0,
        withholdingAmount: 0,
        depositAccountId: t.accountId("普通預金"),
        depositSubAccountId: null,
        journalId: "j-pay-1",
        createdAt: "2026-11-10T00:00:00.000Z",
        voidedAt: null,
        voidReason: null,
        voidJournalId: null,
      },
      {
        id: "pay-2",
        invoiceId: id,
        receivedOn: "2026-11-11",
        amount: 205_000,
        feeAmount: 0,
        withholdingAmount: 0,
        depositAccountId: t.accountId("普通預金"),
        depositSubAccountId: null,
        journalId: "j-pay-2",
        createdAt: "2026-11-11T00:00:00.000Z",
        voidedAt: "2026-11-12T00:00:00.000Z",
        voidReason: "誤り",
        voidJournalId: null,
      },
    );
    const detail = getInvoiceDetail(t.deps, id, TODAY);
    expect(detail.ok && detail.value).toMatchObject({
      status: "partial",
      paid: 1_000_000,
      remaining: 205_000,
    });
    expect(detail.ok && detail.value.payments.map((p) => p.id)).toEqual(["pay-1", "pay-2"]);
    // 一覧用の要約には invoiceId・createdAt を含めない（PaymentView の形）
    expect(detail.ok && Object.keys(detail.value.payments[0] ?? {})).not.toContain("invoiceId");
  });

  it("仕訳の起点: 請求書の仕訳は invoice、ふつうの仕訳は null、ない仕訳は JOURNAL_NOT_FOUND", () => {
    const t = ready();
    const r = issueInvoice(t.deps, t.input(), TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(getJournalOrigin(t.deps, r.value.journal.id)).toEqual({
      ok: true,
      value: {
        kind: "invoice",
        invoiceId: r.value.invoice.id,
        invoiceNo: r.value.invoice.invoiceNo,
      },
    });
    const missing = getJournalOrigin(t.deps, "nope");
    expect(!missing.ok && missing.error.code).toBe("JOURNAL_NOT_FOUND");
  });
});

// 013 US1: 源泉徴収（R3・R5、FR-001〜007、contracts §2）
describe("源泉徴収（013）", () => {
  const withholdingReady = (taxable: boolean, taxDisplay: "separate" | "inclusive_only") => {
    const t = ready({ taxable });
    t.setSettings({ nextSeq: 43, taxDisplay });
    t.setTerms(t.partner.id, { withholding: true });
    return t;
  };

  it("US1-1: 別記（税抜）なら対象額は 300,000 円・税額 30,630 円・差引 299,370 円。仕訳は合計の 1 件だけ", () => {
    const t = withholdingReady(true, "separate");
    const r = issueInvoice(
      t.deps,
      t.input({ items: [{ name: "業務", amount: 330_000, taxCategory: "SALES_10" }] }),
      TODAY,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.invoice).toMatchObject({
      total: 330_000,
      withholdingBase: 300_000,
      withholdingTax: 30_630,
      netAmount: 299_370,
    });
    expect(t.ledger.journals.filter((j) => j.source === "invoice")).toHaveLength(1);
    expect(r.value.journal.lines.map((l) => [l.side, l.amount])).toEqual([
      ["debit", 330_000],
      ["credit", 330_000],
    ]);
  });

  it("US1-2: 区分しない表示なら対象額は税込の 1,205,000 円・税額 143,961 円", () => {
    const t = withholdingReady(false, "inclusive_only");
    const r = issueInvoice(t.deps, t.input(), TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.invoice).toMatchObject({
      total: 1_205_000,
      withholdingBase: 1_205_000,
      withholdingTax: 143_961,
      netAmount: 1_061_039,
    });
    expect(r.value.journal.lines.map((l) => [l.side, l.amount])).toEqual([
      ["debit", 1_205_000],
      ["credit", 1_205_000],
    ]);
  });

  it("US1-3: 「なし」の取引先は 0・0 で、差引は合計と同じ（税制の値がなくても発行できる）", () => {
    const t = ready();
    t.invoicing.state.taxParameters = [];
    const r = issueInvoice(t.deps, t.input(), TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.invoice).toMatchObject({
      withholdingBase: 0,
      withholdingTax: 0,
      netAmount: 1_205_000,
    });
  });

  it("US1-4: 発行時に固定し、取引先の設定を後で変えても詳細・保存した写しは変わらない", () => {
    const t = withholdingReady(false, "inclusive_only");
    const r = issueInvoice(t.deps, t.input(), TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    t.setTerms(t.partner.id, { withholding: false });
    t.invoicing.state.taxParameters = [];
    const detail = getInvoiceDetail(t.deps, r.value.invoice.id, TODAY);
    expect(detail.ok && detail.value).toEqual(r.value.invoice);
    expect(t.invoicing.getInvoice(r.value.invoice.id)).toMatchObject({
      withholdingBase: 1_205_000,
      withholdingTax: 143_961,
    });
  });

  it("発行の記録（監査）の after の請求書に源泉徴収の対象額・税額が入る", () => {
    const t = withholdingReady(false, "inclusive_only");
    const r = issueInvoice(t.deps, t.input(), TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const after = JSON.parse(t.invoicing.audits.at(-1)?.afterJson ?? "null");
    expect(after.invoice).toMatchObject({ withholdingBase: 1_205_000, withholdingTax: 143_961 });
  });

  it("発行日に税制の値がなければ WITHHOLDING_RATE_MISSING（details.date は発行日）。何も書かない", () => {
    const t = withholdingReady(false, "inclusive_only");
    t.invoicing.state.taxParameters = [];
    const r = issueInvoice(t.deps, t.input({ issueDate: "2026-11-05" }), TODAY);
    expect(r).toMatchObject({
      ok: false,
      error: { code: "WITHHOLDING_RATE_MISSING", details: { date: "2026-11-05" } },
    });
    expect(t.ledger.journals).toEqual([]);
    expect(t.invoicing.state.invoices).toEqual([]);
    expect(t.invoicing.getInvoiceSettings()?.nextSeq).toBe(43);
  });

  it("計算（プレビュー）: partnerId の設定を引き、発行日（省略は今日）の値で計算する。partnerId なしは 0・0", () => {
    const t = withholdingReady(false, "inclusive_only");
    const items = [{ amount: 1_205_000, taxRate: null }];
    const withHolding = previewInvoiceCalculation(
      t.deps,
      { priceMode: "inclusive", items, partnerId: t.partner.id },
      TODAY,
    );
    expect(withHolding).toMatchObject({
      ok: true,
      value: {
        total: 1_205_000,
        withholdingBase: 1_205_000,
        withholdingTax: 143_961,
        netAmount: 1_061_039,
      },
    });
    const without = previewInvoiceCalculation(t.deps, { priceMode: "inclusive", items }, TODAY);
    expect(without).toMatchObject({
      ok: true,
      value: { withholdingBase: 0, withholdingTax: 0, netAmount: 1_205_000 },
    });
    t.invoicing.state.taxParameters = [];
    const missing = previewInvoiceCalculation(
      t.deps,
      { priceMode: "inclusive", items, partnerId: t.partner.id, issueDate: "2026-11-05" },
      TODAY,
    );
    expect(missing).toMatchObject({
      ok: false,
      error: { code: "WITHHOLDING_RATE_MISSING", details: { date: "2026-11-05" } },
    });
  });

  it("計算（プレビュー）: 別記（税抜）の対象額は合計から消費税相当額を引いた額", () => {
    const t = withholdingReady(true, "separate");
    const r = previewInvoiceCalculation(
      t.deps,
      {
        priceMode: "inclusive",
        items: [{ amount: 330_000, taxRate: 10 }],
        partnerId: t.partner.id,
      },
      TODAY,
    );
    expect(r).toMatchObject({
      ok: true,
      value: { withholdingBase: 300_000, withholdingTax: 30_630, netAmount: 299_370 },
    });
  });
});
