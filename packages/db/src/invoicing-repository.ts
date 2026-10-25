import type {
  InvoiceItemRecord,
  InvoiceRecord,
  InvoicingAuditEntry,
  InvoicingStore,
  InvoicingUnitOfWork,
  PaymentRecord,
  WorkHoursRow,
} from "@trebuchet/domain";
import type {
  BillingTerms,
  InvoiceIssuer,
  InvoiceSettings,
  JournalOrigin,
} from "@trebuchet/schema";
import { and, asc, desc, eq, isNull, max, or } from "drizzle-orm";
import { rowidOf, type TenantConn } from "./internal.ts";
import {
  invoiceItems,
  invoicePayments,
  invoiceSettings,
  invoices,
  invoicingAuditLog,
  partnerBillingTerms,
  recurringJournals,
  recurringRuns,
  workHours,
} from "./schema/tenant.ts";
import { drizzleUnitOfWork } from "./unit-of-work.ts";

/** `invoices` の行を請求書の写しにする（`issuer_json` を読み戻す） */
function toInvoiceRecord(row: typeof invoices.$inferSelect): InvoiceRecord {
  const { issuerJson, ...rest } = row;
  return { ...rest, issuer: JSON.parse(issuerJson) as InvoiceIssuer };
}

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

  // ---- 工数 ----

  listWorkHours(targetMonth: string): WorkHoursRow[] {
    return this.db
      .select()
      .from(workHours)
      .where(eq(workHours.targetMonth, targetMonth))
      .orderBy(asc(workHours.partnerId))
      .all();
  }

  getWorkHours(partnerId: string, targetMonth: string): WorkHoursRow | null {
    return (
      this.db
        .select()
        .from(workHours)
        .where(and(eq(workHours.partnerId, partnerId), eq(workHours.targetMonth, targetMonth)))
        .get() ?? null
    );
  }

  upsertWorkHours(row: WorkHoursRow): void {
    this.db
      .insert(workHours)
      .values(row)
      .onConflictDoUpdate({
        target: [workHours.partnerId, workHours.targetMonth],
        set: { halfHours: row.halfHours, updatedAt: row.updatedAt },
      })
      .run();
  }

  // ---- 請求書 ----

  insertInvoice(invoice: InvoiceRecord): void {
    const { issuer, ...rest } = invoice;
    this.db
      .insert(invoices)
      .values({ ...rest, issuerJson: JSON.stringify(issuer) })
      .run();
  }

  insertInvoiceItems(items: InvoiceItemRecord[]): void {
    if (items.length === 0) return;
    this.db.insert(invoiceItems).values(items).run();
  }

  getInvoice(id: string): InvoiceRecord | null {
    const row = this.db.select().from(invoices).where(eq(invoices.id, id)).get();
    return row === undefined ? null : toInvoiceRecord(row);
  }

  listInvoiceItems(invoiceId: string): InvoiceItemRecord[] {
    return this.db
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoiceId))
      .orderBy(asc(invoiceItems.lineNo))
      .all()
      .map((row) => ({ ...row, taxCategory: row.taxCategory as InvoiceItemRecord["taxCategory"] }));
  }

  listInvoices(query: {
    partnerId?: string | undefined;
    month?: string | undefined;
  }): InvoiceRecord[] {
    const conditions = [
      query.partnerId === undefined ? undefined : eq(invoices.partnerId, query.partnerId),
      query.month === undefined ? undefined : eq(invoices.targetMonth, query.month),
    ];
    return this.db
      .select()
      .from(invoices)
      .where(and(...conditions))
      .orderBy(desc(invoices.issueDate), desc(invoices.seq))
      .all()
      .map(toInvoiceRecord);
  }

  listActiveInvoices(partnerId: string, targetMonth: string): InvoiceRecord[] {
    return this.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.partnerId, partnerId),
          eq(invoices.targetMonth, targetMonth),
          isNull(invoices.voidedAt),
        ),
      )
      .orderBy(asc(invoices.seq))
      .all()
      .map(toInvoiceRecord);
  }

  markInvoiceVoided(
    id: string,
    voided: { voidedAt: string; voidReason: string; voidJournalId: string | null },
  ): void {
    const result = this.db
      .update(invoices)
      .set(voided)
      .where(and(eq(invoices.id, id), isNull(invoices.voidedAt)))
      .run();
    if (result.changes !== 1) throw new Error(`取消できる請求書がありません: ${id}`);
  }

  // ---- 消し込み ----

  listPayments(invoiceId: string): PaymentRecord[] {
    return this.db
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, invoiceId))
      .orderBy(asc(invoicePayments.createdAt), asc(rowidOf(invoicePayments)))
      .all();
  }

  insertPayment(payment: PaymentRecord): void {
    this.db.insert(invoicePayments).values(payment).run();
  }

  markPaymentVoided(
    id: string,
    voided: { voidedAt: string; voidReason: string; voidJournalId: string | null },
  ): void {
    const result = this.db
      .update(invoicePayments)
      .set(voided)
      .where(and(eq(invoicePayments.id, id), isNull(invoicePayments.voidedAt)))
      .run();
    if (result.changes !== 1) throw new Error(`取消できる消し込みがありません: ${id}`);
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

/** InvoicingUnitOfWork の実装。仕訳・マスタ・請求の記録を同じトランザクションで扱う（R9） */
export const createInvoicingUnitOfWork = (db: TenantConn): InvoicingUnitOfWork =>
  drizzleUnitOfWork(db, (tx) => ({ invoicing: new DrizzleInvoicingStore(tx) }));
