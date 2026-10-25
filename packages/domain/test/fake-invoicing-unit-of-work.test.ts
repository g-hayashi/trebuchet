import { describe, expect, it } from "vitest";
import type { NewJournal } from "../src/ports.ts";
import { domainError, err, type InvoicingAuditEntry, ok } from "../src/types.ts";
import { fakeInvoicingUnitOfWork, fakeRecurringUnitOfWork } from "./fakes.ts";

const AT = "2026-10-24T00:00:00.000Z";

const journal = (id: string, journalNo: number): NewJournal => ({
  id,
  journalNo,
  date: "2026-10-31",
  fiscalPeriodId: "period-2026",
  memo: null,
  correctsJournalId: null,
  source: "invoice",
  createdAt: AT,
  lines: [
    {
      id: `${id}-1`,
      lineNo: 1,
      side: "debit",
      accountId: "a",
      subAccountId: null,
      amount: 100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
    {
      id: `${id}-2`,
      lineNo: 2,
      side: "credit",
      accountId: "b",
      subAccountId: null,
      amount: 100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
  ],
});

const audit = (id: string): InvoicingAuditEntry => ({
  id,
  occurredAt: AT,
  targetType: "invoice",
  targetId: "inv-1",
  action: "create",
  reason: null,
  beforeJson: null,
  afterJson: "{}",
});

describe("fakeInvoicingUnitOfWork", () => {
  it("途中の例外で仕訳・マスタ・記録・参照がすべて残らない（R9）", () => {
    const uow = fakeInvoicingUnitOfWork();
    expect(() =>
      uow.run(({ ledger, masters, invoicing }) => {
        masters.insertTag({ id: "tag-1", name: "出張" });
        ledger.insertJournal(journal("j-1", 1));
        invoicing.appendInvoicingAudit(audit("audit-1"));
        uow.invoicing.registerOrigin("j-1", {
          kind: "invoice",
          invoiceId: "inv-1",
          invoiceNo: "2026-1031-001",
        });
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(uow.ledger.journals).toEqual([]);
    expect(uow.masters.listTags()).toEqual([]);
    expect(uow.invoicing.audits).toEqual([]);
    expect(uow.invoicing.originOfJournal("j-1")).toBeNull();
  });

  it("書き込みの後に err を返すと全部が巻き戻り、同じ err を返す（db の実装と同じ）", () => {
    const uow = fakeInvoicingUnitOfWork();
    const failure = domainError("VALIDATION", "中止", { field: "x" });
    const r = uow.run(({ ledger, invoicing }) => {
      ledger.insertJournal(journal("j-1", 1));
      invoicing.appendInvoicingAudit(audit("audit-1"));
      return err(failure);
    });
    expect(r).toEqual(err(failure));
    expect(uow.ledger.journals).toEqual([]);
    expect(uow.invoicing.audits).toEqual([]);

    const committed = uow.run(({ ledger }) => {
      ledger.insertJournal(journal("j-3", 1));
      return ok("done");
    });
    expect(committed).toEqual({ ok: true, value: "done" });
    expect(uow.ledger.journals.map((j) => j.id)).toEqual(["j-3"]);
  });

  it("originOfJournal は登録した起点を返し、ない仕訳は null", () => {
    const uow = fakeInvoicingUnitOfWork();
    uow.invoicing.registerOrigin("j-1", {
      kind: "payment",
      invoiceId: "inv-1",
      invoiceNo: "2026-1031-001",
      paymentId: "pay-1",
    });
    expect(uow.invoicing.originOfJournal("j-1")).toEqual({
      kind: "payment",
      invoiceId: "inv-1",
      invoiceNo: "2026-1031-001",
      paymentId: "pay-1",
    });
    expect(uow.invoicing.originOfJournal("j-2")).toBeNull();
  });
});

describe("fakeRecurringUnitOfWork", () => {
  it("途中の例外でも err でも仕訳・記録が残らず、ok なら確定する", () => {
    const uow = fakeRecurringUnitOfWork();
    expect(() =>
      uow.run(({ ledger, recurring }) => {
        ledger.insertJournal({ ...journal("j-1", 1), source: "recurring" });
        recurring.appendRecurringAudit({ ...audit("audit-1"), targetType: "recurring_run" });
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(uow.ledger.journals).toEqual([]);
    expect(uow.recurring.audits).toEqual([]);

    const failed = uow.run(({ ledger, recurring }) => {
      ledger.insertJournal({ ...journal("j-1", 1), source: "recurring" });
      recurring.appendRecurringAudit(audit("audit-2"));
      return err(domainError("VALIDATION", "x"));
    });
    expect(failed.ok).toBe(false);
    expect(uow.ledger.journals).toEqual([]);
    expect(uow.recurring.audits).toEqual([]);

    uow.run(({ ledger, recurring }) => {
      ledger.insertJournal({ ...journal("j-1", 1), source: "recurring" });
      recurring.appendRecurringAudit(audit("audit-3"));
      return ok(null);
    });
    expect(uow.ledger.journals).toHaveLength(1);
    expect(uow.recurring.audits.map((a) => a.id)).toEqual(["audit-3"]);
  });
});
