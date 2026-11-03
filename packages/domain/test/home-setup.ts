import type { HomeDeps } from "../src/usecases/home.ts";
import {
  FakeReceiptStore,
  fakeInvoicingUnitOfWork,
  fakeReceiptUnitOfWork,
  fakeRecurringUnitOfWork,
  InMemoryClosingStore,
  InMemoryInvoicingStore,
  InMemoryRecurringStore,
} from "./fakes.ts";
import { InMemoryReportRepository } from "./reports/fake-report-repository.ts";
import { setupStatements } from "./statements-setup.ts";

/**
 * ホーム（011 US1）のドメインのテストの準備: 明細の準備（`setupStatements`。2025・2026 年度の会計期間、口座の対応）に、
 * 証憑・請求・定期仕訳・決算の偽のストアを同じ帳簿・マスタにつないで足す。`deps` が `getHomeSummary` の依存
 */
export function setupHome() {
  const t = setupStatements();
  const receipts = new FakeReceiptStore();
  const receiptUow = fakeReceiptUnitOfWork(t.ledger, t.masters, receipts);
  const invoicing = new InMemoryInvoicingStore();
  const invoicingUow = fakeInvoicingUnitOfWork(t.ledger, t.masters, invoicing);
  const recurring = new InMemoryRecurringStore();
  const recurringUow = fakeRecurringUnitOfWork(t.ledger, t.masters, recurring);
  const closing = new InMemoryClosingStore(t.ledger);
  const reports = new InMemoryReportRepository(t.ledger, t.masters);
  const deps: HomeDeps = {
    statements: { uow: t.uow },
    receipts: { uow: receiptUow },
    invoicing: { uow: invoicingUow },
    recurring: { uow: recurringUow },
    blueReturn: { masters: t.masters, reports, closing },
    ledger: t.ledger,
  };
  return {
    ...t,
    /** 明細のユースケース（`setupStatements` の `deps`。`deps` は `getHomeSummary` の依存で、上書きしている） */
    statementDeps: t.deps,
    receipts,
    receiptUow,
    invoicing,
    invoicingUow,
    recurring,
    recurringUow,
    closing,
    reports,
    deps,
  };
}
export type HomeCtx = ReturnType<typeof setupHome>;
