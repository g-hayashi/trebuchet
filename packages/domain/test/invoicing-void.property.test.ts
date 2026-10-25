import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Journal } from "../src/types.ts";
import { issueInvoice, voidInvoice } from "../src/usecases/invoicing.ts";
import { FaultInjectingUnitOfWork, snapshotOf } from "./fault-injection.ts";
import { arbOps, toInvoiceInput } from "./invoicing-arbitraries.ts";
import { setupScenario } from "./invoicing-setup.ts";

// 005 US1: 取消の不変条件（INV-31 の取消した番号の再利用なし、INV-32 の取消）

const TODAY = "2026-10-31";

describe("INV-32（取消）: 取消は全部か無か", () => {
  it("任意の発行・取消の列の任意の段階で失敗させても、請求書の取消の列と仕訳の取消（または訂正仕訳）の片方だけが残らない", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 1, max: 500 }),
        arbOps,
        // 何番目の操作の前に 2025 年度を締めるか（締め済みの年度の取消 = 訂正仕訳の経路を含める）
        fc.integer({ min: 0, max: 12 }),
        fc.array(fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }), {
          minLength: 12,
          maxLength: 12,
        }),
        (taxable, initialSeq, ops, closeAt, failures) => {
          const s = setupScenario({ taxable, initialSeq });
          const faulty = new FaultInjectingUnitOfWork(s.uow);
          const deps = { ...s.deps, uow: faulty };
          const issued: string[] = [];
          let issuedCount = 0;

          for (const [i, op] of ops.entries()) {
            if (i === closeAt) s.closeYear(2025);
            const before = snapshotOf(s.uow);
            faulty.failAt = failures[i] ?? null;
            let result: { ok: boolean; error?: { code: string }; invoiceId?: string } | undefined;
            try {
              if (op.kind === "issue") {
                const r = issueInvoice(deps, toInvoiceInput(op.spec, s.partnerIds), TODAY);
                result = r.ok
                  ? { ok: true, invoiceId: r.value.invoice.id }
                  : { ok: false, error: r.error };
              } else {
                const target = issued[op.target % Math.max(issued.length, 1)];
                if (target === undefined) continue;
                const r = voidInvoice(deps, target, { reason: op.reason }, TODAY);
                result = r.ok ? { ok: true } : { ok: false, error: r.error };
              }
            } catch (e) {
              expect(String(e)).toMatch(/injected/);
              // 巻き戻されて何も変わらない
              expect(snapshotOf(s.uow)).toEqual(before);
            }
            faulty.failAt = null;

            if (result === undefined) continue;
            if (result.ok) {
              if (op.kind === "issue" && result.invoiceId !== undefined) {
                issued.push(result.invoiceId);
                issuedCount += 1;
              }
            } else {
              // 失敗は検査のエラーだけ。何も変わらない
              expect(["PERIOD_CLOSED", "INVOICE_VOIDED"]).toContain(result.error?.code);
              expect(snapshotOf(s.uow)).toEqual(before);
            }
          }
          faulty.failAt = null;

          const invoices = s.invoicing.state.invoices;
          const journals = s.ledger.journals;
          expect(invoices).toHaveLength(issuedCount);

          // 通し番号は発行に成功した分だけ進み、取消しても再利用されない（INV-31）
          expect(invoices.map((inv) => inv.seq)).toEqual(invoices.map((_, k) => initialSeq + k));
          expect(s.invoicing.state.settings?.nextSeq).toBe(initialSeq + issuedCount);
          expect(new Set(invoices.map((inv) => inv.invoiceNo)).size).toBe(invoices.length);

          for (const inv of invoices) {
            const original = journals.find((j) => j.id === inv.journalId) as Journal;
            expect(original).toBeDefined();
            expect(original.source).toBe("invoice");
            const reversals = journals.filter((j) => j.correctsJournalId === inv.journalId);
            if (inv.voidedAt === null) {
              // 取消でない請求書: 仕訳は有効のまま、訂正仕訳もない
              expect(inv.voidReason).toBeNull();
              expect(inv.voidJournalId).toBeNull();
              expect(original.status).toBe("active");
              expect(reversals).toEqual([]);
            } else {
              expect(inv.voidReason).not.toBeNull();
              if (inv.voidJournalId === null) {
                // 直接の取消: 元の仕訳が取消済み、訂正仕訳はない
                expect(original.status).toBe("voided");
                expect(reversals).toEqual([]);
              } else {
                // 締め済みの年度: 元の仕訳は変わらず、貸借を逆にした訂正仕訳が 1 件
                expect(original.status).toBe("active");
                expect(reversals.map((j) => j.id)).toEqual([inv.voidJournalId]);
                const reversal = reversals[0] as Journal;
                expect(reversal.source).toBe("invoice");
                expect(reversal.status).toBe("active");
                const net = (lines: Journal["lines"]) =>
                  lines.reduce((a, l) => a + (l.side === "debit" ? l.amount : -l.amount), 0);
                expect(net(original.lines) + net(reversal.lines)).toBe(0);
                // 科目ごとの貸借が打ち消し合う
                const byAccount = new Map<string, number>();
                for (const l of [...original.lines, ...reversal.lines]) {
                  byAccount.set(
                    l.accountId,
                    (byAccount.get(l.accountId) ?? 0) + (l.side === "debit" ? l.amount : -l.amount),
                  );
                }
                expect([...byAccount.values()].every((v) => v === 0)).toBe(true);
              }
            }
          }
          // 請求書に結びつかない invoice の仕訳はない（請求書 ⇔ 仕訳）
          const owned = new Set(
            invoices.flatMap((inv) => [inv.journalId, inv.voidJournalId].filter((x) => x !== null)),
          );
          expect(journals.filter((j) => j.source === "invoice").every((j) => owned.has(j.id))).toBe(
            true,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("取消は書き込み 4 回（仕訳 2、請求書の取消、記録）。直接の取消も訂正仕訳もどの回で失敗させても何も残らない", () => {
    for (const closed of [false, true]) {
      const s = setupScenario({ taxable: true, initialSeq: 1 });
      const faulty = new FaultInjectingUnitOfWork(s.uow);
      const deps = { ...s.deps, uow: faulty };
      const r = issueInvoice(
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
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      const id = r.value.invoice.id;
      if (closed) s.closeYear(2025);

      for (let n = 1; n <= 4; n += 1) {
        const before = snapshotOf(s.uow);
        faulty.failAt = n;
        expect(() => voidInvoice(deps, id, { reason: "x" }, TODAY)).toThrow(/injected/);
        expect(snapshotOf(s.uow)).toEqual(before);
      }
      faulty.failAt = 5;
      expect(voidInvoice(deps, id, { reason: "x" }, TODAY).ok).toBe(true);
      expect(faulty.writes).toBe(4);
    }
  });
});
