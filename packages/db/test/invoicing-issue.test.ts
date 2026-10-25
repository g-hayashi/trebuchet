import { getInvoiceDetail, getJournalOrigin, issueInvoice, voidInvoice } from "@trebuchet/domain";
import type { InvoiceInput } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempDataDir, TODAY, useTempDataDir } from "../src/testing.ts";
import { setupInvoicingDb } from "./invoicing-db-setup.ts";

// 005 US1: 発行の実 DB での往復と、障害の注入（INV-32）。
// トリガー・CHECK・UNIQUE の個別の検査は invoicing-schema.test.ts（T002）

let tmp: TempDataDir;
let t: ReturnType<typeof setupInvoicingDb>;
let partnerId: string;

beforeEach(() => {
  tmp = useTempDataDir("invoicing-issue");
  t = setupInvoicingDb({ taxable: true });
  t.setSettings({ nextSeq: 43, tradeName: "山田設計" });
  const partner = t.addPartner("株式会社A", { honorific: "御中" });
  partnerId = partner.id;
  t.setTerms(partnerId);
});
afterEach(() => tmp.cleanup());

const input = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  partnerId,
  targetMonth: "2026-10",
  items: [
    {
      name: "10月分 業務委託",
      quantity: 120.5,
      unit: "時間",
      unitPrice: 10_000,
      amount: 1_205_000,
    },
    { name: "教材", amount: 5_400, taxCategory: "SALES_8R" },
  ],
  ...over,
});

const nextSeq = () => t.store.getInvoiceSettings()?.nextSeq;

describe("issueInvoice（実 DB）", () => {
  it("請求書・明細・売上の仕訳・次の通し番号が 1 組で保存され、読み戻せる", () => {
    const r = issueInvoice(t.deps, input(), TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { invoice, journal } = r.value;

    expect(invoice).toMatchObject({
      invoiceNo: "20261031-043",
      total: 1_210_400,
      taxDisplay: "separate",
      status: "unpaid",
      remaining: 1_210_400,
      recipientName: "株式会社A",
    });
    expect(invoice.issuer.tradeName).toBe("山田設計");
    expect(nextSeq()).toBe(44);
    expect(t.count("invoices")).toBe(1);
    expect(t.count("invoice_items")).toBe(2);
    expect(t.count("invoicing_audit_log")).toBe(1);

    // 詳細は DB から同じものが読み戻せる
    expect(getInvoiceDetail(t.deps, invoice.id, TODAY)).toEqual({ ok: true, value: invoice });
    expect(invoice.taxBreakdown).toEqual([
      { rate: 10, inclusive: 1_205_000, tax: 109_545, exclusive: 1_095_455 },
      { rate: 8, inclusive: 5_400, tax: 400, exclusive: 5_000 },
    ]);

    // 売上の仕訳: 借方 売掛金 1 行、貸方 売上高 2 行（税区分ごと）。税額は 001 の検証が求める
    const saved = t.ledger.getJournal(journal.id);
    expect(saved?.source).toBe("invoice");
    expect(saved?.lines.map((l) => [l.side, l.taxCategory, l.amount, l.taxAmount])).toEqual([
      ["debit", "OUT_OF_SCOPE", 1_210_400, 0],
      ["credit", "SALES_10", 1_205_000, 109_545],
      ["credit", "SALES_8R", 5_400, 400],
    ]);
    expect(getJournalOrigin(t.deps, journal.id)).toEqual({
      ok: true,
      value: { kind: "invoice", invoiceId: invoice.id, invoiceNo: "20261031-043" },
    });
  });

  it("続けて発行すると番号が進む。重複の対象月は confirmDuplicate が要る", () => {
    expect(issueInvoice(t.deps, input(), TODAY).ok).toBe(true);
    const dup = issueInvoice(t.deps, input(), TODAY);
    expect(!dup.ok && dup.error.code).toBe("INVOICE_DUPLICATE_MONTH");
    expect(nextSeq()).toBe(44);
    const second = issueInvoice(t.deps, input({ confirmDuplicate: true }), TODAY);
    expect(second.ok && second.value.invoice.invoiceNo).toBe("20261031-044");
    expect(t.store.maxInvoiceSeq()).toBe(44);
  });

  it("仕訳の検査で失敗（締め済み）しても、仕訳・請求書・番号は何も残らない", () => {
    t.db.$client.prepare("UPDATE fiscal_periods SET status = 'closed', closed_at = ?").run("x");
    const r = issueInvoice(t.deps, input(), TODAY);
    expect(!r.ok && r.error.code).toBe("PERIOD_CLOSED");
    expect(t.count("journals")).toBe(0);
    expect(t.count("invoices")).toBe(0);
    expect(nextSeq()).toBe(43);
  });

  const failures: [string, string][] = [
    ["明細の挿入", "invoice_items"],
    ["請求書の記録（監査）", "invoicing_audit_log"],
    ["請求書の挿入", "invoices"],
  ];
  for (const [label, table] of failures) {
    it(`${label}に失敗させると、仕訳も番号も請求書も残らない（INV-32）`, () => {
      t.db.$client.exec(
        `CREATE TEMP TRIGGER fail_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      );
      expect(() => issueInvoice(t.deps, input(), TODAY)).toThrow(/injected/);
      expect(t.count("journals")).toBe(0);
      expect(t.count("journal_lines")).toBe(0);
      expect(t.count("audit_log")).toBe(0);
      expect(t.count("invoices")).toBe(0);
      expect(t.count("invoice_items")).toBe(0);
      expect(t.count("invoicing_audit_log")).toBe(0);
      expect(nextSeq()).toBe(43);

      // 障害が直れば同じ番号で発行できる
      t.db.$client.exec(`DROP TRIGGER fail_${table}`);
      const again = issueInvoice(t.deps, input(), TODAY);
      expect(again.ok && again.value.invoice.invoiceNo).toBe("20261031-043");
    });
  }

  it("取消: 請求書の取消の列の更新に失敗させると、仕訳の取消も残らない（INV-32）", () => {
    const issued = issueInvoice(t.deps, input(), TODAY);
    if (!issued.ok) throw new Error("expected ok");
    const { invoice, journal } = issued.value;
    t.db.$client.exec(
      "CREATE TEMP TRIGGER fail_void BEFORE UPDATE ON invoices BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => voidInvoice(t.deps, invoice.id, { reason: "誤り" }, TODAY)).toThrow(/injected/);
    expect(t.ledger.getJournal(journal.id)?.status).toBe("active");
    expect(t.store.getInvoice(invoice.id)?.voidedAt).toBeNull();

    t.db.$client.exec("DROP TRIGGER fail_void");
    const ok = voidInvoice(t.deps, invoice.id, { reason: "誤り" }, TODAY);
    expect(ok.ok && ok.value.invoice).toMatchObject({ status: "voided", voidJournalId: null });
    expect(t.ledger.getJournal(journal.id)?.status).toBe("voided");
    expect(t.store.getInvoice(invoice.id)).toMatchObject({ voidReason: "誤り" });
    // 取消済みの請求書はトリガーが再度の更新を止める（番号も使い切り）
    expect(t.store.maxInvoiceSeq()).toBe(43);
    expect(nextSeq()).toBe(44);
  });

  it("通し番号の更新に失敗させても、仕訳は残らない", () => {
    t.db.$client.exec(
      "CREATE TEMP TRIGGER fail_settings BEFORE UPDATE ON invoice_settings BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => issueInvoice(t.deps, input(), TODAY)).toThrow(/injected/);
    expect(t.count("journals")).toBe(0);
    expect(t.count("invoices")).toBe(0);
    expect(nextSeq()).toBe(43);
  });
});
