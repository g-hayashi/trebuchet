import { describe, expect, it } from "vitest";
import { fakeInvoicingUnitOfWork } from "./fakes.ts";

// 巻き戻し（例外・err・ok）は fake-unit-of-work.test.ts の全機能共通の契約で確かめる

describe("fakeInvoicingUnitOfWork", () => {
  it("originOfJournal は登録した起点を返し、ない仕訳は null", () => {
    const uow = fakeInvoicingUnitOfWork();
    uow.invoicing.registerOrigin("j-1", {
      kind: "payment",
      invoiceId: "inv-1",
      invoiceNo: "2026-1031-001",
      paymentId: "pay-1",
    });
    expect(uow.invoicing.originOfJournal("j-1")).toEqual({
      kind: "payment",
      invoiceId: "inv-1",
      invoiceNo: "2026-1031-001",
      paymentId: "pay-1",
    });
    expect(uow.invoicing.originOfJournal("j-2")).toBeNull();
  });
});
