import { describe, expect, it } from "vitest";
import { listInvoices } from "../../src/usecases/invoicing.ts";
import { invoiceRecord, setupInvoicing } from "../invoicing-setup.ts";

// 005 US1: 請求書の一覧の基本形（R14、FR-022 の一部、H:§3.5 の基本形）

const TODAY = "2026-10-31";

function seeded() {
  const t = setupInvoicing();
  const a = t.addPartner({ name: "A 社" });
  const b = t.addPartner({ name: "B 社" });
  const add = (id: string, seq: number, over: Parameters<typeof invoiceRecord>[0]) =>
    t.invoicing.insertInvoice(
      invoiceRecord({ id, invoiceNo: `X-${seq}`, seq, journalId: `j-${id}`, ...over }),
    );
  add("i1", 1, {
    partnerId: a.id,
    issueDate: "2026-09-30",
    targetMonth: "2026-09",
    total: 100_000,
  });
  add("i2", 2, {
    partnerId: b.id,
    issueDate: "2026-10-31",
    targetMonth: "2026-10",
    total: 200_000,
  });
  add("i3", 3, {
    partnerId: a.id,
    issueDate: "2026-10-31",
    targetMonth: "2026-10",
    total: 300_000,
  });
  add("i4", 4, {
    partnerId: a.id,
    issueDate: "2026-10-15",
    targetMonth: "2026-10",
    total: 400_000,
    voidedAt: "2026-10-20T00:00:00.000Z",
    voidReason: "誤り",
  });
  t.invoicing.state.payments.push({
    id: "pay-1",
    invoiceId: "i3",
    receivedOn: "2026-11-01",
    amount: 120_000,
    feeAmount: 0,
    depositAccountId: t.accountId("普通預金"),
    depositSubAccountId: null,
    journalId: "j-pay-1",
    createdAt: "2026-11-01T00:00:00.000Z",
    voidedAt: null,
    voidReason: null,
    voidJournalId: null,
  });
  return { t, a, b };
}

describe("listInvoices（基本形）", () => {
  it("発行日の降順（同じ日は seq の降順）。状態・充当額・残額つき。overdue は偽、未回収の合計は取引先ごと", () => {
    const { t, a, b } = seeded();
    const r = listInvoices(t.deps, {}, TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.invoices.map((i) => i.id)).toEqual(["i3", "i2", "i4", "i1"]);
    expect(r.value.invoices.map((i) => [i.status, i.paid, i.remaining, i.overdue])).toEqual([
      ["partial", 120_000, 180_000, false],
      ["unpaid", 0, 200_000, false],
      ["voided", 0, 0, false],
      ["unpaid", 0, 100_000, false],
    ]);
    expect(r.value.invoices[0]).toMatchObject({
      invoiceNo: "X-3",
      recipientName: "株式会社A",
      targetMonth: "2026-10",
      dueDate: "2026-11-30",
      total: 300_000,
    });
    // 取消の i4 は数えない。支払期限は 2026-11-30 なので期限切れはない
    expect(r.value.outstandingByPartner).toEqual([
      { partnerId: a.id, partnerName: "A 社", outstanding: 280_000, overdue: 0 },
      { partnerId: b.id, partnerName: "B 社", outstanding: 200_000, overdue: 0 },
    ]);
  });

  it("T018: today が支払期限の翌日から overdue。status で絞り込める（overdue を含む）", () => {
    const { t, a, b } = seeded();
    const at = (today: string, status?: "unpaid" | "partial" | "paid" | "voided" | "overdue") => {
      const r = listInvoices(t.deps, { status }, today);
      if (!r.ok) throw new Error("expected ok");
      return r.value;
    };
    expect(at("2026-11-30").invoices.every((i) => !i.overdue)).toBe(true);
    const late = at("2026-12-01");
    expect(late.invoices.map((i) => [i.id, i.overdue])).toEqual([
      ["i3", true],
      ["i2", true],
      ["i4", false],
      ["i1", true],
    ]);
    expect(late.outstandingByPartner).toEqual([
      { partnerId: a.id, partnerName: "A 社", outstanding: 280_000, overdue: 280_000 },
      { partnerId: b.id, partnerName: "B 社", outstanding: 200_000, overdue: 200_000 },
    ]);
    expect(at("2026-12-01", "overdue").invoices.map((i) => i.id)).toEqual(["i3", "i2", "i1"]);
    expect(at(TODAY, "overdue").invoices).toEqual([]);
    expect(at(TODAY, "partial").invoices.map((i) => i.id)).toEqual(["i3"]);
    expect(at(TODAY, "unpaid").invoices.map((i) => i.id)).toEqual(["i2", "i1"]);
    expect(at(TODAY, "voided").invoices.map((i) => i.id)).toEqual(["i4"]);
    expect(at(TODAY, "paid").invoices).toEqual([]);
    // 絞り込んでも未回収の合計は変わらない
    expect(at(TODAY, "paid").outstandingByPartner).toHaveLength(2);
  });

  it("取引先・対象月で絞り込める（取消の請求書は voided で残る）", () => {
    const { t, a, b } = seeded();
    const byPartner = listInvoices(t.deps, { partnerId: a.id }, TODAY);
    expect(byPartner.ok && byPartner.value.invoices.map((i) => i.id)).toEqual(["i3", "i4", "i1"]);

    const byMonth = listInvoices(t.deps, { month: "2026-10" }, TODAY);
    expect(byMonth.ok && byMonth.value.invoices.map((i) => i.id)).toEqual(["i3", "i2", "i4"]);

    const both = listInvoices(t.deps, { partnerId: b.id, month: "2026-10" }, TODAY);
    expect(both.ok && both.value.invoices.map((i) => i.id)).toEqual(["i2"]);
    const voided = listInvoices(t.deps, { partnerId: a.id, month: "2026-10" }, TODAY);
    expect(voided.ok && voided.value.invoices.map((i) => i.status)).toEqual(["partial", "voided"]);

    const none = listInvoices(t.deps, { month: "2025-01" }, TODAY);
    expect(none).toEqual({ ok: true, value: { invoices: [], outstandingByPartner: [] } });
    // 未回収の合計も partnerId・month で絞る
    expect(byPartner.ok && byPartner.value.outstandingByPartner.map((o) => o.partnerId)).toEqual([
      a.id,
    ]);
  });
});
