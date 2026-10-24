import { describe, expect, it } from "vitest";
import { invoiceStatus } from "../../src/invoicing/status.ts";

// 005 US1: 状態と残額の純関数（R14・FR-020。INV-33 の状態の部分）

const invoice = (over: { total?: number; voidedAt?: string | null } = {}) => ({
  total: 1_205_000,
  voidedAt: null,
  ...over,
});
const payment = (amount: number, feeAmount = 0, voidedAt: string | null = null) => ({
  amount,
  feeAmount,
  voidedAt,
});

describe("invoiceStatus", () => {
  it("消し込みがなければ unpaid、paid = 0、remaining = total", () => {
    expect(invoiceStatus(invoice(), [])).toEqual({
      status: "unpaid",
      paid: 0,
      remaining: 1_205_000,
    });
  });

  it("一部入金なら partial。残額は total − 充当額", () => {
    expect(invoiceStatus(invoice(), [payment(500_000)])).toEqual({
      status: "partial",
      paid: 500_000,
      remaining: 705_000,
    });
  });

  it("充当額 = 入金額 + 手数料。全額の充当で paid（手数料の差額を含む。US2 Acceptance 2）", () => {
    expect(invoiceStatus(invoice(), [payment(1_204_340, 660)])).toEqual({
      status: "paid",
      paid: 1_205_000,
      remaining: 0,
    });
  });

  it("複数回の入金の合計で paid になる", () => {
    expect(invoiceStatus(invoice(), [payment(200_000), payment(1_005_000)])).toMatchObject({
      status: "paid",
      remaining: 0,
    });
  });

  it("取消済みの消し込みは数えない", () => {
    const r = invoiceStatus(invoice(), [
      payment(1_205_000, 0, "2026-11-05T00:00:00.000Z"),
      payment(100_000),
    ]);
    expect(r).toEqual({ status: "partial", paid: 100_000, remaining: 1_105_000 });
    expect(
      invoiceStatus(invoice(), [payment(1_205_000, 0, "2026-11-05T00:00:00.000Z")]).status,
    ).toBe("unpaid");
  });

  it("取消の請求書は voided。残額は 0（未回収に数えない）", () => {
    expect(invoiceStatus(invoice({ voidedAt: "2026-11-01T00:00:00.000Z" }), [])).toEqual({
      status: "voided",
      paid: 0,
      remaining: 0,
    });
  });
});
