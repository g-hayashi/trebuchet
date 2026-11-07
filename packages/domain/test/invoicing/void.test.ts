import type { InvoiceInput } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { reversalDraft } from "../../src/invoicing/journal-drafts.ts";
import type { Journal } from "../../src/types.ts";
import { issueInvoice, voidInvoice } from "../../src/usecases/invoicing.ts";
import { setupInvoicing } from "../invoicing-setup.ts";
import { TODAY } from "../test-dates.ts";

// 005 US1: 請求書の取消（R12、§3、FR-014、H:§3.7）

function ready() {
  const t = setupInvoicing({ taxable: true });
  t.setSettings({ nextSeq: 43 });
  const partner = t.addPartner({ name: "株式会社A", honorific: "様" });
  t.setTerms(partner.id);
  const input = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
    partnerId: partner.id,
    targetMonth: "2026-10",
    confirmDuplicate: true,
    items: [
      { name: "開発", amount: 110_000, taxCategory: "SALES_10" },
      { name: "教材", amount: 55_000, taxCategory: "SALES_8R" },
    ],
    ...over,
  });
  const issue = (over: Partial<InvoiceInput> = {}) => {
    const r = issueInvoice(t.deps, input(over), TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };
  return { ...t, partner, input, issue };
}

describe("voidInvoice（年度が未締め。US1 Acceptance 7）", () => {
  it("請求書は取消になり（消えない）、元の仕訳が取り消される。番号は再利用されない", () => {
    const t = ready();
    const issued = t.issue();
    const r = voidInvoice(t.deps, issued.invoice.id, { reason: " 二重発行 " }, TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(r.value.invoice).toMatchObject({
      id: issued.invoice.id,
      status: "voided",
      remaining: 0,
      voidReason: "二重発行",
      voidJournalId: null,
      journalId: issued.journal.id,
    });
    expect(r.value.invoice.voidedAt).toBe(t.clock.now());
    // 返す仕訳は取り消した元の仕訳
    expect(r.value.journal).toMatchObject({ id: issued.journal.id, status: "voided" });
    expect(t.ledger.getJournal(issued.journal.id)?.status).toBe("voided");
    expect(t.ledger.journals).toHaveLength(1);

    expect(t.invoicing.getInvoice(issued.invoice.id)).toMatchObject({
      voidedAt: t.clock.now(),
      voidReason: "二重発行",
      voidJournalId: null,
    });
    // 行は消えず、明細も残る
    expect(t.invoicing.listInvoiceItems(issued.invoice.id)).toHaveLength(2);
    expect(t.invoicing.audits.at(-1)).toMatchObject({
      targetType: "invoice",
      targetId: issued.invoice.id,
      action: "void",
      reason: "二重発行",
    });

    // 取り消した番号は再利用されず、取り直しは新しい番号で発行する
    const again = t.issue();
    expect(again.invoice.invoiceNo).toBe("20261031-044");
    expect(t.invoicing.state.settings?.nextSeq).toBe(45);
  });
});

describe("voidInvoice（計上日が締め済みの年度。US1 Acceptance 8）", () => {
  it("今日付の逆仕訳（訂正仕訳）を起票し、元の仕訳は変わらない", () => {
    const t = ready();
    const issued = t.issue({ targetMonth: "2025-12", issueDate: "2025-12-28" });
    const original = t.ledger.getJournal(issued.journal.id) as Journal;
    t.closeYear(2025);

    const r = voidInvoice(t.deps, issued.invoice.id, { reason: "取り直し" }, TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const reversal = r.value.journal;

    expect(reversal).toMatchObject({
      date: TODAY,
      source: "invoice",
      correctsJournalId: original.id,
      status: "active",
    });
    expect(reversal.id).not.toBe(original.id);
    // 貸借を逆にし、税区分・取引先は元の行の値
    const key = (l: Journal["lines"][number]) =>
      [l.side, l.accountId, l.amount, l.taxCategory, l.taxAmount, l.partnerId].join("|");
    const flipped = original.lines.map((l) => ({
      ...l,
      side: l.side === "debit" ? ("credit" as const) : ("debit" as const),
    }));
    expect(reversal.lines.map(key).sort()).toEqual(flipped.map(key).sort());

    expect(r.value.invoice).toMatchObject({
      status: "voided",
      voidJournalId: reversal.id,
      journalId: original.id,
    });
    // 元の仕訳は変わらない（有効のまま・版も同じ）
    expect(t.ledger.getJournal(original.id)).toEqual(original);
    expect(t.invoicing.getInvoice(issued.invoice.id)?.voidJournalId).toBe(reversal.id);
  });

  it("今日の期間もなければ 001 のエラー（OUT_OF_PERIOD / PERIOD_CLOSED）で、何も変わらない", () => {
    const t = ready();
    const issued = t.issue({ targetMonth: "2025-12", issueDate: "2025-12-28" });
    t.closeYear(2025);

    const noPeriod = voidInvoice(t.deps, issued.invoice.id, { reason: "x" }, "2030-01-05");
    expect(!noPeriod.ok && noPeriod.error.code).toBe("OUT_OF_PERIOD");
    t.closeYear(2026);
    const closedToday = voidInvoice(t.deps, issued.invoice.id, { reason: "x" }, TODAY);
    expect(!closedToday.ok && closedToday.error.code).toBe("PERIOD_CLOSED");

    expect(t.invoicing.getInvoice(issued.invoice.id)?.voidedAt).toBeNull();
    expect(t.ledger.journals).toHaveLength(1);
  });
});

describe("voidInvoice（検査）", () => {
  it("理由が空なら REASON_REQUIRED、請求書がなければ INVOICE_NOT_FOUND、取消済みなら INVOICE_VOIDED", () => {
    const t = ready();
    const issued = t.issue();
    const blank = voidInvoice(t.deps, issued.invoice.id, { reason: "  " }, TODAY);
    expect(!blank.ok && blank.error.code).toBe("REASON_REQUIRED");
    const missing = voidInvoice(t.deps, "nope", { reason: "x" }, TODAY);
    expect(!missing.ok && missing.error.code).toBe("INVOICE_NOT_FOUND");

    expect(voidInvoice(t.deps, issued.invoice.id, { reason: "x" }, TODAY).ok).toBe(true);
    const twice = voidInvoice(t.deps, issued.invoice.id, { reason: "y" }, TODAY);
    expect(!twice.ok && twice.error.code).toBe("INVOICE_VOIDED");
    expect(!twice.ok && twice.error.details).toMatchObject({ invoiceId: issued.invoice.id });
  });

  it("取消でない消し込みがあれば INVOICE_HAS_PAYMENTS（取消済みの消し込みは数えない）", () => {
    const t = ready();
    const issued = t.issue();
    const payment = (id: string, voidedAt: string | null) => ({
      id,
      invoiceId: issued.invoice.id,
      receivedOn: "2026-11-10",
      amount: 1_000,
      feeAmount: 0,
      withholdingAmount: 0,
      depositAccountId: t.accountId("普通預金"),
      depositSubAccountId: null,
      journalId: `j-${id}`,
      createdAt: "2026-11-10T00:00:00.000Z",
      voidedAt,
      voidReason: voidedAt === null ? null : "誤り",
      voidJournalId: null,
    });
    t.invoicing.state.payments.push(
      payment("pay-live", null),
      payment("pay-gone", "2026-11-11T00:00:00.000Z"),
    );

    const blocked = voidInvoice(t.deps, issued.invoice.id, { reason: "x" }, TODAY);
    expect(!blocked.ok && blocked.error.code).toBe("INVOICE_HAS_PAYMENTS");
    expect(!blocked.ok && blocked.error.details).toMatchObject({ paymentIds: ["pay-live"] });
    expect(t.invoicing.getInvoice(issued.invoice.id)?.voidedAt).toBeNull();
    expect(t.ledger.getJournal(issued.journal.id)?.status).toBe("active");

    // 消し込みを取り消した後は通る
    const live = t.invoicing.state.payments.find((p) => p.id === "pay-live");
    if (live) live.voidedAt = "2026-11-12T00:00:00.000Z";
    expect(voidInvoice(t.deps, issued.invoice.id, { reason: "x" }, TODAY).ok).toBe(true);
  });

  it("取消後は 001 の取消で取り消した仕訳を再び触れない（JOURNAL_VOIDED）", () => {
    const t = ready();
    const issued = t.issue();
    voidInvoice(t.deps, issued.invoice.id, { reason: "x" }, TODAY);
    expect(t.ledger.getJournal(issued.journal.id)?.status).toBe("voided");
  });
});

describe("reversalDraft", () => {
  const original: Journal = {
    id: "j-1",
    journalNo: 7,
    date: "2025-12-31",
    fiscalPeriodId: "p",
    memo: "請求書 20251228-001",
    status: "active",
    correctsJournalId: null,
    source: "invoice",
    version: 1,
    createdAt: "2025-12-28T00:00:00.000Z",
    updatedAt: "2025-12-28T00:00:00.000Z",
    lines: [
      {
        id: "l-1",
        lineNo: 1,
        side: "debit",
        accountId: "ar",
        subAccountId: "sub-1",
        amount: 110_000,
        taxCategory: "OUT_OF_SCOPE",
        taxAmount: 0,
        partnerId: "partner-1",
        description: "売掛",
        tagIds: ["tag-1"],
      },
      {
        id: "l-2",
        lineNo: 2,
        side: "credit",
        accountId: "sales",
        subAccountId: null,
        amount: 110_000,
        taxCategory: "SALES_10",
        taxAmount: 10_000,
        partnerId: "partner-1",
        description: null,
        tagIds: [],
      },
    ],
  };

  it("貸借を逆にし、日付は今日、訂正元は元の仕訳。税区分・取引先・補助科目・摘要・タグは元の行の値", () => {
    const draft = reversalDraft(original, "2026-10-31");
    expect(draft).toEqual({
      date: "2026-10-31",
      memo: "取消: 請求書 20251228-001",
      correctsJournalId: "j-1",
      lines: [
        {
          side: "credit",
          accountId: "ar",
          subAccountId: "sub-1",
          amount: 110_000,
          taxCategory: "OUT_OF_SCOPE",
          partnerId: "partner-1",
          description: "売掛",
          tagIds: ["tag-1"],
        },
        {
          side: "debit",
          accountId: "sales",
          amount: 110_000,
          taxCategory: "SALES_10",
          partnerId: "partner-1",
          tagIds: [],
        },
      ],
    });
  });

  it("摘要がない仕訳は仕訳番号で示す", () => {
    expect(reversalDraft({ ...original, memo: null }, "2026-10-31").memo).toBe("仕訳 No.7 の取消");
  });
});
