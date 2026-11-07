import {
  createNextFiscalPeriod,
  getInvoiceDetail,
  getJournalOrigin,
  issueInvoice,
  recordPayment,
  voidInvoice,
  voidPayment,
  withholdingSummary,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempDataDir, TODAY, useTempDataDir } from "../src/testing.ts";
import { setupInvoicingDb } from "./invoicing-db-setup.ts";

// 005 US2: 消し込みの実 DB での往復と、障害の注入（INV-32）。
// トリガー・CHECK・UNIQUE の個別の検査は invoicing-schema.test.ts（T002）

let tmp: TempDataDir;
let t: ReturnType<typeof setupInvoicingDb>;
let invoiceId: string;

beforeEach(() => {
  tmp = useTempDataDir("invoicing-payments");
  t = setupInvoicingDb({ taxable: true });
  t.setSettings({ nextSeq: 1 });
  const partner = t.addPartner("株式会社A", { honorific: "御中" });
  t.setTerms(partner.id);
  const issued = issueInvoice(
    t.deps,
    {
      partnerId: partner.id,
      targetMonth: "2026-10",
      items: [{ name: "開発", amount: 1_205_000, taxCategory: "SALES_10" }],
    },
    TODAY,
  );
  if (!issued.ok) throw new Error(JSON.stringify(issued.error));
  invoiceId = issued.value.invoice.id;
});
afterEach(() => tmp.cleanup());

const pay = (over: Partial<Parameters<typeof recordPayment>[2]> = {}, today = TODAY) =>
  recordPayment(
    t.deps,
    invoiceId,
    {
      receivedOn: "2026-11-10",
      amount: 1_204_340,
      depositAccountId: t.accountId("普通預金"),
      treatDifferenceAsFee: true,
      ...over,
    },
    today,
  );

const failOn = (name: string, event: string, table: string) =>
  t.db.$client.exec(
    `CREATE TEMP TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END`,
  );

describe("recordPayment（実 DB）", () => {
  it("消し込み・複合仕訳・記録が 1 組で保存され、詳細から読み戻せる", () => {
    const r = pay();
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { payment, journal, invoice } = r.value;

    expect(invoice).toMatchObject({ status: "paid", remaining: 0, paid: 1_205_000 });
    expect(payment).toMatchObject({ amount: 1_204_340, feeAmount: 660, voidedAt: null });
    expect(t.count("invoice_payments")).toBe(1);
    expect(t.store.listPayments(invoiceId).map((p) => p.id)).toEqual([payment.id]);
    expect(getInvoiceDetail(t.deps, invoiceId, TODAY)).toMatchObject({
      ok: true,
      value: { status: "paid", payments: [payment] },
    });
    const saved = t.ledger.getJournal(journal.id);
    expect(saved?.source).toBe("payment");
    expect(saved?.lines.map((l) => [l.side, l.amount])).toEqual([
      ["debit", 1_204_340],
      ["debit", 660],
      ["credit", 1_205_000],
    ]);
    expect(getJournalOrigin(t.deps, journal.id)).toEqual({
      ok: true,
      value: {
        kind: "payment",
        invoiceId,
        invoiceNo: "20261031-001",
        paymentId: payment.id,
      },
    });
  });

  it("超過・取消済みの請求書は検査のエラーで、何も残らない", () => {
    const over = pay({ amount: 1_205_001, treatDifferenceAsFee: false });
    expect(!over.ok && over.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
    expect(t.count("invoice_payments")).toBe(0);
    expect(t.count("journals")).toBe(1);

    expect(voidInvoice(t.deps, invoiceId, { reason: "誤り" }, TODAY).ok).toBe(true);
    const voided = pay();
    expect(!voided.ok && voided.error.code).toBe("INVOICE_VOIDED");
    expect(t.count("invoice_payments")).toBe(0);
  });

  const failures: [string, string][] = [
    ["消し込みの挿入", "invoice_payments"],
    ["消し込みの記録（監査）", "invoicing_audit_log"],
  ];
  for (const [label, table] of failures) {
    it(`${label}に失敗させると、入金の仕訳も消し込みも残らない（INV-32）`, () => {
      const journals = t.count("journals");
      const audits = t.count("audit_log");
      const invoicingAudits = t.count("invoicing_audit_log");
      failOn(`fail_${table}`, "INSERT", table);
      expect(() => pay()).toThrow(/injected/);
      expect(t.count("journals")).toBe(journals);
      expect(t.count("journal_lines")).toBe(2); // 売上の仕訳の 2 行だけ
      expect(t.count("audit_log")).toBe(audits);
      expect(t.count("invoice_payments")).toBe(0);
      expect(t.count("invoicing_audit_log")).toBe(invoicingAudits);
      expect(t.store.listPayments(invoiceId)).toEqual([]);

      // 障害が直れば、同じ内容で消し込める
      t.db.$client.exec(`DROP TRIGGER fail_${table}`);
      expect(pay().ok).toBe(true);
    });
  }
});

describe("voidPayment（実 DB）", () => {
  it("未締め: 消し込みの取消の列の更新に失敗させると、仕訳の取消も残らない（INV-32）", () => {
    const paid = pay();
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    const { payment, journal } = paid.value;
    failOn("fail_void", "UPDATE", "invoice_payments");
    expect(() => voidPayment(t.deps, invoiceId, payment.id, { reason: "誤り" }, TODAY)).toThrow(
      /injected/,
    );
    expect(t.ledger.getJournal(journal.id)?.status).toBe("active");
    expect(t.store.listPayments(invoiceId)[0]?.voidedAt).toBeNull();

    t.db.$client.exec("DROP TRIGGER fail_void");
    const r = voidPayment(t.deps, invoiceId, payment.id, { reason: "誤り" }, TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.invoice).toMatchObject({ status: "unpaid", remaining: 1_205_000 });
    expect(r.value.payment).toMatchObject({ voidReason: "誤り", voidJournalId: null });
    expect(t.ledger.getJournal(journal.id)?.status).toBe("voided");
    // 消し込みの行は消えず、取消済みは再び取り消せない
    expect(t.count("invoice_payments")).toBe(1);
    const again = voidPayment(t.deps, invoiceId, payment.id, { reason: "x" }, TODAY);
    expect(!again.ok && again.error.code).toBe("PAYMENT_VOIDED");
  });

  it("締め済み: 訂正仕訳の起票の後の更新に失敗させると、訂正仕訳も残らない。通れば元の仕訳は変わらない", () => {
    const paid = pay();
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    const { payment, journal } = paid.value;
    const next = createNextFiscalPeriod({ repo: t.masters, ids: t.ids, clock: t.clock });
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    t.db.$client
      .prepare(
        "UPDATE fiscal_periods SET status = 'closed', closed_at = ? WHERE fiscal_year = 2026",
      )
      .run("x");
    const journals = t.count("journals");
    const original = t.ledger.getJournal(journal.id);

    failOn("fail_void", "UPDATE", "invoice_payments");
    expect(() =>
      voidPayment(t.deps, invoiceId, payment.id, { reason: "誤り" }, "2027-01-05"),
    ).toThrow(/injected/);
    expect(t.count("journals")).toBe(journals);
    expect(t.store.listPayments(invoiceId)[0]?.voidJournalId).toBeNull();

    t.db.$client.exec("DROP TRIGGER fail_void");
    const r = voidPayment(t.deps, invoiceId, payment.id, { reason: "誤り" }, "2027-01-05");
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(t.count("journals")).toBe(journals + 1);
    expect(r.value.journal).toMatchObject({
      date: "2027-01-05",
      source: "payment",
      correctsJournalId: journal.id,
    });
    expect(r.value.payment.voidJournalId).toBe(r.value.journal.id);
    expect(t.ledger.getJournal(journal.id)).toEqual(original);
    expect(getJournalOrigin(t.deps, r.value.journal.id)).toMatchObject({
      ok: true,
      value: { kind: "payment", paymentId: payment.id },
    });
    expect(r.value.invoice).toMatchObject({ status: "unpaid", remaining: 1_205_000 });
  });
});

// 013 US2: 源泉徴収税額つきの消し込みの実 DB での往復（R6、data-model §1.4・§3、INV-74）
describe("源泉徴収つきの消し込み（実 DB。013 US2）", () => {
  let withholdingInvoiceId: string;

  beforeEach(() => {
    t.setSettings({ nextSeq: 2, taxDisplay: "inclusive_only" });
    const partner = t.addPartner("株式会社B", { honorific: "御中" });
    t.setTerms(partner.id, { withholding: true });
    const issued = issueInvoice(
      t.deps,
      {
        partnerId: partner.id,
        targetMonth: "2026-09",
        items: [{ name: "開発", amount: 1_205_000, taxCategory: "SALES_10" }],
      },
      TODAY,
    );
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    withholdingInvoiceId = issued.value.invoice.id;
  });

  const payWithholding = (over: Partial<Parameters<typeof recordPayment>[2]> = {}) =>
    recordPayment(
      t.deps,
      withholdingInvoiceId,
      {
        receivedOn: "2026-11-10",
        amount: 1_061_039,
        withholdingAmount: 143_961,
        depositAccountId: t.accountId("普通預金"),
        ...over,
      },
      TODAY,
    );

  it("withholding_amount が保存され、複合仕訳（借方 入金先・事業主貸、貸方 売掛金）・詳細に読み戻される", () => {
    const r = payWithholding();
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { payment, journal, invoice } = r.value;
    expect(payment).toMatchObject({ amount: 1_061_039, feeAmount: 0, withholdingAmount: 143_961 });
    expect(invoice).toMatchObject({
      status: "paid",
      remaining: 0,
      withholdingPaid: 143_961,
      withholdingRemaining: 0,
    });
    expect(t.store.listPayments(withholdingInvoiceId)[0]).toMatchObject({
      id: payment.id,
      withholdingAmount: 143_961,
    });
    const saved = t.ledger.getJournal(journal.id);
    expect(saved?.source).toBe("payment");
    expect(
      saved?.lines.map((l) => [l.side, l.accountId === t.accountId("事業主貸"), l.amount]),
    ).toEqual([
      ["debit", false, 1_061_039],
      ["debit", true, 143_961],
      ["credit", false, 1_205_000],
    ]);
    expect(getInvoiceDetail(t.deps, withholdingInvoiceId, TODAY)).toMatchObject({
      ok: true,
      value: { status: "paid", withholdingRemaining: 0, payments: [payment] },
    });
    const audit = t.db.$client
      .prepare("SELECT after_json FROM invoicing_audit_log WHERE target_id = ?")
      .get(payment.id) as { after_json: string };
    expect(JSON.parse(audit.after_json)).toMatchObject({ withholdingAmount: 143_961 });
  });

  it("差額の扱いと併用でき、残額を超える額は拒否されて何も残らない", () => {
    const journals = t.count("journals");
    const over = payWithholding({ amount: 1_061_040 });
    expect(!over.ok && over.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
    expect(!over.ok && over.error.details).toMatchObject({ applied: 1_205_001 });
    expect(t.count("journals")).toBe(journals);

    const r = payWithholding({ amount: 1_060_000, treatDifferenceAsFee: true });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.payment).toMatchObject({ feeAmount: 1_039, withholdingAmount: 143_961 });
    expect(r.value.invoice).toMatchObject({ status: "paid", remaining: 0 });
  });

  it("取消: 仕訳が取り消され、withholding_amount の行は残り、源泉徴収の残りが戻る", () => {
    const paid = payWithholding();
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    const r = voidPayment(
      t.deps,
      withholdingInvoiceId,
      paid.value.payment.id,
      { reason: "誤り" },
      TODAY,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(t.ledger.getJournal(paid.value.journal.id)?.status).toBe("voided");
    expect(r.value.invoice).toMatchObject({
      status: "unpaid",
      withholdingPaid: 0,
      withholdingRemaining: 143_961,
    });
    expect(t.store.listPayments(withholdingInvoiceId)[0]).toMatchObject({
      withholdingAmount: 143_961,
      voidReason: "誤り",
    });
    // 取消済みの消し込みの withholding_amount もトリガーで変えられない
    expect(() =>
      t.db.$client
        .prepare("UPDATE invoice_payments SET withholding_amount = 0 WHERE id = ?")
        .run(paid.value.payment.id),
    ).toThrow(/immutable|only be voided/);
  });

  // 013 US3: 年間の一覧の問い合わせ（R7）。取消・源泉徴収 0・他の年を除き、取引先名の順
  it("withholdingSummary: 暦年・取消・源泉徴収 0 で絞り、取引先名の順に集計する", () => {
    const next = createNextFiscalPeriod({ repo: t.masters, ids: t.ids, clock: t.clock });
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    const first = payWithholding();
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    // 2026 年の取消でない源泉徴収 0 の消し込み（株式会社A の請求書）
    const plain = pay({ receivedOn: "2026-12-01", amount: 1_204_340 });
    if (!plain.ok) throw new Error(JSON.stringify(plain.error));
    // 別の請求書: 2027 年の入金と、取り消した 2026 年の入金
    const partner = t.addPartner("あ株式会社", { honorific: "御中" });
    t.setTerms(partner.id, { withholding: true });
    const issue = (month: string) => {
      const r = issueInvoice(
        t.deps,
        {
          partnerId: partner.id,
          targetMonth: month,
          confirmDuplicate: true,
          items: [{ name: "開発", amount: 110_000, taxCategory: "SALES_10" }],
        },
        TODAY,
      );
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value.invoice;
    };
    const later = issue("2026-10");
    const cancelled = issue("2026-11");
    const payTo = (id: string, receivedOn: string) =>
      recordPayment(
        t.deps,
        id,
        {
          receivedOn,
          amount: 100_000,
          withholdingAmount: 10_000,
          depositAccountId: t.accountId("普通預金"),
        },
        TODAY,
      );
    const p2027 = payTo(later.id, "2027-01-15");
    const p2026 = payTo(cancelled.id, "2026-12-20");
    if (!p2027.ok || !p2026.ok) throw new Error("消し込みに失敗");
    const voided = voidPayment(
      t.deps,
      cancelled.id,
      p2026.value.payment.id,
      { reason: "誤り" },
      TODAY,
    );
    expect(voided.ok).toBe(true);

    const s2026 = withholdingSummary(t.deps, 2026);
    if (!s2026.ok) throw new Error(JSON.stringify(s2026.error));
    expect(s2026.value).toMatchObject({
      year: 2026,
      appliedTotal: 1_205_000,
      withholdingTotal: 143_961,
    });
    expect(s2026.value.partners).toHaveLength(1);
    expect(s2026.value.partners[0]).toMatchObject({
      partnerName: "株式会社B",
      paymentCount: 1,
      appliedTotal: 1_205_000,
      withholdingTotal: 143_961,
      payments: [
        {
          paymentId: first.value.payment.id,
          invoiceId: withholdingInvoiceId,
          receivedOn: "2026-11-10",
          applied: 1_205_000,
          withholdingAmount: 143_961,
        },
      ],
    });
    const s2027 = withholdingSummary(t.deps, 2027);
    if (!s2027.ok) throw new Error(JSON.stringify(s2027.error));
    expect(s2027.value.partners.map((p) => p.partnerName)).toEqual(["あ株式会社"]);
    expect(s2027.value.withholdingTotal).toBe(10_000);
    const none = withholdingSummary(t.deps, 2031);
    expect(none).toEqual({
      ok: true,
      value: { year: 2031, partners: [], appliedTotal: 0, withholdingTotal: 0 },
    });
  });
});
