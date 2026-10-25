import { randomUUIDv7 } from "node:crypto";
import { createJournal, type InvoiceRecord, type Partner } from "@trebuchet/domain";
import type { BillingTerms, InvoiceSettings } from "@trebuchet/schema";
import { createInvoicingUnitOfWork, DrizzleInvoicingStore } from "../src/invoicing-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant } from "../src/tenant-store.ts";
import { accountIdOf, createTestEntity, NOW } from "../src/testing.ts";

/**
 * 005 の db のテストの準備（呼ぶ前に `useTempDataDir` を使うこと）。
 * 2026 年度 1 年分の会計期間を持つ個人事業（免税）。税率は DB のマイグレーションの値
 */
export function setupInvoicingDb(options: { taxable?: boolean } = {}) {
  const ids = { next: () => randomUUIDv7() };
  const clock = { now: () => NOW };
  const db = openTenant(createTestEntity({ ids }).id);
  const masters = new DrizzleMasterRepository(db);
  if (options.taxable === true) {
    masters.replaceTaxSettings([
      {
        id: ids.next(),
        effectiveFrom: "2026-01-01",
        taxpayerStatus: "general",
        accountingMethod: "tax_included",
      },
    ]);
  }
  const store = new DrizzleInvoicingStore(db);
  const uow = createInvoicingUnitOfWork(db);
  const ledger = new DrizzleLedgerRepository(db);

  const accountId = (name: string) => accountIdOf(masters, name);
  const addPartner = (name: string, over: Partial<Partner> = {}): Partner => {
    const partner: Partner = {
      id: randomUUIDv7(),
      name,
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
    store.upsertInvoiceSettings(settings);
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
    store.upsertBillingTerms(terms);
    return terms;
  };
  let seedSeq = 0;
  /** 売上の仕訳（source = invoice）と請求書の行を 1 組作る（取消済みにするときは `voidedAt` などを渡す） */
  const seedInvoice = (over: Partial<InvoiceRecord> & { partnerId: string }): InvoiceRecord => {
    seedSeq += 1;
    const total = over.total ?? 110_000;
    const posted = createJournal(
      { ledger, masters, ids, clock },
      {
        date: over.salesDate ?? "2026-10-31",
        memo: "請求書",
        lines: [
          {
            side: "debit",
            accountId: accountId("売掛金"),
            amount: total,
            partnerId: over.partnerId,
          },
          {
            side: "credit",
            accountId: accountId("売上高"),
            amount: total,
            partnerId: over.partnerId,
          },
        ],
      },
      { source: "invoice" },
    );
    if (!posted.ok) throw new Error(JSON.stringify(posted.error));
    const invoice: InvoiceRecord = {
      id: randomUUIDv7(),
      invoiceNo: `20261031-${String(seedSeq).padStart(3, "0")}`,
      seq: seedSeq,
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
      total,
      journalId: posted.value.journal.id,
      createdAt: NOW,
      voidedAt: null,
      voidReason: null,
      voidJournalId: null,
      ...over,
    };
    store.insertInvoice(invoice);
    return invoice;
  };
  const count = (table: string) =>
    (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  return {
    db,
    masters,
    ledger,
    store,
    uow,
    ids,
    clock,
    deps: { uow, ids, clock },
    accountId,
    addPartner,
    setSettings,
    setTerms,
    seedInvoice,
    count,
  };
}
