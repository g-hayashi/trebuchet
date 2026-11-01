import { InvoiceCalculationInput, InvoiceInput } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { calculateInvoiceAmounts } from "../../src/invoicing/amounts.ts";
import { buildInvoiceDraft } from "../../src/invoicing/draft.ts";
import { loadContext } from "../../src/usecases/create-journal.ts";
import { getInvoiceDetail, issueInvoice, saveBillingTerms } from "../../src/usecases/invoicing.ts";
import { setupInvoicing } from "../invoicing-setup.ts";
import { TODAY } from "../test-dates.ts";

function ready(taxable = false) {
  const t = setupInvoicing({ taxable });
  const partner = t.addPartner();
  t.setSettings({ registrationNumber: "T1234567890123" });
  const terms = t.setTerms(partner.id, { unitPrice: 6000, priceMode: "exclusive", taxRate: 10 });
  const input = { partnerId: partner.id, targetMonth: "2026-10", priceMode: "exclusive" as const,
    items: [{ name: "業務", quantity: 30, unitPrice: 6000, amount: 180000, taxRate: 10 as const }] };
  return { ...t, partner, terms, input };
}

describe("請求の入力方式と消費税相当額", () => {
  it("税率ごとに合算して一度切り捨て、対象外も合計に含める", () => {
    expect(calculateInvoiceAmounts([
      { amount: 9, taxRate: 10 }, { amount: 9, taxRate: 10 },
      { amount: 13, taxRate: 8 }, { amount: 13, taxRate: 8 }, { amount: 5, taxRate: null },
    ], "exclusive")).toEqual({ subtotal: 49, total: 52, taxBreakdown: [
      { rate: 10, inclusive: 19, exclusive: 18, tax: 1 },
      { rate: 8, inclusive: 28, exclusive: 26, tax: 2 },
    ] });
  });
  it("税込入力の合計は加算しない（性質）", () => {
    fc.assert(fc.property(fc.array(fc.record({amount: fc.integer({min:1,max:1000000}),taxRate:fc.constantFrom(10,8,null)}),{minLength:1,maxLength:5}), items => {
      expect(calculateInvoiceAmounts(items, "inclusive").total).toBe(items.reduce((s,i)=>s+i.amount,0));
    }));
  });
  it("条件の税抜方式と税率で案を作る", () => {
    const t = ready();
    const outcome = buildInvoiceDraft({ terms:t.terms, partner:t.partner, halfHours:60, month:"2026-10",settings:t.invoicing.getInvoiceSettings(),today:TODAY,activeInvoices:[],ctx:loadContext(t.masters) });
    expect(outcome).toMatchObject({kind:"draft",draft:{priceMode:"exclusive", total:198000,taxDisplay:"separate",items:[{amount:180000,taxRate:10,taxCategory:"OUT_OF_SCOPE"}]}});
  });
  it("免税でも税抜6000×30は198000、全額売上・税額0、登録番号なし。写しは条件変更で変わらない", () => {
    const t = ready();
    const r = issueInvoice(t.deps,t.input,TODAY);
    expect(r.ok).toBe(true);
    if(!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.invoice).toMatchObject({priceMode:"exclusive",total:198000,taxDisplay:"separate",issuer:{registrationNumber:null},items:[{amount:180000,unitPrice:6000,taxRate:10,taxCategory:"OUT_OF_SCOPE"}],taxBreakdown:[{rate:10,exclusive:180000,tax:18000,inclusive:198000}]});
    expect(r.value.journal.lines.filter(l=>l.side==="credit")).toMatchObject([{amount:198000,taxCategory:"OUT_OF_SCOPE",taxAmount:0}]);
    t.setTerms(t.partner.id,{priceMode:"inclusive",taxRate:8});
    t.setSettings({taxDisplay:"inclusive_only"});
    expect(getInvoiceDetail(t.deps,r.value.invoice.id,TODAY)).toEqual({ok:true,value:r.value.invoice});
  });
  it("方式省略は現在の条件にかかわらず税込180000のまま", () => {
    const t=ready();
    const {priceMode:_,...input}=t.input;
    const r=issueInvoice(t.deps,input,TODAY);
    expect(r.ok && r.value.invoice).toMatchObject({priceMode:"inclusive",total:180000});
  });
  it("免税の8/10/null混在は税率別に丸めてから対象外で合算する",()=>{
    const t=ready();
    const r=issueInvoice(t.deps,{...t.input,items:[{name:"A",amount:9,taxRate:10},{name:"B",amount:9,taxRate:8},{name:"C",amount:9,taxRate:null}]},TODAY);
    expect(r.ok && r.value.invoice.total).toBe(27);
    expect(r.ok && r.value.journal.lines.filter(l=>l.side==="credit")).toMatchObject([{amount:27,taxCategory:"OUT_OF_SCOPE",taxAmount:0}]);
  });
  it("課税では明示税率と税区分の矛盾を拒否し、書き込まない",()=>{
    for(const taxRate of [8,null] as const){
      const t=ready(true);
      const r=issueInvoice(t.deps,{...t.input,items:[{name:"A",amount:100,taxCategory:"SALES_10",taxRate}]},TODAY);
      expect(!r.ok && r.error.code).toBe("VALIDATION");
      expect(t.ledger.journals).toEqual([]);
      expect(t.invoicing.state.invoices).toEqual([]);
      expect(t.invoicing.getInvoiceSettings()?.nextSeq).toBe(1);
    }
  });
  it("税抜計算で上限を超えれば仕訳・採番・請求を保存しない",()=>{
    const t=ready();
    const r=issueInvoice(t.deps,{...t.input,items:[{name:"A",amount:999999999999,taxRate:10}]},TODAY);
    expect(!r.ok && r.error.code).toBe("VALIDATION");
    expect(t.ledger.journals).toEqual([]);
    expect(t.invoicing.state.invoices).toEqual([]);
    expect(t.invoicing.getInvoiceSettings()?.nextSeq).toBe(1);
  });
  it("条件の方式・税率を保存し、省略は税込・税率未指定",()=>{
    const t=ready();
    const r=saveBillingTerms(t.deps,t.partner.id,{billingType:"hourly",unitPrice:6000,dueMonthsAfter:1,dueDay:31,defaultItemName:"業務",priceMode:"exclusive",taxRate:8});
    expect(r.ok && r.value).toMatchObject({priceMode:"exclusive",taxRate:8});
  });
  it("入力契約は税率と方式を検査する",()=>{
    expect(InvoiceInput.parse(ready().input)).toMatchObject({priceMode:"exclusive",items:[{taxRate:10}]});
    expect(InvoiceCalculationInput.safeParse({priceMode:"exclusive",items:[{amount:100,taxRate:7}]}).success).toBe(false);
    expect(InvoiceCalculationInput.safeParse({priceMode:"exclusive",items:[]}).success).toBe(false);
  });
});
