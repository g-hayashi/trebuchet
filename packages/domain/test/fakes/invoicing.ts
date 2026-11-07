import type { BillingTerms, InvoiceSettings, JournalOrigin } from "@trebuchet/schema";
import type { InvoicingStore } from "../../src/ports.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type {
  InvoiceItemRecord,
  InvoiceRecord,
  InvoicingAuditEntry,
  PaymentRecord,
  TaxParameter,
  WorkHoursRow,
} from "../../src/types.ts";
import { InMemoryLedgerRepository } from "./ledger.ts";
import { InMemoryMasterRepository } from "./master.ts";
import { fakeUnitOfWork } from "./unit-of-work.ts";

type InvoicingState = {
  origins: Record<string, JournalOrigin>;
  audits: InvoicingAuditEntry[];
  settings: InvoiceSettings | null;
  billingTerms: BillingTerms[];
  workHours: WorkHoursRow[];
  invoices: InvoiceRecord[];
  items: InvoiceItemRecord[];
  /** 消し込み。書き込みは US2（T017）で足すので、それまではテストが直接入れる */
  payments: PaymentRecord[];
  /** 税制の値（013 の源泉徴収の率）。既定は seed の値。テストが差し替える */
  taxParameters: TaxParameter[];
};

/**
 * InvoicingStore のフェイク。メソッドは各ストーリーのタスクで足す。
 * 仕訳の起点は請求書・入金の表から引く。定期仕訳の表は US3 まで無いので、
 * テストが `registerOrigin` で登録した起点を最後に探す
 */
export class InMemoryInvoicingStore implements InvoicingStore {
  state: InvoicingState = {
    origins: {},
    audits: [],
    settings: null,
    billingTerms: [],
    workHours: [],
    invoices: [],
    items: [],
    payments: [],
    taxParameters: structuredClone([...TAX_PARAMETERS]),
  };

  get audits(): InvoicingAuditEntry[] {
    return this.state.audits;
  }

  listTaxParameters(): TaxParameter[] {
    return structuredClone(this.state.taxParameters);
  }

  /** 定期仕訳の起点（定期仕訳の表は US3 で足す）。請求・入金の起点は表から引く */
  registerOrigin(journalId: string, origin: JournalOrigin): void {
    this.state.origins[journalId] = structuredClone(origin);
  }

  appendInvoicingAudit(entry: InvoicingAuditEntry): void {
    this.state.audits.push(structuredClone(entry));
  }

  getInvoiceSettings(): InvoiceSettings | null {
    return structuredClone(this.state.settings);
  }

  upsertInvoiceSettings(row: InvoiceSettings): void {
    this.state.settings = structuredClone(row);
  }

  maxInvoiceSeq(): number | null {
    return this.state.invoices.length === 0
      ? null
      : Math.max(...this.state.invoices.map((i) => i.seq));
  }

  listBillingTerms(): BillingTerms[] {
    return structuredClone(
      [...this.state.billingTerms].sort((a, b) => a.partnerId.localeCompare(b.partnerId)),
    );
  }

  getBillingTerms(partnerId: string): BillingTerms | null {
    const found = this.state.billingTerms.find((t) => t.partnerId === partnerId);
    return found === undefined ? null : structuredClone(found);
  }

  upsertBillingTerms(row: BillingTerms): void {
    this.state.billingTerms = [
      ...this.state.billingTerms.filter((t) => t.partnerId !== row.partnerId),
      structuredClone(row),
    ];
  }

  deleteBillingTerms(partnerId: string): void {
    this.state.billingTerms = this.state.billingTerms.filter((t) => t.partnerId !== partnerId);
  }

  listWorkHours(targetMonth: string): WorkHoursRow[] {
    return structuredClone(
      this.state.workHours
        .filter((w) => w.targetMonth === targetMonth)
        .sort((a, b) => a.partnerId.localeCompare(b.partnerId)),
    );
  }

  getWorkHours(partnerId: string, targetMonth: string): WorkHoursRow | null {
    const found = this.state.workHours.find(
      (w) => w.partnerId === partnerId && w.targetMonth === targetMonth,
    );
    return found === undefined ? null : structuredClone(found);
  }

  upsertWorkHours(row: WorkHoursRow): void {
    this.state.workHours = [
      ...this.state.workHours.filter(
        (w) => !(w.partnerId === row.partnerId && w.targetMonth === row.targetMonth),
      ),
      structuredClone(row),
    ];
  }

  insertInvoice(invoice: InvoiceRecord): void {
    const dup = this.state.invoices.some(
      (i) => i.id === invoice.id || i.seq === invoice.seq || i.invoiceNo === invoice.invoiceNo,
    );
    if (dup) throw new Error("UNIQUE constraint failed: invoices");
    this.state.invoices.push(structuredClone(invoice));
  }

  insertInvoiceItems(items: InvoiceItemRecord[]): void {
    this.state.items.push(...structuredClone(items));
  }

  getInvoice(id: string): InvoiceRecord | null {
    const found = this.state.invoices.find((i) => i.id === id);
    return found === undefined ? null : structuredClone(found);
  }

  listInvoiceItems(invoiceId: string): InvoiceItemRecord[] {
    return structuredClone(
      this.state.items.filter((i) => i.invoiceId === invoiceId).sort((a, b) => a.lineNo - b.lineNo),
    );
  }

  listInvoices(query: {
    partnerId?: string | undefined;
    month?: string | undefined;
  }): InvoiceRecord[] {
    return structuredClone(
      this.state.invoices
        .filter(
          (i) =>
            (query.partnerId === undefined || i.partnerId === query.partnerId) &&
            (query.month === undefined || i.targetMonth === query.month),
        )
        .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.seq - a.seq),
    );
  }

  listActiveInvoices(partnerId: string, targetMonth: string): InvoiceRecord[] {
    return structuredClone(
      this.state.invoices
        .filter(
          (i) => i.partnerId === partnerId && i.targetMonth === targetMonth && i.voidedAt === null,
        )
        .sort((a, b) => a.seq - b.seq),
    );
  }

  markInvoiceVoided(
    id: string,
    voided: { voidedAt: string; voidReason: string; voidJournalId: string | null },
  ): void {
    const found = this.state.invoices.find((i) => i.id === id);
    if (found === undefined) throw new Error(`請求書がない: ${id}`);
    if (found.voidedAt !== null) throw new Error("取消済みの請求書は更新できません");
    found.voidedAt = voided.voidedAt;
    found.voidReason = voided.voidReason;
    found.voidJournalId = voided.voidJournalId;
  }

  listPayments(invoiceId: string): PaymentRecord[] {
    return structuredClone(this.state.payments.filter((p) => p.invoiceId === invoiceId));
  }

  insertPayment(payment: PaymentRecord): void {
    const dup = this.state.payments.some(
      (p) => p.id === payment.id || p.journalId === payment.journalId,
    );
    if (dup) throw new Error("UNIQUE constraint failed: invoice_payments");
    this.state.payments.push(structuredClone(payment));
  }

  markPaymentVoided(
    id: string,
    voided: { voidedAt: string; voidReason: string; voidJournalId: string | null },
  ): void {
    const found = this.state.payments.find((p) => p.id === id);
    if (found === undefined) throw new Error(`消し込みがない: ${id}`);
    if (found.voidedAt !== null) throw new Error("取消済みの消し込みは更新できません");
    found.voidedAt = voided.voidedAt;
    found.voidReason = voided.voidReason;
    found.voidJournalId = voided.voidJournalId;
  }

  originOfJournal(journalId: string): JournalOrigin | null {
    const invoice = this.state.invoices.find(
      (i) => i.journalId === journalId || i.voidJournalId === journalId,
    );
    if (invoice !== undefined) {
      return { kind: "invoice", invoiceId: invoice.id, invoiceNo: invoice.invoiceNo };
    }
    const payment = this.state.payments.find(
      (p) => p.journalId === journalId || p.voidJournalId === journalId,
    );
    if (payment !== undefined) {
      const owner = this.state.invoices.find((i) => i.id === payment.invoiceId);
      if (owner !== undefined) {
        return {
          kind: "payment",
          invoiceId: owner.id,
          invoiceNo: owner.invoiceNo,
          paymentId: payment.id,
        };
      }
    }
    const origin = this.state.origins[journalId];
    return origin === undefined ? null : structuredClone(origin);
  }
}

/** InvoicingUnitOfWork のフェイク（R9） */
export const fakeInvoicingUnitOfWork = (
  ledger = new InMemoryLedgerRepository(),
  masters = new InMemoryMasterRepository(),
  invoicing = new InMemoryInvoicingStore(),
) => fakeUnitOfWork(ledger, masters, { invoicing });
export type FakeInvoicingUnitOfWork = ReturnType<typeof fakeInvoicingUnitOfWork>;
