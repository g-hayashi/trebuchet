import { invoiceStatus } from "../src/invoicing/status.ts";
import {
  type InvoicingDeps,
  issueInvoice,
  recordPayment,
  voidInvoice,
  voidPayment,
} from "../src/usecases/invoicing.ts";
import { type LedgerOp, toInvoiceInput } from "./invoicing-arbitraries.ts";
import type { setupScenario } from "./invoicing-setup.ts";
import { TODAY } from "./test-dates.ts";

// 性質テスト共通: `LedgerOp`（invoicing-arbitraries.ts）を 1 つ実行する

const pad = (n: number) => String(n).padStart(2, "0");

export type Scenario = ReturnType<typeof setupScenario>;

/** 操作を実行する。対象がない操作は null（何もしない）。検査のエラーは `{ ok: false, code }` */
export function runOp(
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
