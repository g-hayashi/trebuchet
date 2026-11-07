import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  issueInvoice,
  recordPayment,
  voidPayment,
  withholdingSummary,
} from "../../src/usecases/invoicing.ts";
import { arbLedgerOps } from "../invoicing-arbitraries.ts";
import { runOp } from "../invoicing-ops.ts";
import { setupInvoicing, setupScenario } from "../invoicing-setup.ts";
import { TODAY } from "../test-dates.ts";

// 013 US3: 年間の源泉徴収の一覧（R7、contracts §4、INV-75、FR-013・014）

const YEARS = [2024, 2025, 2026, 2027];

function summaryOf(s: { deps: Parameters<typeof withholdingSummary>[0] }, year: number) {
  const r = withholdingSummary(s.deps, year);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const seen = { years: 0, voided: 0, reversed: 0, nonEmpty: 0, crossYear: 0 };

describe("INV-75: 年間の一覧の源泉徴収税額の合計 = その暦年の取消でない入金の仕訳の事業主貸の借方の合計", () => {
  it("任意の発行・消し込み・取消の列（年またぎ・締めた年度の訂正仕訳を含む）で成り立つ", () => {
    fc.assert(
      fc.property(fc.boolean(), arbLedgerOps, fc.nat(100), (taxable, ops, closePercent) => {
        const s = setupScenario({ taxable, initialSeq: 1, withholding: true });
        const closeAt = Math.floor((closePercent * ops.length) / 100);
        for (const [i, op] of ops.entries()) {
          if (i === closeAt) s.closeYear(2025);
          runOp(s, s.deps, op);
        }
        const journals = s.ledger.journals;
        const ownerDrawing = s.accountId("事業主貸");
        // 取消でない = 訂正仕訳（取消の仕訳）でも、訂正仕訳で取り消された元の仕訳でもなく、active のもの
        const reversed = new Set(
          journals.map((j) => j.correctsJournalId).filter((x) => x !== null),
        );
        const standing = journals.filter(
          (j) =>
            j.source === "payment" &&
            j.status === "active" &&
            j.correctsJournalId === null &&
            !reversed.has(j.id),
        );
        const debitOf = (year: number) =>
          standing
            .filter((j) => j.date.startsWith(`${year}-`))
            .flatMap((j) => j.lines)
            .filter((l) => l.accountId === ownerDrawing && l.side === "debit")
            .reduce((a, l) => a + l.amount, 0);

        const payments = s.invoicing.state.payments;
        for (const year of YEARS) {
          const summary = summaryOf(s, year);
          seen.years += 1;
          expect(summary.year).toBe(year);
          expect(summary.withholdingTotal).toBe(debitOf(year));
          // 取引先ごと・明細・全体の合計が一貫している
          expect(summary.partners.reduce((a, p) => a + p.withholdingTotal, 0)).toBe(
            summary.withholdingTotal,
          );
          expect(summary.partners.reduce((a, p) => a + p.appliedTotal, 0)).toBe(
            summary.appliedTotal,
          );
          const names = summary.partners.map((p) => p.partnerName);
          expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
          for (const p of summary.partners) {
            expect(p.paymentCount).toBe(p.payments.length);
            expect(p.payments.reduce((a, x) => a + x.withholdingAmount, 0)).toBe(
              p.withholdingTotal,
            );
            expect(p.payments.reduce((a, x) => a + x.applied, 0)).toBe(p.appliedTotal);
            for (const x of p.payments) {
              const record = payments.find((r) => r.id === x.paymentId);
              expect(record?.voidedAt).toBeNull();
              expect(x.withholdingAmount).toBeGreaterThan(0);
              expect(x.receivedOn.startsWith(`${year}-`)).toBe(true);
            }
          }
          if (summary.partners.length > 0) seen.nonEmpty += 1;
        }
        // 入金のない年は空
        expect(summaryOf(s, 2030)).toMatchObject({
          partners: [],
          withholdingTotal: 0,
          appliedTotal: 0,
        });
        for (const p of payments) {
          if (p.voidedAt !== null && p.withholdingAmount > 0) seen.voided += 1;
          if (p.voidJournalId !== null && p.withholdingAmount > 0) seen.reversed += 1;
        }
        const years = new Set(
          payments.filter((p) => p.withholdingAmount > 0).map((p) => p.receivedOn.slice(0, 4)),
        );
        if (years.size > 1) seen.crossYear += 1;
      }),
      { numRuns: 150 },
    );
    expect(seen.nonEmpty).toBeGreaterThan(0);
    expect(seen.voided).toBeGreaterThan(0);
    expect(seen.reversed).toBeGreaterThan(0);
    expect(seen.crossYear).toBeGreaterThan(0);
  });
});

describe("withholdingSummary（Acceptance 1〜3）", () => {
  function ready() {
    const t = setupInvoicing({ taxable: true });
    t.setSettings({ nextSeq: 1, taxDisplay: "inclusive_only" });
    const b = t.addPartner({ name: "B 社", honorific: "御中" });
    const a = t.addPartner({ name: "A 社", honorific: "御中" });
    for (const p of [a, b]) t.setTerms(p.id, { withholding: true });
    const issue = (partnerId: string, targetMonth: string, amount: number) => {
      const r = issueInvoice(
        t.deps,
        {
          partnerId,
          targetMonth,
          confirmDuplicate: true,
          items: [{ name: "開発", amount, taxCategory: "SALES_10" }],
        },
        TODAY,
      );
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value.invoice;
    };
    const pay = (
      invoiceId: string,
      receivedOn: string,
      amount: number,
      withholdingAmount: number,
    ) => {
      const r = recordPayment(
        t.deps,
        invoiceId,
        { receivedOn, amount, withholdingAmount, depositAccountId: t.accountId("普通預金") },
        TODAY,
      );
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value.payment;
    };
    return { ...t, a, b, issue, pay };
  }

  it("2026 年の入金だけを取引先名の順に集計し、取消した分と 2025 年の分を含めない", () => {
    const t = ready();
    const i1 = t.issue(t.b.id, "2026-08", 110_000);
    const i2 = t.issue(t.a.id, "2026-09", 220_000);
    const i3 = t.issue(t.a.id, "2026-10", 330_000);
    const i4 = t.issue(t.b.id, "2026-07", 110_000);
    t.pay(i1.id, "2026-11-10", 100_000, 10_000);
    const keep = t.pay(i2.id, "2026-12-20", 200_000, 20_000);
    t.pay(i3.id, "2025-12-28", 300_000, 30_000);
    const voided = t.pay(i4.id, "2026-12-05", 100_000, 10_000);
    const v = voidPayment(t.deps, i4.id, voided.id, { reason: "誤り" }, TODAY);
    expect(v.ok).toBe(true);

    const s = summaryOf(t, 2026);
    expect(s).toMatchObject({ year: 2026, appliedTotal: 330_000, withholdingTotal: 30_000 });
    expect(s.partners.map((p) => p.partnerName)).toEqual(["A 社", "B 社"]);
    expect(s.partners[0]).toMatchObject({
      partnerId: t.a.id,
      paymentCount: 1,
      appliedTotal: 220_000,
      withholdingTotal: 20_000,
      payments: [
        {
          paymentId: keep.id,
          invoiceId: i2.id,
          invoiceNo: i2.invoiceNo,
          receivedOn: "2026-12-20",
          applied: 220_000,
          withholdingAmount: 20_000,
        },
      ],
    });
    // 入金日の暦年で数える（請求書の発行日の年ではない）
    expect(summaryOf(t, 2025)).toMatchObject({ withholdingTotal: 30_000, appliedTotal: 330_000 });
    expect(summaryOf(t, 2025).partners).toHaveLength(1);
  });

  it("源泉徴収税額が 0 の消し込みは含めない。該当がなければ partners は空（会計期間のない年も同じ）", () => {
    const t = ready();
    const i1 = t.issue(t.a.id, "2026-08", 110_000);
    t.pay(i1.id, "2026-11-10", 110_000, 0);
    expect(summaryOf(t, 2026)).toEqual({
      year: 2026,
      partners: [],
      appliedTotal: 0,
      withholdingTotal: 0,
    });
    expect(summaryOf(t, 1990)).toMatchObject({ year: 1990, partners: [] });
  });
});
