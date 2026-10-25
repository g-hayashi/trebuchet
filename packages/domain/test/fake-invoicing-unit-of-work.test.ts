import { describe, expect, it } from "vitest";
import { RollbackError, runInTransaction } from "../src/invoicing/rollback.ts";
import type { NewJournal } from "../src/ports.ts";
import { domainError, err, type InvoicingAuditEntry, ok } from "../src/types.ts";
import { FakeInvoicingUnitOfWork, FakeRecurringUnitOfWork } from "./fakes.ts";

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

describe("FakeInvoicingUnitOfWork", () => {
  it("途中の例外で仕訳・マスタ・記録・参照がすべて残らない（R9）", () => {
    const uow = new FakeInvoicingUnitOfWork();
    expect(() =>
      uow.transaction(({ ledger, masters, invoicing }) => {
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

  it("err を返したときは drizzle と同じく確定する（巻き戻らない）", () => {
    const uow = new FakeInvoicingUnitOfWork();
    const r = uow.transaction(({ ledger, invoicing }) => {
      ledger.insertJournal(journal("j-1", 1));
      invoicing.appendInvoicingAudit(audit("audit-1"));
      return err(domainError("VALIDATION", "検査の失敗"));
    });
    expect(r.ok).toBe(false);
    expect(uow.ledger.journals.map((j) => j.id)).toEqual(["j-1"]);
    expect(uow.invoicing.audits.map((a) => a.id)).toEqual(["audit-1"]);
  });

  it("originOfJournal は登録した起点を返し、ない仕訳は null", () => {
    const uow = new FakeInvoicingUnitOfWork();
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

  it("runInTransaction は RollbackError を巻き戻して err に直し、ほかの例外は投げ直す", () => {
    const uow = new FakeInvoicingUnitOfWork();
    const rolled = runInTransaction(uow, ({ ledger, invoicing }) => {
      ledger.insertJournal(journal("j-1", 1));
      invoicing.appendInvoicingAudit(audit("audit-1"));
      throw new RollbackError(domainError("VALIDATION", "中止", { field: "x" }));
    });
    expect(rolled).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "中止", details: { field: "x" } },
    });
    expect(uow.ledger.journals).toEqual([]);
    expect(uow.invoicing.audits).toEqual([]);

    expect(() =>
      runInTransaction(uow, ({ ledger }) => {
        ledger.insertJournal(journal("j-2", 1));
        throw new Error("想定外");
      }),
    ).toThrow("想定外");
    expect(uow.ledger.journals).toEqual([]);

    const committed = runInTransaction(uow, ({ ledger }) => {
      ledger.insertJournal(journal("j-3", 1));
      return ok("done");
    });
    expect(committed).toEqual({ ok: true, value: "done" });
    expect(uow.ledger.journals.map((j) => j.id)).toEqual(["j-3"]);
  });
});

describe("FakeRecurringUnitOfWork", () => {
  it("途中の例外で仕訳・記録が残らず、err を返すと確定する", () => {
    const uow = new FakeRecurringUnitOfWork();
    expect(() =>
      uow.transaction(({ ledger, recurring }) => {
        ledger.insertJournal({ ...journal("j-1", 1), source: "recurring" });
        recurring.appendRecurringAudit({ ...audit("audit-1"), targetType: "recurring_run" });
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(uow.ledger.journals).toEqual([]);
    expect(uow.recurring.audits).toEqual([]);

    uow.transaction(({ ledger, recurring }) => {
      ledger.insertJournal({ ...journal("j-1", 1), source: "recurring" });
      recurring.appendRecurringAudit(audit("audit-2"));
      return err(domainError("VALIDATION", "x"));
    });
    expect(uow.ledger.journals).toHaveLength(1);
    expect(uow.recurring.audits.map((a) => a.id)).toEqual(["audit-2"]);
  });
});
