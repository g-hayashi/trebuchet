import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatInvoiceNo } from "../src/invoicing/number.ts";
import type { Journal } from "../src/types.ts";
import {
  getInvoiceDetail,
  getInvoiceSettings,
  issueInvoice,
  saveBillingTerms,
  saveInvoiceSettings,
  saveWorkHours,
} from "../src/usecases/invoicing.ts";
import { FaultInjectingUnitOfWork, snapshotOf } from "./fault-injection.ts";
import {
  arbChanges,
  arbIssueSpec,
  arbIssueSpecs,
  toInvoiceInput,
} from "./invoicing-arbitraries.ts";
import { setupScenario } from "./invoicing-setup.ts";

// 005 US1: 発行の不変条件（data-model §4 の INV-30・31・32・38）

const TODAY = "2026-10-31";

type Scenario = ReturnType<typeof setupScenario>;

/** 発行して、失敗したら例外にする */
function issue(s: Scenario, spec: Parameters<typeof toInvoiceInput>[0]) {
  const r = issueInvoice(s.deps, toInvoiceInput(spec, s.partnerIds), TODAY);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const RATE: Record<string, number | null> = { SALES_10: 10, SALES_8R: 8, OUT_OF_SCOPE: null };

describe("INV-30: 合計 = Σ明細 = 借方 売掛金 = Σ貸方 売上高。税額は税率ごとの内訳と一致", () => {
  it("任意の条件・工数・明細・税の設定の発行で成り立つ", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 1, max: 2000 }),
        arbIssueSpecs,
        (taxable, seq, specs) => {
          const s = setupScenario({ taxable, initialSeq: seq });
          const receivable = s.accountId("売掛金");
          const sales = s.accountId("売上高");
          for (const spec of specs) {
            const { invoice, journal } = issue(s, spec);
            const items = s.invoicing.listInvoiceItems(invoice.id);
            const sum = items.reduce((a, i) => a + i.amount, 0);
            expect(invoice.total).toBe(sum);

            const saved = s.ledger.getJournal(journal.id) as Journal;
            expect(saved.source).toBe("invoice");
            expect(saved.status).toBe("active");
            expect(saved.id).toBe(invoice.journalId);
            expect(saved.date).toBe(invoice.salesDate);
            // 借方は売掛金 1 行、貸方は売上高だけ
            const debits = saved.lines.filter((l) => l.side === "debit");
            const credits = saved.lines.filter((l) => l.side === "credit");
            expect(debits).toHaveLength(1);
            expect(debits[0]).toMatchObject({ accountId: receivable, amount: invoice.total });
            expect(credits.every((l) => l.accountId === sales)).toBe(true);
            expect(credits.reduce((a, l) => a + l.amount, 0)).toBe(invoice.total);
            // 全行の取引先は請求書の取引先
            expect(saved.lines.every((l) => l.partnerId === invoice.partnerId)).toBe(true);

            // 税区分ごとの貸方の tax_amount = その税率の明細の合計に対する floor(合計 × r / (100 + r))
            const byCategory = new Map<string, number>();
            for (const item of items) {
              byCategory.set(
                item.taxCategory,
                (byCategory.get(item.taxCategory) ?? 0) + item.amount,
              );
            }
            expect(credits).toHaveLength(byCategory.size);
            for (const line of credits) {
              const inclusive = byCategory.get(line.taxCategory);
              expect(inclusive).toBe(line.amount);
              const rate = taxable ? (RATE[line.taxCategory] ?? null) : null;
              const expected = rate === null ? 0 : Math.floor((line.amount * rate) / (100 + rate));
              expect(line.taxAmount).toBe(expected);
            }
            // 別記の内訳（詳細の taxBreakdown）の税額 = 仕訳の貸方の税額の、税率ごとの合計
            for (const row of invoice.taxBreakdown) {
              const fromJournal = credits
                .filter((l) => (taxable ? RATE[l.taxCategory] : null) === row.rate)
                .reduce((a, l) => a + l.taxAmount, 0);
              expect(row.tax).toBe(fromJournal);
              expect(row.exclusive + row.tax).toBe(row.inclusive);
            }
            const detail = getInvoiceDetail(s.deps, invoice.id, TODAY);
            expect(detail).toEqual({ ok: true, value: invoice });
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("INV-31: seq・番号は重複せず発行の順に増え、next_seq > max(seq)", () => {
  it("任意の開始の通し番号と発行の列で成り立つ", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2000 }), arbIssueSpecs, (initialSeq, specs) => {
        const s = setupScenario({ taxable: false, initialSeq });
        const issued = specs.map((spec) => issue(s, spec).invoice);
        const records = s.invoicing.state.invoices;

        expect(records.map((r) => r.seq)).toEqual(issued.map((_, i) => initialSeq + i));
        expect(new Set(records.map((r) => r.invoiceNo)).size).toBe(records.length);
        for (const r of records) expect(r.invoiceNo).toBe(formatInvoiceNo(r.issueDate, r.seq));
        const max = Math.max(...records.map((r) => r.seq));
        const settings = getInvoiceSettings(s.deps);
        if (!settings.ok) throw new Error("expected ok");
        expect(settings.value.settings?.nextSeq).toBe(max + 1);
        expect(settings.value.minimumNextSeq).toBe(max + 1);
      }),
      { numRuns: 60 },
    );
  });

  it("発行済みの最大以下の次の通し番号には変えられない（番号の再利用の防止）", () => {
    const s = setupScenario({ taxable: false, initialSeq: 43 });
    issue(s, {
      partner: 0,
      year: 2026,
      month: 10,
      issueMonth: 10,
      issueDay: 28,
      items: [{ name: "保守", amount: 1000 }],
    });
    const lower = saveInvoiceSettings(s.deps, {
      issuerName: "山田 太郎",
      address: "東京都",
      contact: "c",
      bankAccount: "b",
      taxDisplay: "separate",
      nextSeq: 43,
    });
    expect(!lower.ok && lower.error.code).toBe("INVOICE_SEQ_TOO_LOW");
  });
});

describe("INV-32: 発行は全部か無か（障害の注入）", () => {
  const spec = {
    partner: 0,
    year: 2026 as const,
    month: 10,
    issueMonth: 10,
    issueDay: 28,
    items: [{ name: "保守", quantityHalves: 3, unitPrice: 1000, taxCategory: "SALES_10" as const }],
  };

  it("発行の書き込みは 6 回（仕訳 2、設定、請求書、明細、記録）。どの回で失敗させても何も残らない", () => {
    const s = setupScenario({ taxable: true, initialSeq: 5 });
    const faulty = new FaultInjectingUnitOfWork(s.uow);
    const deps = { ...s.deps, uow: faulty };
    const input = toInvoiceInput(spec, s.partnerIds);

    // 失敗させずに書き込みの回数を数える（別の事業体で）
    const probe = setupScenario({ taxable: true, initialSeq: 5 });
    const probeUow = new FaultInjectingUnitOfWork(probe.uow);
    const ok = issueInvoice(
      { ...probe.deps, uow: probeUow },
      toInvoiceInput(spec, probe.partnerIds),
      TODAY,
    );
    expect(ok.ok).toBe(true);
    const total = probeUow.writes;
    expect(total).toBe(6);

    for (let n = 1; n <= total; n += 1) {
      const before = snapshotOf(s.uow);
      faulty.failAt = n;
      expect(() => issueInvoice(deps, input, TODAY)).toThrow(/injected/);
      expect(snapshotOf(s.uow)).toEqual(before);
    }
    faulty.failAt = total + 1;
    expect(issueInvoice(deps, input, TODAY).ok).toBe(true);
    expect(s.invoicing.state.invoices).toHaveLength(1);
    expect(s.ledger.journals).toHaveLength(1);
  });

  it("任意の発行の列の任意の段階で失敗させても、請求書 ⇔ 仕訳の対応と next_seq が保たれる", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        arbIssueSpecs,
        fc.array(fc.option(fc.integer({ min: 1, max: 8 }), { nil: null }), {
          minLength: 8,
          maxLength: 8,
        }),
        (taxable, specs, failures) => {
          const s = setupScenario({ taxable, initialSeq: 1 });
          const faulty = new FaultInjectingUnitOfWork(s.uow);
          const deps = { ...s.deps, uow: faulty };
          let succeeded = 0;
          for (const [i, issueSpec] of specs.entries()) {
            const input = toInvoiceInput(issueSpec, s.partnerIds);
            const before = snapshotOf(s.uow);
            faulty.failAt = failures[i] ?? null;
            let result: ReturnType<typeof issueInvoice> | undefined;
            try {
              result = issueInvoice(deps, input, TODAY);
            } catch (e) {
              expect(String(e)).toMatch(/injected/);
              expect(snapshotOf(s.uow)).toEqual(before);
            }
            faulty.failAt = null;
            if (result !== undefined) {
              if (!result.ok) throw new Error(JSON.stringify(result.error));
              succeeded += 1;
            }
          }
          const invoices = s.invoicing.state.invoices;
          const journals = s.ledger.journals.filter((j) => j.source === "invoice");
          expect(invoices).toHaveLength(succeeded);
          expect(journals).toHaveLength(succeeded);
          // 請求書があること ⇔ 対応する仕訳があること
          expect(invoices.map((i) => i.journalId).sort()).toEqual(journals.map((j) => j.id).sort());
          // 通し番号は成功した発行の数だけ進む
          expect(s.invoicing.state.settings?.nextSeq).toBe(1 + succeeded);
          expect(invoices.map((i) => i.seq)).toEqual(invoices.map((_, i) => 1 + i));
          // 明細も請求書があるものだけ
          const ids = new Set(invoices.map((i) => i.id));
          expect(s.invoicing.state.items.every((it) => ids.has(it.invoiceId))).toBe(true);
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe("INV-38: 発行済みの請求書の写しは、設定・条件・工数・取引先の変更で変わらない", () => {
  it("任意の変更の後も詳細（宛名・発行者・税の表示・支払期限・明細・合計）が同じ", () => {
    fc.assert(
      fc.property(fc.boolean(), arbIssueSpec, arbChanges, (taxable, spec, changes) => {
        const s = setupScenario({ taxable, initialSeq: 1 });
        const { invoice } = issue(s, spec);
        const before = getInvoiceDetail(s.deps, invoice.id, TODAY);
        expect(before).toEqual({ ok: true, value: invoice });

        for (const change of changes) {
          const partnerId = (i: number) => s.partnerIds[i] ?? "";
          switch (change.kind) {
            case "settings": {
              const current = getInvoiceSettings(s.deps);
              if (!current.ok) throw new Error("expected ok");
              saveInvoiceSettings(s.deps, {
                issuerName: change.issuerName,
                ...(change.tradeName === undefined ? {} : { tradeName: change.tradeName }),
                address: change.address,
                contact: "changed@example.com",
                bankAccount: change.bankAccount,
                taxDisplay: change.taxDisplay,
                nextSeq: current.value.minimumNextSeq + change.seqBump,
              });
              break;
            }
            case "terms":
              saveBillingTerms(s.deps, partnerId(change.partner), {
                billingType: "hourly",
                unitPrice: change.unitPrice,
                dueMonthsAfter: 3,
                dueDay: change.dueDay,
                defaultItemName: change.defaultItemName,
                ...(change.billingName === undefined ? {} : { billingName: change.billingName }),
              });
              break;
            case "hours":
              saveWorkHours(s.deps, `${spec.year}-${String(spec.month).padStart(2, "0")}`, {
                entries: [{ partnerId: partnerId(change.partner), hours: change.halfHours / 2 }],
              });
              break;
            case "partner":
              s.masters.updatePartner({
                id: partnerId(change.partner),
                name: change.name,
                honorific: change.honorific,
                memo: null,
                isActive: change.isActive,
              });
              break;
          }
        }
        expect(getInvoiceDetail(s.deps, invoice.id, TODAY)).toEqual(before);
      }),
      { numRuns: 60 },
    );
  });
});
