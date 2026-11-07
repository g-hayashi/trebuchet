import type { BillingTerms, InvoiceSettings } from "@trebuchet/schema";
import type { InvoiceRecord } from "../src/types.ts";
import { fakeInvoicingUnitOfWork, InMemoryInvoicingStore } from "./fakes.ts";
import { setupBase } from "./ledger-setup.ts";
import { NOW } from "./test-dates.ts";

/**
 * 請求書（005）のドメインのテストの準備: `setupBase`（2025・2026 年度の会計期間、税率の seed）に、
 * 請求の保管庫と UnitOfWork を足す。`taxable` なら 2025-01-01 から課税事業者（税込経理）、省略なら免税事業者
 */
export function setupInvoicing(options: { taxable?: boolean } = {}) {
  const base = setupBase(options);
  const { ledger, masters, ids, clock, accountId, addPartner, closeYear } = base;
  const invoicing = new InMemoryInvoicingStore();
  const uow = fakeInvoicingUnitOfWork(ledger, masters, invoicing);
  const deps = { uow, ids, clock };

  const setSettings = (over: Partial<InvoiceSettings> = {}): InvoiceSettings => {
    const settings: InvoiceSettings = {
      issuerName: "山田 太郎",
      tradeName: null,
      address: "東京都千代田区",
      contact: "taro@example.com",
      bankAccount: "○○銀行 普通 1234567",
      registrationNumber: null,
      taxDisplay: "separate",
      nextSeq: 1,
      updatedAt: NOW,
      ...over,
    };
    invoicing.upsertInvoiceSettings(settings);
    return settings;
  };
  const setTerms = (partnerId: string, over: Partial<BillingTerms> = {}): BillingTerms => {
    const terms: BillingTerms = {
      partnerId,
      billingType: "hourly",
      unitPrice: 10_000,
      monthlyAmount: null,
      dueMonthsAfter: 1,
      dueDay: 31,
      defaultItemName: "業務委託",
      billingName: null,
      withholding: false,
      updatedAt: NOW,
      ...over,
    };
    invoicing.upsertBillingTerms(terms);
    return terms;
  };

  return {
    ledger,
    masters,
    invoicing,
    uow,
    ids,
    clock,
    deps,
    accountId,
    addPartner,
    setSettings,
    setTerms,
    closeYear,
  };
}

/**
 * 性質テスト用: 取引先 3 件（時間単価型・月額定額型・時間単価型）と、発行者の設定（次の通し番号は `initialSeq`）。
 * `makeUow` で UnitOfWork を差し替えられる（障害の注入）
 */
export function setupScenario(options: { taxable: boolean; initialSeq: number }) {
  const t = setupInvoicing({ taxable: options.taxable });
  const partners = [
    t.addPartner({ name: "取引先A", honorific: "御中" }),
    t.addPartner({ name: "取引先B", honorific: "様" }),
    t.addPartner({ name: "取引先C", honorific: null }),
  ];
  t.setTerms(partners[0]?.id ?? "");
  t.setTerms(partners[1]?.id ?? "", {
    billingType: "monthly",
    unitPrice: null,
    monthlyAmount: 300_000,
    billingName: "B 社 経理部",
  });
  t.setTerms(partners[2]?.id ?? "", { dueMonthsAfter: 2, dueDay: 10 });
  t.setSettings({ nextSeq: options.initialSeq });
  return { ...t, partnerIds: partners.map((p) => p.id) };
}

/** 発行済みの請求書の行（`invoicing.state` に直接入れるテスト用。仕訳との結びつきは持たない） */
export function invoiceRecord(over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: "inv-1",
    invoiceNo: "20261031-001",
    seq: 1,
    partnerId: "partner-1",
    targetMonth: "2026-10",
    issueDate: "2026-10-31",
    salesDate: "2026-10-31",
    dueDate: "2026-11-30",
    recipientName: "株式会社A",
    recipientHonorific: "御中",
    issuer: {
      issuerName: "山田 太郎",
      tradeName: null,
      address: "東京都千代田区",
      contact: "taro@example.com",
      bankAccount: "○○銀行 普通 1234567",
      registrationNumber: null,
    },
    taxDisplay: "inclusive_only",
    total: 110_000,
    withholdingBase: 0,
    withholdingTax: 0,
    journalId: "journal-1",
    createdAt: NOW,
    voidedAt: null,
    voidReason: null,
    voidJournalId: null,
    ...over,
  };
}
