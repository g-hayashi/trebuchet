import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { invoiceStatus } from "../src/invoicing/status.ts";
import type { Journal } from "../src/types.ts";
import {
  type InvoicingDeps,
  issueInvoice,
  recordPayment,
  voidInvoice,
  voidPayment,
} from "../src/usecases/invoicing.ts";
import { FaultInjectingUnitOfWork, snapshotOf } from "./fault-injection.ts";
import { arbLedgerOps, type LedgerOp, toInvoiceInput } from "./invoicing-arbitraries.ts";
import { setupScenario } from "./invoicing-setup.ts";
import { TODAY } from "./test-dates.ts";

// 005 US2: 消し込みの不変条件（INV-32 の消し込み・取消、INV-33、INV-34）

const pad = (n: number) => String(n).padStart(2, "0");

type Scenario = ReturnType<typeof setupScenario>;

/** 操作を実行する。対象がない操作は null（何もしない）。検査のエラーは `{ ok: false, code }` */
function runOp(
  s: Scenario,
  deps: InvoicingDeps,
  op: LedgerOp,
): { ok: boolean; code?: string } | null {
  const invoices = s.invoicing.state.invoices;
  const toResult = (r: { ok: true } | { ok: false; error: { code: string } }) =>
    r.ok ? { ok: true } : { ok: false, code: r.error.code };
  switch (op.kind) {
    case "issue":
      return toResult(issueInvoice(deps, toInvoiceInput(op.spec, s.partnerIds), TODAY));
    case "void": {
      const target = invoices[op.target % Math.max(invoices.length, 1)];
      if (target === undefined) return null;
      return toResult(voidInvoice(deps, target.id, { reason: op.reason }, TODAY));
    }
    case "pay": {
      const target = invoices[op.target % Math.max(invoices.length, 1)];
      if (target === undefined) return null;
      const payments = s.invoicing.listPayments(target.id);
      const remaining = invoiceStatus(target, payments).remaining;
      // 源泉徴収税額（013）。`tax` は web の既定値（請求書の値 − 入金済み。残額以下）
      const withheld = payments
        .filter((p) => p.voidedAt === null)
        .reduce((a, p) => a + p.withholdingAmount, 0);
      const withholdingAmount =
        op.withholdingMode === "none"
          ? 0
          : op.withholdingMode === "tax"
            ? Math.min(remaining, Math.max(0, target.withholdingTax - withheld))
            : Math.floor((remaining * op.wpct) / 100);
      const rest = remaining - withholdingAmount;
      const partial = Math.max(1, Math.floor((rest * op.pct) / 100));
      const amount = op.mode === "full" ? rest : op.mode === "over" ? rest + op.extra : partial;
      return toResult(
        recordPayment(
          deps,
          target.id,
          {
            receivedOn: `${op.year}-${pad(op.month)}-${pad(op.day)}`,
            amount,
            depositAccountId: s.accountId("普通預金"),
            ...(op.withholdingMode === "none" && op.wpct % 2 === 0 ? {} : { withholdingAmount }),
            ...(op.mode === "fee" ? { treatDifferenceAsFee: true } : {}),
          },
          TODAY,
        ),
      );
    }
    case "voidPayment": {
      const payments = s.invoicing.state.payments;
      const target = payments[op.target % Math.max(payments.length, 1)];
      if (target === undefined) return null;
      return toResult(voidPayment(deps, target.invoiceId, target.id, { reason: op.reason }, TODAY));
    }
  }
}

const EXPECTED_ERRORS = [
  "PERIOD_CLOSED",
  "OUT_OF_PERIOD",
  "INVOICE_VOIDED",
  "INVOICE_HAS_PAYMENTS",
  "PAYMENT_EXCEEDS_BALANCE",
  "PAYMENT_VOIDED",
  "VALIDATION",
];

const sum = (lines: Journal["lines"]) =>
  lines.reduce((a, l) => a + (l.side === "debit" ? l.amount : -l.amount), 0);

/** INV-33・INV-34・INV-74 と、消し込み ⇔ 仕訳の対応 */
function checkInvariants(s: Scenario) {
  const { invoices, payments } = s.invoicing.state;
  const journals = s.ledger.journals;
  const receivable = s.accountId("売掛金");
  const ownerDrawing = s.accountId("事業主貸");

  // INV-33・INV-74: 取消でない消し込みの充当額（入金額 + 手数料 + 源泉徴収税額）の合計 ≤ total。状態は残額だけで決まる
  for (const inv of invoices) {
    const mine = payments.filter((p) => p.invoiceId === inv.id);
    const applied = mine
      .filter((p) => p.voidedAt === null)
      .reduce((a, p) => a + p.amount + p.feeAmount + p.withholdingAmount, 0);
    expect(applied).toBeLessThanOrEqual(inv.total);
    const standing = invoiceStatus(inv, mine);
    expect(standing.paid).toBe(applied);
    if (inv.voidedAt !== null) {
      expect(applied).toBe(0);
      expect(standing.status).toBe("voided");
    } else {
      const remaining = inv.total - applied;
      expect(standing.remaining).toBe(remaining);
      expect(standing.status).toBe(
        remaining === 0 ? "paid" : remaining === inv.total ? "unpaid" : "partial",
      );
    }
  }

  // INV-34: 取引先ごとに、請求・入金の仕訳（取消でない。訂正仕訳を含む）の売掛金の残高 = 取消でない請求書の残額の合計
  for (const partnerId of s.partnerIds) {
    const balance = journals
      .filter((j) => (j.source === "invoice" || j.source === "payment") && j.status === "active")
      .flatMap((j) => j.lines)
      .filter((l) => l.accountId === receivable && l.partnerId === partnerId)
      .reduce((a, l) => a + (l.side === "debit" ? l.amount : -l.amount), 0);
    const outstanding = invoices
      .filter((inv) => inv.partnerId === partnerId && inv.voidedAt === null)
      .reduce(
        (a, inv) =>
          a +
          invoiceStatus(
            inv,
            payments.filter((p) => p.invoiceId === inv.id),
          ).remaining,
        0,
      );
    expect(balance).toBe(outstanding);
    expect(balance).toBeGreaterThanOrEqual(0);
  }

  // 消し込み ⇔ 仕訳（INV-32）
  const owned = new Set<string>();
  for (const p of payments) {
    const original = journals.find((j) => j.id === p.journalId) as Journal;
    expect(original).toBeDefined();
    expect(original.source).toBe("payment");
    expect(original.date).toBe(p.receivedOn);
    expect(sum(original.lines)).toBe(0);
    const credit = original.lines.filter((l) => l.side === "credit");
    expect(credit).toHaveLength(1);
    expect(credit[0]?.accountId).toBe(receivable);
    // INV-74: 売掛金の貸方 = 充当額、事業主貸 3090 の借方 = withholdingAmount（0 なら行がない）
    expect(credit[0]?.amount).toBe(p.amount + p.feeAmount + p.withholdingAmount);
    const drawing = original.lines.filter((l) => l.accountId === ownerDrawing);
    if (p.withholdingAmount > 0) {
      expect(drawing.map((l) => [l.side, l.amount, l.partnerId])).toEqual([
        ["debit", p.withholdingAmount, credit[0]?.partnerId],
      ]);
    } else {
      expect(drawing).toEqual([]);
    }
    const debitTotal = original.lines
      .filter((l) => l.side === "debit")
      .reduce((a, l) => a + l.amount, 0);
    expect(debitTotal).toBe(p.amount + p.feeAmount + p.withholdingAmount);
    owned.add(p.journalId);
    const reversals = journals.filter((j) => j.correctsJournalId === p.journalId);
    if (p.voidedAt === null) {
      expect(p.voidReason).toBeNull();
      expect(p.voidJournalId).toBeNull();
      expect(original.status).toBe("active");
      expect(reversals).toEqual([]);
    } else if (p.voidJournalId === null) {
      expect(original.status).toBe("voided");
      expect(reversals).toEqual([]);
    } else {
      expect(original.status).toBe("active");
      expect(reversals.map((j) => j.id)).toEqual([p.voidJournalId]);
      expect(reversals[0]?.source).toBe("payment");
      owned.add(p.voidJournalId);
    }
  }
  // 消し込みに結びつかない payment の仕訳はない
  expect(journals.filter((j) => j.source === "payment").every((j) => owned.has(j.id))).toBe(true);
}

const seen = { paid: 0, fee: 0, voided: 0, reversed: 0, withheld: 0, withheldAndFee: 0 };

describe("INV-33・INV-34・INV-74: 任意の発行・消し込み（源泉徴収税額・差額つき）・取消の列", () => {
  it("どの操作の後も、充当額（源泉徴収税額を含む）の合計 ≤ 合計、状態は残額で決まり、売掛金の残高 = 未回収の合計、事業主貸の借方 = 源泉徴収税額", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        // 取引先を「源泉徴収あり」にするか
        fc.boolean(),
        arbLedgerOps,
        // 列のどのあたりで 2025 年度を締めるか（%。締め済みの年度の取消 = 訂正仕訳の経路を含める）
        fc.nat(100),
        (taxable, withholding, ops, closePercent) => {
          const s = setupScenario({ taxable, initialSeq: 1, withholding });
          const closeAt = Math.floor((closePercent * ops.length) / 100);
          for (const [i, op] of ops.entries()) {
            if (i === closeAt) s.closeYear(2025);
            const before = snapshotOf(s.uow);
            const r = runOp(s, s.deps, op);
            if (r !== null && !r.ok) {
              // 失敗は検査のエラーだけ。何も変わらない
              expect(EXPECTED_ERRORS).toContain(r.code);
              expect(snapshotOf(s.uow)).toEqual(before);
            }
            checkInvariants(s);
          }
          for (const p of s.invoicing.state.payments) {
            seen.paid += 1;
            if (p.feeAmount > 0) seen.fee += 1;
            if (p.withholdingAmount > 0) seen.withheld += 1;
            if (p.withholdingAmount > 0 && p.feeAmount > 0) seen.withheldAndFee += 1;
            if (p.voidedAt !== null) seen.voided += 1;
            if (p.voidJournalId !== null) seen.reversed += 1;
          }
        },
      ),
      { numRuns: 150 },
    );
    // 生成した列が、消し込み・手数料・源泉徴収税額・取消・訂正仕訳の経路を実際に通っている
    expect(seen.paid).toBeGreaterThan(0);
    expect(seen.fee).toBeGreaterThan(0);
    expect(seen.withheld).toBeGreaterThan(0);
    expect(seen.withheldAndFee).toBeGreaterThan(0);
    expect(seen.voided).toBeGreaterThan(0);
    expect(seen.reversed).toBeGreaterThan(0);
  });
});

describe("INV-32（消し込み・取消）: 全部か無か", () => {
  it("任意の段階で失敗させても、消し込み（または取消の列）と仕訳の片方だけが残らない", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        arbLedgerOps,
        fc.nat(100),
        fc.array(fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }), {
          minLength: 16,
          maxLength: 16,
        }),
        (taxable, ops, closePercent, failures) => {
          const s = setupScenario({ taxable, initialSeq: 1 });
          const closeAt = Math.floor((closePercent * ops.length) / 100);
          const faulty = new FaultInjectingUnitOfWork(s.uow);
          const deps = { ...s.deps, uow: faulty };
          for (const [i, op] of ops.entries()) {
            if (i === closeAt) s.closeYear(2025);
            const before = snapshotOf(s.uow);
            faulty.failAt = failures[i] ?? null;
            try {
              const r = runOp(s, deps, op);
              if (r !== null && !r.ok) {
                expect(EXPECTED_ERRORS).toContain(r.code);
                expect(snapshotOf(s.uow)).toEqual(before);
              }
            } catch (e) {
              expect(String(e)).toMatch(/injected/);
              // 巻き戻されて何も変わらない
              expect(snapshotOf(s.uow)).toEqual(before);
            }
            faulty.failAt = null;
            checkInvariants(s);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("消し込み・消し込みの取消（直接・訂正仕訳）は書き込み 4 回。どの回で失敗させても何も残らない", () => {
    for (const closed of [false, true]) {
      const s = setupScenario({ taxable: true, initialSeq: 1 });
      const faulty = new FaultInjectingUnitOfWork(s.uow);
      const deps = { ...s.deps, uow: faulty };
      const issued = issueInvoice(
        deps,
        toInvoiceInput(
          {
            partner: 0,
            year: closed ? 2025 : 2026,
            month: 12,
            issueMonth: 12,
            issueDay: 20,
            items: [{ name: "保守", amount: 110_000, taxCategory: "SALES_10" }],
          },
          s.partnerIds,
        ),
        TODAY,
      );
      if (!issued.ok) throw new Error(JSON.stringify(issued.error));
      const invoiceId = issued.value.invoice.id;
      const pay = (failAt: number | null) => {
        faulty.failAt = failAt;
        return () =>
          recordPayment(
            deps,
            invoiceId,
            {
              receivedOn: closed ? "2025-12-25" : "2026-10-25",
              amount: 99_000,
              depositAccountId: s.accountId("普通預金"),
              treatDifferenceAsFee: true,
            },
            TODAY,
          );
      };

      for (let n = 1; n <= 4; n += 1) {
        const before = snapshotOf(s.uow);
        expect(pay(n)).toThrow(/injected/);
        expect(snapshotOf(s.uow)).toEqual(before);
        expect(s.invoicing.state.payments).toEqual([]);
      }
      const paid = pay(5)();
      if (!paid.ok) throw new Error(JSON.stringify(paid.error));
      expect(faulty.writes).toBe(4);
      expect(paid.value.payment.feeAmount).toBe(11_000);
      if (closed) s.closeYear(2025);

      for (let n = 1; n <= 4; n += 1) {
        const before = snapshotOf(s.uow);
        faulty.failAt = n;
        expect(() =>
          voidPayment(deps, invoiceId, paid.value.payment.id, { reason: "x" }, TODAY),
        ).toThrow(/injected/);
        expect(snapshotOf(s.uow)).toEqual(before);
      }
      faulty.failAt = 5;
      const voided = voidPayment(deps, invoiceId, paid.value.payment.id, { reason: "x" }, TODAY);
      expect(voided.ok).toBe(true);
      expect(faulty.writes).toBe(4);
      checkInvariants(s);
    }
  });
});
