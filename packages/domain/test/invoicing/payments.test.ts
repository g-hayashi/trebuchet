import type { InvoiceInput } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import {
  INVOICING_ACCOUNT_CODES,
  paymentJournalDraft,
} from "../../src/invoicing/journal-drafts.ts";
import { invoiceStatus, isOverdue } from "../../src/invoicing/status.ts";
import type { Journal } from "../../src/types.ts";
import {
  issueInvoice,
  recordPayment,
  voidInvoice,
  voidPayment,
} from "../../src/usecases/invoicing.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { setupInvoicing } from "../invoicing-setup.ts";
import { TODAY } from "../test-dates.ts";

// 005 US2: 入金の消し込みの書き込みと取消、期限切れの判定（R12・R14、§1.6・§3、FR-017〜021、H:§4）

function ready() {
  const t = setupInvoicing({ taxable: true });
  t.setSettings({ nextSeq: 1 });
  const partner = t.addPartner({ name: "株式会社A", honorific: "様" });
  t.setTerms(partner.id);
  const deposit = t.accountId("普通預金");
  const issue = (over: Partial<InvoiceInput> = {}, amount = 1_205_000) => {
    const r = issueInvoice(
      t.deps,
      {
        partnerId: partner.id,
        targetMonth: "2026-10",
        confirmDuplicate: true,
        items: [{ name: "開発", amount, taxCategory: "SALES_10" }],
        ...over,
      },
      TODAY,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };
  const pay = (
    invoiceId: string,
    over: Partial<Parameters<typeof recordPayment>[2]> = {},
    today = TODAY,
  ) =>
    recordPayment(
      t.deps,
      invoiceId,
      { receivedOn: "2026-11-10", amount: 1_205_000, depositAccountId: deposit, ...over },
      today,
    );
  return { ...t, partner, deposit, issue, pay };
}

const net = (journal: Journal, accountId: string) =>
  journal.lines
    .filter((l) => l.accountId === accountId)
    .reduce((a, l) => a + (l.side === "debit" ? l.amount : -l.amount), 0);

describe("recordPayment", () => {
  it("Acceptance 1: 全額の消し込み。借方 普通預金（補助科目）・貸方 売掛金が入金日付で登録され、入金済みになる", () => {
    const t = ready();
    const sub = { id: "sub-1", accountId: t.deposit, name: "○○銀行", isActive: true };
    t.masters.insertSubAccount(sub);
    const issued = t.issue();
    const r = t.pay(issued.invoice.id, { depositSubAccountId: sub.id });
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(r.value.invoice).toMatchObject({ status: "paid", paid: 1_205_000, remaining: 0 });
    expect(r.value.payment).toMatchObject({
      receivedOn: "2026-11-10",
      amount: 1_205_000,
      feeAmount: 0,
      depositAccountId: t.deposit,
      depositSubAccountId: sub.id,
      voidedAt: null,
      journalId: r.value.journal.id,
    });
    expect(r.value.journal).toMatchObject({
      date: "2026-11-10",
      source: "payment",
      status: "active",
    });
    expect(
      r.value.journal.lines.map((l) => [
        l.side,
        l.accountId,
        l.subAccountId,
        l.amount,
        l.partnerId,
      ]),
    ).toEqual([
      ["debit", t.deposit, sub.id, 1_205_000, t.partner.id],
      ["credit", t.accountId("売掛金"), null, 1_205_000, t.partner.id],
    ]);
    // 詳細にも消し込みが載る。記録も残る
    expect(r.value.invoice.payments.map((p) => p.id)).toEqual([r.value.payment.id]);
    expect(t.invoicing.listPayments(issued.invoice.id)).toHaveLength(1);
    expect(t.invoicing.audits.at(-1)).toMatchObject({
      targetType: "payment",
      targetId: r.value.payment.id,
      action: "create",
    });
    expect(t.invoicing.originOfJournal(r.value.journal.id)).toMatchObject({
      kind: "payment",
      paymentId: r.value.payment.id,
    });
  });

  it("Acceptance 2: 差額を手数料として扱うと、複合仕訳（借方 普通預金・支払手数料、貸方 売掛金）で残額が 0 になる", () => {
    const t = ready();
    const issued = t.issue();
    const r = t.pay(issued.invoice.id, { amount: 1_204_340, treatDifferenceAsFee: true });
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(r.value.payment).toMatchObject({ amount: 1_204_340, feeAmount: 660 });
    expect(r.value.invoice).toMatchObject({ status: "paid", remaining: 0, paid: 1_205_000 });
    expect(r.value.journal.lines.map((l) => [l.side, l.accountId, l.amount, l.partnerId])).toEqual([
      ["debit", t.deposit, 1_204_340, t.partner.id],
      ["debit", t.accountId("支払手数料"), 660, t.partner.id],
      ["credit", t.accountId("売掛金"), 1_205_000, t.partner.id],
    ]);
  });

  it("Acceptance 3: 少ない入金は一部入金になり、次の入金で残額を消し込める", () => {
    const t = ready();
    const issued = t.issue();
    const first = t.pay(issued.invoice.id, { amount: 500_000 });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(first.value.invoice).toMatchObject({
      status: "partial",
      paid: 500_000,
      remaining: 705_000,
    });
    const second = t.pay(issued.invoice.id, { amount: 705_000, receivedOn: "2026-11-20" });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect(second.value.invoice).toMatchObject({ status: "paid", remaining: 0 });
    expect(second.value.invoice.payments).toHaveLength(2);
  });

  it("Acceptance 4: 残額より多い額は PAYMENT_EXCEEDS_BALANCE で、何も変わらない", () => {
    const t = ready();
    const issued = t.issue();
    t.pay(issued.invoice.id, { amount: 1_000_000 });
    const before = structuredClone({ l: t.ledger.state, i: t.invoicing.state });
    const r = t.pay(issued.invoice.id, { amount: 205_001 });
    expect(!r.ok && r.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
    expect(!r.ok && r.error.details).toMatchObject({ remaining: 205_000 });
    expect({ l: t.ledger.state, i: t.invoicing.state }).toEqual(before);
    // 残額ちょうどは通る。入金済みの後はどんな額も超過
    expect(t.pay(issued.invoice.id, { amount: 205_000 }).ok).toBe(true);
    const over = t.pay(issued.invoice.id, { amount: 1 });
    expect(!over.ok && over.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
  });

  it("手数料の差額: 入金額が残額以上なら VALIDATION（手数料は 0 より大きいときだけ）", () => {
    const t = ready();
    const issued = t.issue();
    for (const amount of [1_205_000, 1_205_001]) {
      const r = t.pay(issued.invoice.id, { amount, treatDifferenceAsFee: true });
      expect(!r.ok && r.error.code).toBe("VALIDATION");
    }
    expect(t.invoicing.listPayments(issued.invoice.id)).toEqual([]);
    // 一部入金の後の残額に対する差額
    t.pay(issued.invoice.id, { amount: 1_000_000 });
    const r = t.pay(issued.invoice.id, { amount: 204_000, treatDifferenceAsFee: true });
    expect(r.ok && r.value.payment.feeAmount).toBe(1_000);
  });

  it("取消済みの請求書は INVOICE_VOIDED。ない請求書は INVOICE_NOT_FOUND。入金額は正の整数", () => {
    const t = ready();
    const issued = t.issue();
    for (const amount of [0, -1, 1.5]) {
      const r = t.pay(issued.invoice.id, { amount });
      expect(!r.ok && r.error.code).toBe("VALIDATION");
    }
    const badDate = t.pay(issued.invoice.id, { receivedOn: "2026-02-30" });
    expect(!badDate.ok && badDate.error.code).toBe("VALIDATION");
    expect(t.pay("nope").ok).toBe(false);
    expect(t.pay("nope")).toMatchObject({ error: { code: "INVOICE_NOT_FOUND" } });

    voidInvoice(t.deps, issued.invoice.id, { reason: "誤り" }, TODAY);
    const r = t.pay(issued.invoice.id);
    expect(!r.ok && r.error.code).toBe("INVOICE_VOIDED");
  });

  it("001 の検証のエラーをそのまま返す（締め済み・期間外・税の設定の空白・使用停止の科目）", () => {
    const t = ready();
    const issued = t.issue({ targetMonth: "2025-12", issueDate: "2025-12-28" });
    const before = structuredClone({ l: t.ledger.state, i: t.invoicing.state });

    const outOfPeriod = t.pay(issued.invoice.id, { receivedOn: "2030-01-05" });
    expect(!outOfPeriod.ok && outOfPeriod.error.code).toBe("OUT_OF_PERIOD");

    // 税の設定の空白（課税の設定を 2025-07-01 からにして、それより前の入金日）
    const settings = t.masters.listTaxSettings();
    t.masters.replaceTaxSettings([
      {
        id: "gap",
        effectiveFrom: "2025-07-01",
        taxpayerStatus: "general",
        accountingMethod: "tax_included",
      },
    ]);
    const gap = t.pay(issued.invoice.id, { receivedOn: "2025-03-31" });
    expect(!gap.ok && gap.error.code).toBe("TAX_SETTING_GAP");
    t.masters.replaceTaxSettings(settings);

    const account = t.masters.listAccounts().find((a) => a.id === t.deposit);
    if (account === undefined) throw new Error("no account");
    t.masters.updateAccount({ ...account, isActive: false });
    const inactive = t.pay(issued.invoice.id);
    expect(!inactive.ok && inactive.error.code).toBe("ACCOUNT_INACTIVE");
    t.masters.updateAccount({ ...account, isActive: true });

    t.closeYear(2026);
    const closed = t.pay(issued.invoice.id);
    expect(!closed.ok && closed.error.code).toBe("PERIOD_CLOSED");
    expect({ l: t.ledger.state, i: t.invoicing.state }).toEqual(before);
  });
});

describe("voidPayment（Acceptance 6）", () => {
  it("未締め: 入金の仕訳が取り消され、残額が戻る。消し込みは消えない", () => {
    const t = ready();
    const issued = t.issue();
    const paid = t.pay(issued.invoice.id, { amount: 1_204_340, treatDifferenceAsFee: true });
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    const r = voidPayment(
      t.deps,
      issued.invoice.id,
      paid.value.payment.id,
      { reason: " 入金の誤り " },
      TODAY,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(r.value.payment).toMatchObject({
      id: paid.value.payment.id,
      voidReason: "入金の誤り",
      voidJournalId: null,
    });
    expect(r.value.payment.voidedAt).toBe(t.clock.now());
    expect(r.value.invoice).toMatchObject({ status: "unpaid", paid: 0, remaining: 1_205_000 });
    expect(r.value.journal).toMatchObject({ id: paid.value.journal.id, status: "voided" });
    expect(t.invoicing.listPayments(issued.invoice.id)).toHaveLength(1);
    expect(t.invoicing.audits.at(-1)).toMatchObject({
      targetType: "payment",
      targetId: paid.value.payment.id,
      action: "void",
      reason: "入金の誤り",
    });

    // 取り消した後は同じ額を消し込み直せる。請求書の取消も通る
    expect(t.pay(issued.invoice.id).ok).toBe(true);
  });

  it("締め済み: 今日付の訂正仕訳を起票し、元の仕訳は変わらない", () => {
    const t = ready();
    const issued = t.issue({
      targetMonth: "2025-12",
      issueDate: "2025-12-28",
      salesDate: "2025-12-31",
    });
    const paid = t.pay(issued.invoice.id, { receivedOn: "2025-12-30", amount: 1_000_000 });
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    const original = t.ledger.getJournal(paid.value.journal.id) as Journal;
    t.closeYear(2025);

    const r = voidPayment(t.deps, issued.invoice.id, paid.value.payment.id, { reason: "x" }, TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const reversal = r.value.journal;
    expect(reversal).toMatchObject({
      date: TODAY,
      source: "payment",
      correctsJournalId: original.id,
      status: "active",
    });
    expect(net(original, t.deposit) + net(reversal, t.deposit)).toBe(0);
    expect(net(original, t.accountId("売掛金")) + net(reversal, t.accountId("売掛金"))).toBe(0);
    expect(r.value.payment.voidJournalId).toBe(reversal.id);
    expect(r.value.invoice).toMatchObject({ remaining: 1_205_000, status: "unpaid" });
    expect(t.ledger.getJournal(original.id)).toEqual(original);
    expect(t.invoicing.originOfJournal(reversal.id)).toMatchObject({
      kind: "payment",
      paymentId: paid.value.payment.id,
    });
  });

  it("締め済みの入金の取消で今日の期間がなければ OUT_OF_PERIOD、何も変わらない", () => {
    const t = ready();
    const issued = t.issue({
      targetMonth: "2025-12",
      issueDate: "2025-12-28",
      salesDate: "2025-12-31",
    });
    const paid = t.pay(issued.invoice.id, { receivedOn: "2025-12-30", amount: 1_000_000 });
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    t.closeYear(2025);
    const before = structuredClone({ l: t.ledger.state, i: t.invoicing.state });
    const r = voidPayment(
      t.deps,
      issued.invoice.id,
      paid.value.payment.id,
      { reason: "x" },
      "2030-01-05",
    );
    expect(!r.ok && r.error.code).toBe("OUT_OF_PERIOD");
    expect({ l: t.ledger.state, i: t.invoicing.state }).toEqual(before);
  });

  it("エラー: 理由なし REASON_REQUIRED、ない消し込み PAYMENT_NOT_FOUND、取消済み PAYMENT_VOIDED、別の請求書の消し込み", () => {
    const t = ready();
    const a = t.issue();
    const b = t.issue(
      { items: [{ name: "保守", amount: 50_000, taxCategory: "SALES_10" }] },
      50_000,
    );
    const paid = t.pay(a.invoice.id, { amount: 1_000 });
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    const id = paid.value.payment.id;

    const noReason = voidPayment(t.deps, a.invoice.id, id, { reason: "  " }, TODAY);
    expect(!noReason.ok && noReason.error.code).toBe("REASON_REQUIRED");
    const missing = voidPayment(t.deps, a.invoice.id, "nope", { reason: "x" }, TODAY);
    expect(!missing.ok && missing.error.code).toBe("PAYMENT_NOT_FOUND");
    const noInvoice = voidPayment(t.deps, "nope", id, { reason: "x" }, TODAY);
    expect(!noInvoice.ok && noInvoice.error.code).toBe("INVOICE_NOT_FOUND");
    const other = voidPayment(t.deps, b.invoice.id, id, { reason: "x" }, TODAY);
    expect(!other.ok && other.error.code).toBe("PAYMENT_NOT_FOUND");

    expect(voidPayment(t.deps, a.invoice.id, id, { reason: "x" }, TODAY).ok).toBe(true);
    const twice = voidPayment(t.deps, a.invoice.id, id, { reason: "x" }, TODAY);
    expect(!twice.ok && twice.error.code).toBe("PAYMENT_VOIDED");
  });

  it("INVOICE_HAS_PAYMENTS で請求書の取消が止まり、消し込みを取り消した後は通る", () => {
    const t = ready();
    const issued = t.issue();
    const paid = t.pay(issued.invoice.id, { amount: 1_000 });
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    const blocked = voidInvoice(t.deps, issued.invoice.id, { reason: "x" }, TODAY);
    expect(!blocked.ok && blocked.error.code).toBe("INVOICE_HAS_PAYMENTS");
    expect(!blocked.ok && blocked.error.details).toMatchObject({
      paymentIds: [paid.value.payment.id],
    });
    voidPayment(t.deps, issued.invoice.id, paid.value.payment.id, { reason: "x" }, TODAY);
    expect(voidInvoice(t.deps, issued.invoice.id, { reason: "x" }, TODAY).ok).toBe(true);
  });

  it("入金・取消の仕訳は 001 の訂正・取消から守られる（JOURNAL_LINKED）", () => {
    const t = ready();
    const issued = t.issue();
    const paid = t.pay(issued.invoice.id, { amount: 1_000 });
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    const journal = t.ledger.getJournal(paid.value.journal.id) as Journal;
    expect(journal.source).toBe("payment");
    const direct = voidJournal(
      { ledger: t.ledger, masters: t.masters, ids: t.ids, clock: t.clock },
      journal.id,
      { reason: "x", version: journal.version },
    );
    expect(!direct.ok && direct.error.code).toBe("JOURNAL_LINKED");
    expect(t.ledger.getJournal(journal.id)?.status).toBe("active");
  });
});

// 013 US2: 源泉徴収された入金の消し込み（R6、data-model §2・§3、FR-008〜012・015）
describe("源泉徴収つきの消し込み（013 US2）", () => {
  /** 源泉徴収あり・税込のみ表示の取引先。合計 1,205,000 円、源泉徴収税額 143,961 円、差引請求額 1,061,039 円 */
  function withholdingReady() {
    const t = ready();
    t.setSettings({ nextSeq: 1, taxDisplay: "inclusive_only" });
    t.setTerms(t.partner.id, { withholding: true });
    return { ...t, ownerDrawing: t.accountId("事業主貸") };
  }
  const lines = (j: Journal) => j.lines.map((l) => [l.side, l.accountId, l.amount, l.partnerId]);

  it("Acceptance 1: 入金 1,061,039 円 + 源泉徴収税額 143,961 円。借方 入金先・事業主貸、貸方 売掛金 1,205,000 円の複合仕訳で入金済み", () => {
    const t = withholdingReady();
    const issued = t.issue();
    expect(issued.invoice).toMatchObject({ withholdingTax: 143_961 });
    const r = t.pay(issued.invoice.id, { amount: 1_061_039, withholdingAmount: 143_961 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(r.value.payment).toMatchObject({
      amount: 1_061_039,
      feeAmount: 0,
      withholdingAmount: 143_961,
    });
    expect(r.value.invoice).toMatchObject({
      status: "paid",
      paid: 1_205_000,
      remaining: 0,
      withholdingPaid: 143_961,
      withholdingRemaining: 0,
    });
    expect(r.value.journal).toMatchObject({ date: "2026-11-10", source: "payment" });
    expect(lines(r.value.journal)).toEqual([
      ["debit", t.deposit, 1_061_039, t.partner.id],
      ["debit", t.ownerDrawing, 143_961, t.partner.id],
      ["credit", t.accountId("売掛金"), 1_205_000, t.partner.id],
    ]);
    // 発行の仕訳は変わらず 1 件（売掛金／売上高 1,205,000 円）
    expect(t.ledger.getJournal(issued.journal.id)?.lines.map((l) => l.amount)).toEqual([
      1_205_000, 1_205_000,
    ]);
    // 消し込みの記録（FR-015）に withholdingAmount が入る
    const audit = t.invoicing.audits.at(-1);
    expect(audit).toMatchObject({ targetType: "payment", action: "create" });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ withholdingAmount: 143_961 });
  });

  it("Acceptance 2: 取引先の計算が違い 143,960 円に直しても受け付け、請求書の値と実際の額の両方が残る", () => {
    const t = withholdingReady();
    const issued = t.issue();
    const r = t.pay(issued.invoice.id, { amount: 1_061_040, withholdingAmount: 143_960 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.invoice).toMatchObject({
      status: "paid",
      withholdingTax: 143_961,
      withholdingPaid: 143_960,
      withholdingRemaining: 1,
    });
    expect(r.value.payment.withholdingAmount).toBe(143_960);
    expect(t.invoicing.listPayments(issued.invoice.id)[0]?.withholdingAmount).toBe(143_960);
  });

  it("Acceptance 3: 差額を手数料にすると fee = 残額 − 入金額 − 源泉徴収税額。借方 入金先・支払手数料・事業主貸、貸方 売掛金", () => {
    const t = withholdingReady();
    const issued = t.issue();
    const r = t.pay(issued.invoice.id, {
      amount: 1_060_000,
      withholdingAmount: 143_961,
      treatDifferenceAsFee: true,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.payment).toMatchObject({ feeAmount: 1_039, withholdingAmount: 143_961 });
    expect(r.value.invoice).toMatchObject({ status: "paid", remaining: 0 });
    expect(lines(r.value.journal)).toEqual([
      ["debit", t.deposit, 1_060_000, t.partner.id],
      ["debit", t.accountId("支払手数料"), 1_039, t.partner.id],
      ["debit", t.ownerDrawing, 143_961, t.partner.id],
      ["credit", t.accountId("売掛金"), 1_205_000, t.partner.id],
    ]);
    // 入金額 + 源泉徴収税額が残額以上なら手数料にできる差額がない
    const none = t.pay(issued.invoice.id, {
      amount: 1_061_039,
      withholdingAmount: 143_961,
      treatDifferenceAsFee: true,
    });
    expect(!none.ok && none.error.code).toBe("VALIDATION");
  });

  it("Acceptance 4: 入金額 + 源泉徴収税額が残額を超えると PAYMENT_EXCEEDS_BALANCE（details.applied に源泉徴収税額を含む）。何も変わらない", () => {
    const t = withholdingReady();
    const issued = t.issue();
    const before = structuredClone({ l: t.ledger.state, i: t.invoicing.state });
    const r = t.pay(issued.invoice.id, { amount: 1_061_040, withholdingAmount: 143_961 });
    expect(!r.ok && r.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
    expect(!r.ok && r.error.details).toMatchObject({
      invoiceId: issued.invoice.id,
      remaining: 1_205_000,
      applied: 1_205_001,
    });
    expect({ l: t.ledger.state, i: t.invoicing.state }).toEqual(before);
    // 請求書の値より大きい源泉徴収税額でも、残額を超えなければ受け付ける
    const ok = t.pay(issued.invoice.id, { amount: 1_061_038, withholdingAmount: 143_962 });
    expect(ok.ok).toBe(true);
  });

  it("源泉徴収税額は 0 以上の整数（負・小数・1 兆円以上は VALIDATION）。省略と 0 は同じ", () => {
    const t = withholdingReady();
    const issued = t.issue();
    for (const withholdingAmount of [-1, 1.5, 1_000_000_000_000]) {
      const r = t.pay(issued.invoice.id, { amount: 1_000, withholdingAmount });
      expect(!r.ok && r.error.code).toBe("VALIDATION");
    }
    expect(t.invoicing.listPayments(issued.invoice.id)).toEqual([]);
    const r = t.pay(issued.invoice.id, { amount: 1_000, withholdingAmount: 0 });
    expect(r.ok && r.value.payment.withholdingAmount).toBe(0);
    expect(r.ok && r.value.journal.lines).toHaveLength(2);
  });

  it("一部入金の 2 回目: withholdingPaid・withholdingRemaining が消し込みごとに変わり、取消の消し込みは数えない", () => {
    const t = withholdingReady();
    const issued = t.issue();
    const first = t.pay(issued.invoice.id, { amount: 500_000, withholdingAmount: 50_000 });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(first.value.invoice).toMatchObject({
      status: "partial",
      paid: 550_000,
      remaining: 655_000,
      withholdingPaid: 50_000,
      withholdingRemaining: 93_961,
    });
    const second = t.pay(issued.invoice.id, { amount: 561_039, withholdingAmount: 93_961 });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect(second.value.invoice).toMatchObject({
      status: "paid",
      withholdingPaid: 143_961,
      withholdingRemaining: 0,
    });
    // 請求書の値を超えて差し引かれたときの残りは 0（負にならない）
    const voided = voidPayment(
      t.deps,
      issued.invoice.id,
      second.value.payment.id,
      { reason: "x" },
      TODAY,
    );
    expect(voided.ok && voided.value.invoice).toMatchObject({
      status: "partial",
      withholdingPaid: 50_000,
      withholdingRemaining: 93_961,
    });
  });

  it("Acceptance 5: 未締めの取消で仕訳が取り消され、源泉徴収税額も数えなくなる。消し込みの行には値が残る", () => {
    const t = withholdingReady();
    const issued = t.issue();
    const paid = t.pay(issued.invoice.id, { amount: 1_061_039, withholdingAmount: 143_961 });
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    const r = voidPayment(t.deps, issued.invoice.id, paid.value.payment.id, { reason: "x" }, TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.journal).toMatchObject({ id: paid.value.journal.id, status: "voided" });
    expect(r.value.invoice).toMatchObject({
      status: "unpaid",
      remaining: 1_205_000,
      withholdingPaid: 0,
      withholdingRemaining: 143_961,
    });
    expect(r.value.payment.withholdingAmount).toBe(143_961);
    const audit = t.invoicing.audits.at(-1);
    expect(audit).toMatchObject({ action: "void" });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({ withholdingAmount: 143_961 });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ withholdingAmount: 143_961 });
  });

  it("Acceptance 5: 締め済みの取消は今日付の訂正仕訳で、事業主貸の行も逆になる", () => {
    const t = withholdingReady();
    const issued = t.issue({
      targetMonth: "2025-12",
      issueDate: "2025-12-28",
      salesDate: "2025-12-31",
    });
    const paid = t.pay(issued.invoice.id, {
      receivedOn: "2025-12-30",
      amount: 1_061_039,
      withholdingAmount: 143_961,
    });
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    t.closeYear(2025);
    const r = voidPayment(t.deps, issued.invoice.id, paid.value.payment.id, { reason: "x" }, TODAY);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(net(r.value.journal, t.ownerDrawing)).toBe(-143_961);
    expect(net(r.value.journal, t.accountId("売掛金"))).toBe(1_205_000);
    expect(r.value.invoice).toMatchObject({ withholdingPaid: 0, withholdingRemaining: 143_961 });
  });

  it("Acceptance 6: 源泉徴収なしの請求書では withholdingAmount の省略は 0 で、005 と同じ 2 行の仕訳。残りは 0", () => {
    const t = ready();
    const issued = t.issue();
    const r = t.pay(issued.invoice.id);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.payment.withholdingAmount).toBe(0);
    expect(r.value.journal.lines).toHaveLength(2);
    expect(r.value.invoice).toMatchObject({ withholdingPaid: 0, withholdingRemaining: 0 });
  });

  it("入金の仕訳は JOURNAL_LINKED で守られ、事業主貸の行があっても訂正・取消できない（FR-012）", () => {
    const t = withholdingReady();
    const issued = t.issue();
    const paid = t.pay(issued.invoice.id, { amount: 1_061_039, withholdingAmount: 143_961 });
    if (!paid.ok) throw new Error(JSON.stringify(paid.error));
    const journal = t.ledger.getJournal(paid.value.journal.id) as Journal;
    const direct = voidJournal(
      { ledger: t.ledger, masters: t.masters, ids: t.ids, clock: t.clock },
      journal.id,
      { reason: "x", version: journal.version },
    );
    expect(!direct.ok && direct.error.code).toBe("JOURNAL_LINKED");
  });
});

describe("invoiceStatus（013）: 充当額に源泉徴収税額を含める", () => {
  it("paid = 入金額 + 手数料 + 源泉徴収税額。取消済みは数えない。withholdingAmount の省略は 0", () => {
    const invoice = { total: 1_205_000, voidedAt: null };
    expect(
      invoiceStatus(invoice, [
        { amount: 1_061_039, feeAmount: 0, withholdingAmount: 143_961, voidedAt: null },
      ]),
    ).toEqual({ status: "paid", paid: 1_205_000, remaining: 0 });
    expect(
      invoiceStatus(invoice, [
        { amount: 500_000, feeAmount: 1_000, withholdingAmount: 50_000, voidedAt: null },
        { amount: 100_000, feeAmount: 0, withholdingAmount: 20_000, voidedAt: "2026-11-11" },
      ]),
    ).toEqual({ status: "partial", paid: 551_000, remaining: 654_000 });
    expect(invoiceStatus(invoice, [{ amount: 5, feeAmount: 0, voidedAt: null }]).paid).toBe(5);
  });
});

describe("isOverdue（FR-020、R14）", () => {
  const invoice = { dueDate: "2026-11-30", voidedAt: null };
  it("残額 > 0 かつ 今日 > 支払期限。支払期限の当日は偽、翌日は真", () => {
    expect(isOverdue(invoice, 1, "2026-11-29")).toBe(false);
    expect(isOverdue(invoice, 1, "2026-11-30")).toBe(false);
    expect(isOverdue(invoice, 1, "2026-12-01")).toBe(true);
  });
  it("残額 0（入金済み）や取消の請求書は偽", () => {
    expect(isOverdue(invoice, 0, "2027-01-01")).toBe(false);
    expect(isOverdue({ ...invoice, voidedAt: "2026-11-01T00:00:00.000Z" }, 100, "2027-01-01")).toBe(
      false,
    );
  });
  it("invoiceStatus の remaining と組み合わせる（取消の請求書の remaining は 0）", () => {
    const standing = invoiceStatus({ total: 100, voidedAt: null }, [
      { amount: 40, feeAmount: 0, voidedAt: null },
    ]);
    expect(isOverdue(invoice, standing.remaining, "2026-12-01")).toBe(true);
  });
});

describe("paymentJournalDraft", () => {
  const accounts = [
    { id: "a-recv", code: INVOICING_ACCOUNT_CODES.receivable },
    { id: "a-fee", code: INVOICING_ACCOUNT_CODES.paymentFee },
  ];
  const source = {
    invoiceNo: "20261031-001",
    partnerId: "p-1",
    receivedOn: "2026-11-10",
    amount: 1_000,
    feeAmount: 0,
    depositAccountId: "a-bank",
    depositSubAccountId: "s-1",
  };

  it("手数料 0 は借方 入金先・貸方 売掛金の 2 行。全行に取引先、摘要は 入金 <番号>、日付は入金日", () => {
    const r = paymentJournalDraft(source, accounts);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value).toEqual({
      date: "2026-11-10",
      memo: "入金 20261031-001",
      lines: [
        {
          side: "debit",
          accountId: "a-bank",
          subAccountId: "s-1",
          amount: 1_000,
          partnerId: "p-1",
        },
        { side: "credit", accountId: "a-recv", amount: 1_000, partnerId: "p-1" },
      ],
    });
  });

  it("手数料 > 0 は借方 支払手数料を足し、貸方 売掛金は充当額（入金額 + 手数料）", () => {
    const r = paymentJournalDraft(
      { ...source, depositSubAccountId: null, feeAmount: 660 },
      accounts,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.lines).toEqual([
      { side: "debit", accountId: "a-bank", amount: 1_000, partnerId: "p-1" },
      { side: "debit", accountId: "a-fee", amount: 660, partnerId: "p-1" },
      { side: "credit", accountId: "a-recv", amount: 1_660, partnerId: "p-1" },
    ]);
  });

  it("源泉徴収税額 > 0 は借方 事業主貸（3090）を最後の借方に足し、貸方 売掛金は入金額 + 手数料 + 源泉徴収税額", () => {
    const r = paymentJournalDraft(
      { ...source, depositSubAccountId: null, feeAmount: 660, withholdingAmount: 300 },
      [...accounts, { id: "a-owner", code: INVOICING_ACCOUNT_CODES.ownerDrawing }],
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(INVOICING_ACCOUNT_CODES.ownerDrawing).toBe("3090");
    expect(r.value.lines).toEqual([
      { side: "debit", accountId: "a-bank", amount: 1_000, partnerId: "p-1" },
      { side: "debit", accountId: "a-fee", amount: 660, partnerId: "p-1" },
      { side: "debit", accountId: "a-owner", amount: 300, partnerId: "p-1" },
      { side: "credit", accountId: "a-recv", amount: 1_960, partnerId: "p-1" },
    ]);
  });

  it("源泉徴収税額 0（省略を含む）は事業主貸の行を足さない", () => {
    const r = paymentJournalDraft({ ...source, withholdingAmount: 0 }, accounts);
    expect(r.ok && r.value.lines).toHaveLength(2);
  });

  it("科目がなければ ACCOUNT_NOT_FOUND（事業主貸は源泉徴収税額 > 0 のときだけ引く）", () => {
    const r = paymentJournalDraft({ ...source, feeAmount: 1 }, [accounts[0] as never]);
    expect(!r.ok && r.error.code).toBe("ACCOUNT_NOT_FOUND");
    const owner = paymentJournalDraft({ ...source, withholdingAmount: 1 }, accounts);
    expect(!owner.ok && owner.error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(!owner.ok && owner.error.details).toMatchObject({ code: "3090" });
  });
});
