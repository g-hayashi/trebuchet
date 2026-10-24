import type {
  InvoicingAuditEntry,
  InvoicingStore,
  InvoicingUnitOfWork,
  LedgerRepository,
  MasterRepository,
} from "@trebuchet/domain";
import type { BillingTerms, InvoiceSettings, JournalOrigin } from "@trebuchet/schema";
import type { RunResult } from "better-sqlite3";
import { asc, eq, max, or } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { DrizzleLedgerRepository } from "./ledger-repository.ts";
import { DrizzleMasterRepository } from "./master-repository.ts";
import type * as tenantSchema from "./schema/tenant.ts";
import {
  invoicePayments,
  invoiceSettings,
  invoices,
  invoicingAuditLog,
  partnerBillingTerms,
  recurringJournals,
  recurringRuns,
} from "./schema/tenant.ts";

/** テナントの DB、またはそのトランザクション */
type TenantConn = BaseSQLiteDatabase<"sync", RunResult, typeof tenantSchema>;

/** `invoicing_audit_log` に1行を追記する。InvoicingStore と RecurringStore が共有する（R23） */
export function appendInvoicingAuditRow(db: TenantConn, entry: InvoicingAuditEntry): void {
  db.insert(invoicingAuditLog).values(entry).run();
}

/**
 * InvoicingStore の Drizzle（better-sqlite3）による実装。メソッドはすべて同期。
 * 請求書・入金のメソッドは US1・US4 の db のタスクで足す
 */
export class DrizzleInvoicingStore implements InvoicingStore {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  appendInvoicingAudit(entry: InvoicingAuditEntry): void {
    appendInvoicingAuditRow(this.db, entry);
  }

  // ---- 発行者の設定 ----

  getInvoiceSettings(): InvoiceSettings | null {
    const row = this.db.select().from(invoiceSettings).where(eq(invoiceSettings.id, 1)).get();
    if (row === undefined) return null;
    const { id: _id, ...settings } = row;
    return settings;
  }

  upsertInvoiceSettings(row: InvoiceSettings): void {
    const values = { ...row };
    this.db
      .insert(invoiceSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: invoiceSettings.id, set: values })
      .run();
  }

  maxInvoiceSeq(): number | null {
    const row = this.db
      .select({ max: max(invoices.seq) })
      .from(invoices)
      .get();
    return row?.max ?? null;
  }

  // ---- 請求の条件 ----

  listBillingTerms(): BillingTerms[] {
    return this.db
      .select()
      .from(partnerBillingTerms)
      .orderBy(asc(partnerBillingTerms.partnerId))
      .all();
  }

  getBillingTerms(partnerId: string): BillingTerms | null {
    return (
      this.db
        .select()
        .from(partnerBillingTerms)
        .where(eq(partnerBillingTerms.partnerId, partnerId))
        .get() ?? null
    );
  }

  upsertBillingTerms(row: BillingTerms): void {
    const { partnerId: _partnerId, ...set } = row;
    this.db
      .insert(partnerBillingTerms)
      .values(row)
      .onConflictDoUpdate({ target: partnerBillingTerms.partnerId, set })
      .run();
  }

  deleteBillingTerms(partnerId: string): void {
    this.db.delete(partnerBillingTerms).where(eq(partnerBillingTerms.partnerId, partnerId)).run();
  }

  /** 請求書・入金・定期仕訳の仕訳の ID から起点を引く。取消の仕訳（`void_journal_id`）も元の請求・入金を指す */
  originOfJournal(journalId: string): JournalOrigin | null {
    const invoice = this.db
      .select({ invoiceId: invoices.id, invoiceNo: invoices.invoiceNo })
      .from(invoices)
      .where(or(eq(invoices.journalId, journalId), eq(invoices.voidJournalId, journalId)))
      .get();
    if (invoice !== undefined) return { kind: "invoice", ...invoice };

    const payment = this.db
      .select({
        invoiceId: invoices.id,
        invoiceNo: invoices.invoiceNo,
        paymentId: invoicePayments.id,
      })
      .from(invoicePayments)
      .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
      .where(
        or(eq(invoicePayments.journalId, journalId), eq(invoicePayments.voidJournalId, journalId)),
      )
      .get();
    if (payment !== undefined) return { kind: "payment", ...payment };

    const run = this.db
      .select({
        recurringId: recurringJournals.id,
        name: recurringJournals.name,
        targetMonth: recurringRuns.targetMonth,
      })
      .from(recurringRuns)
      .innerJoin(recurringJournals, eq(recurringJournals.id, recurringRuns.recurringId))
      .where(eq(recurringRuns.journalId, journalId))
      .get();
    if (run !== undefined) return { kind: "recurring", ...run };

    return null;
  }
}

/**
 * InvoicingUnitOfWork の Drizzle 実装（003 の DrizzleClosingUnitOfWork と同じ形）。
 * 同じ接続・トランザクションで仕訳・マスタ・請求の記録を扱う。
 * `transaction` は例外で巻き戻すが、`err` を返しても確定する（R9）
 */
export class DrizzleInvoicingUnitOfWork implements InvoicingUnitOfWork {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  transaction<T>(
    fn: (tx: {
      ledger: LedgerRepository;
      masters: MasterRepository;
      invoicing: InvoicingStore;
    }) => T,
  ): T {
    return this.db.transaction((tx) =>
      fn({
        ledger: new DrizzleLedgerRepository(tx),
        masters: new DrizzleMasterRepository(tx),
        invoicing: new DrizzleInvoicingStore(tx),
      }),
    );
  }
}
