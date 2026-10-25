import type { BillingTerms, InvoiceSettings } from "@trebuchet/schema";
import { TAX_RATES } from "../src/seed/tax-rates.ts";
import type { InvoiceItemRecord, InvoiceRecord, Partner } from "../src/types.ts";
import { createEntity } from "../src/usecases/create-entity.ts";
import { createNextFiscalPeriod } from "../src/usecases/masters.ts";
import {
  FixedClock,
  fakeInvoicingUnitOfWork,
  InMemoryInvoicingStore,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRegistry,
  SequentialIds,
} from "./fakes.ts";

export const NOW = "2026-10-31T09:00:00.000Z";

/**
 * 請求書（005）のドメインのテストの準備: 2025・2026 年度の会計期間（どちらも open）を持つ個人事業。
 * `taxable` なら 2025-01-01 から課税事業者（税込経理）、省略なら免税事業者。税率は seed を入れる
 */
export function setupInvoicing(options: { taxable?: boolean } = {}) {
  const ledger = new InMemoryLedgerRepository();
  const masters = new InMemoryMasterRepository();
  const invoicing = new InMemoryInvoicingStore();
  const uow = fakeInvoicingUnitOfWork(ledger, masters, invoicing);
  const ids = new SequentialIds();
  const clock = new FixedClock(NOW);
  const created = createEntity(
    { registry: new InMemoryRegistry(), openTenant: () => masters, ids, clock },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2025 },
  );
  if (!created.ok) throw new Error(created.error.message);
  const next = createNextFiscalPeriod({ repo: masters, ids, clock });
  if (!next.ok) throw new Error(next.error.message);
  masters.state.taxRates = [...TAX_RATES];
  if (options.taxable === true) {
    masters.replaceTaxSettings([
      {
        id: ids.next(),
        effectiveFrom: "2025-01-01",
        taxpayerStatus: "general",
        accountingMethod: "tax_included",
      },
    ]);
  }
  const deps = { uow, ids, clock };

  const accountId = (name: string) => {
    const a = masters.listAccounts().find((x) => x.name === name);
    if (a === undefined) throw new Error(`科目がない: ${name}`);
    return a.id;
  };
  let partnerCount = 0;
  const addPartner = (over: Partial<Partner> = {}): Partner => {
    partnerCount += 1;
    const partner: Partner = {
      id: ids.next(),
      name: `取引先${partnerCount}`,
      honorific: null,
      memo: null,
      isActive: true,
      ...over,
    };
    masters.insertPartner(partner);
    return partner;
  };
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
      updatedAt: NOW,
      ...over,
    };
    invoicing.upsertBillingTerms(terms);
    return terms;
  };
  const closeYear = (fiscalYear: number) => {
    const p = masters.getFiscalPeriodByYear(fiscalYear);
    if (p === undefined) throw new Error(`会計期間がない: ${fiscalYear}`);
    masters.updateFiscalPeriod({ ...p, status: "closed", closedAt: NOW });
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
    journalId: "journal-1",
    createdAt: NOW,
    voidedAt: null,
    voidReason: null,
    voidJournalId: null,
    ...over,
  };
}

export function itemRecord(over: Partial<InvoiceItemRecord> = {}): InvoiceItemRecord {
  return {
    id: "item-1",
    invoiceId: "inv-1",
    lineNo: 1,
    name: "10月分 業務委託",
    quantityHalves: null,
    unit: null,
    unitPrice: null,
    amount: 110_000,
    taxCategory: "OUT_OF_SCOPE",
    taxRate: null,
    ...over,
  };
}
