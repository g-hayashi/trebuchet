import { getInvoiceDetail, issueInvoice } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempDataDir, TODAY, useTempDataDir } from "../src/testing.ts";
import { setupInvoicingDb } from "./invoicing-db-setup.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("invoicing-price-mode");
});
afterEach(() => tmp.cleanup());

describe("請求の入力方式の保存", () => {
  it("条件の税込/税抜と10/8/null/未指定を上書きして読み戻せる", () => {
    const t = setupInvoicingDb();
    const partner = t.addPartner("合成取引先");
    for (const priceMode of ["inclusive", "exclusive"] as const) {
      for (const taxRate of [10, 8, null, undefined] as const) {
        t.setTerms(partner.id, { priceMode, ...(taxRate === undefined ? {} : { taxRate }) });
        const read = t.store.getBillingTerms(partner.id);
        expect(read).toMatchObject({ priceMode });
        expect(read?.taxRate).toBe(taxRate);
        if (taxRate === undefined) expect(read).not.toHaveProperty("taxRate");
        expect(t.store.listBillingTerms()).toEqual([read]);
        expect(t.db.$client.prepare("SELECT tax_rate FROM partner_billing_terms").get()).toEqual({
          tax_rate: taxRate === undefined ? -1 : taxRate,
        });
      }
    }
  });
  it("免税の税抜発行→再読込でも198000、条件変更後も方式・内訳・登録番号抑止を保持", () => {
    const t = setupInvoicingDb();
    const p = t.addPartner("合成取引先");
    t.setSettings({ registrationNumber: "T1234567890123" });
    t.setTerms(p.id, { priceMode: "exclusive", taxRate: 10 });
    const r = issueInvoice(
      t.deps,
      {
        partnerId: p.id,
        targetMonth: "2026-10",
        priceMode: "exclusive",
        items: [{ name: "業務", quantity: 30, unitPrice: 6000, amount: 180000, taxRate: 10 }],
      },
      TODAY,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.invoice).toMatchObject({
      priceMode: "exclusive",
      total: 198000,
      issuer: { registrationNumber: null },
      taxBreakdown: [{ rate: 10, inclusive: 198000, exclusive: 180000, tax: 18000 }],
    });
    expect(
      t.ledger.getJournal(r.value.journal.id)?.lines.filter((l) => l.side === "credit"),
    ).toMatchObject([{ amount: 198000, taxAmount: 0, taxCategory: "OUT_OF_SCOPE" }]);
    t.setTerms(p.id, { priceMode: "inclusive", taxRate: 8 });
    t.setSettings({ taxDisplay: "inclusive_only", nextSeq: 2 });
    expect(getInvoiceDetail(t.deps, r.value.invoice.id, TODAY)).toEqual({
      ok: true,
      value: r.value.invoice,
    });
    expect(t.store.getInvoice(r.value.invoice.id)?.priceMode).toBe("exclusive");
    expect(() =>
      t.db.$client
        .prepare("UPDATE invoices SET price_mode = 'inclusive' WHERE id = ?")
        .run(r.value.invoice.id),
    ).toThrow(/immutable|snapshot|cannot|only/);
  });
  it("条件の方式と請求税率のCHECKは不正な値を拒否する", () => {
    const t = setupInvoicingDb();
    const p = t.addPartner("合成取引先");
    t.setTerms(p.id);
    expect(t.store.getBillingTerms(p.id)?.priceMode).toBe("inclusive");
    expect(() =>
      t.db.$client.prepare("UPDATE partner_billing_terms SET price_mode = 'other'").run(),
    ).toThrow(/CHECK/);
    expect(() =>
      t.db.$client.prepare("UPDATE partner_billing_terms SET tax_rate = 7").run(),
    ).toThrow(/CHECK/);
  });
});
