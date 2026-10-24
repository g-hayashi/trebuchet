import { describe, expect, it } from "vitest";
import {
  BillingTermsInput,
  ErrorCode,
  InvoiceDraftRequest,
  InvoiceInput,
  InvoiceSettingsInput,
  InvoicingVoidInput,
  PaymentInput,
  WarningCode,
  WorkHoursInput,
} from "../src/index.ts";

const ID = "0190f3a0-0000-7000-8000-000000000001";
const ID2 = "0190f3a0-0000-7000-8000-000000000002";

describe("ErrorCode（005 のコード、contracts/http-api.md §1）", () => {
  const added = [
    "INVOICE_NOT_FOUND",
    "PAYMENT_NOT_FOUND",
    "RECURRING_NOT_FOUND",
    "BILLING_TERMS_MISSING",
    "INVOICE_ISSUER_INCOMPLETE",
    "PARTNER_INACTIVE",
    "INVOICE_DUPLICATE_MONTH",
    "INVOICE_VOIDED",
    "INVOICE_HAS_PAYMENTS",
    "PAYMENT_EXCEEDS_BALANCE",
    "PAYMENT_VOIDED",
    "INVOICE_SEQ_TOO_LOW",
    "JOURNAL_LINKED",
    "RECURRING_CONFIRM_REQUIRED",
  ];
  it("追加の14種がすべて入っている", () => {
    expect(new Set(added).size).toBe(14);
    for (const code of added) expect(ErrorCode.safeParse(code).success).toBe(true);
  });
  it("警告のコードに INVOICE_DUPLICATE_MONTH が入る", () => {
    expect(WarningCode.safeParse("INVOICE_DUPLICATE_MONTH").success).toBe(true);
    expect(WarningCode.safeParse("POSSIBLE_DUPLICATE").success).toBe(true);
  });
});

describe("InvoiceSettingsInput", () => {
  const ok = {
    issuerName: "山田 太郎",
    address: "東京都千代田区1-1",
    contact: "taro@example.com",
    bankAccount: "○○銀行 △△支店 普通 1234567",
    taxDisplay: "inclusive_only",
    nextSeq: 1,
  };
  it("必須の項目だけで通る。屋号・登録番号は任意", () => {
    expect(InvoiceSettingsInput.safeParse(ok).success).toBe(true);
    expect(
      InvoiceSettingsInput.safeParse({
        ...ok,
        tradeName: "山田商店",
        registrationNumber: "T1234567890123",
        taxDisplay: "separate",
      }).success,
    ).toBe(true);
  });
  it("nextSeq は 1 以上の整数", () => {
    expect(InvoiceSettingsInput.safeParse({ ...ok, nextSeq: 0 }).success).toBe(false);
    expect(InvoiceSettingsInput.safeParse({ ...ok, nextSeq: 1.5 }).success).toBe(false);
    expect(InvoiceSettingsInput.safeParse({ ...ok, nextSeq: 12 }).success).toBe(true);
  });
  it("taxDisplay は separate・inclusive_only だけ", () => {
    expect(InvoiceSettingsInput.safeParse({ ...ok, taxDisplay: "exclusive" }).success).toBe(false);
  });
  it("登録番号は T + 13 桁", () => {
    for (const bad of [
      "1234567890123",
      "T123456789012",
      "T12345678901234",
      "T12345678901a3",
      "t1234567890123",
    ]) {
      expect(InvoiceSettingsInput.safeParse({ ...ok, registrationNumber: bad }).success).toBe(
        false,
      );
    }
  });
});

describe("BillingTermsInput", () => {
  const hourly = {
    billingType: "hourly",
    unitPrice: 5000,
    dueMonthsAfter: 1,
    dueDay: 31,
    defaultItemName: "システム開発",
  };
  const monthly = {
    billingType: "monthly",
    monthlyAmount: 300000,
    dueMonthsAfter: 1,
    dueDay: 31,
    defaultItemName: "月額保守",
  };
  it("時間単価型・月額型が通る", () => {
    expect(BillingTermsInput.safeParse(hourly).success).toBe(true);
    expect(BillingTermsInput.safeParse({ ...monthly, billingName: "株式会社A" }).success).toBe(
      true,
    );
  });
  it("hourly は unitPrice が正の整数で monthlyAmount なし", () => {
    expect(BillingTermsInput.safeParse({ ...hourly, unitPrice: undefined }).success).toBe(false);
    expect(BillingTermsInput.safeParse({ ...hourly, unitPrice: 0 }).success).toBe(false);
    expect(BillingTermsInput.safeParse({ ...hourly, unitPrice: 5000.5 }).success).toBe(false);
    expect(BillingTermsInput.safeParse({ ...hourly, monthlyAmount: 1000 }).success).toBe(false);
  });
  it("monthly は monthlyAmount が正の整数で unitPrice なし", () => {
    expect(BillingTermsInput.safeParse({ ...monthly, monthlyAmount: undefined }).success).toBe(
      false,
    );
    expect(BillingTermsInput.safeParse({ ...monthly, monthlyAmount: 0 }).success).toBe(false);
    expect(BillingTermsInput.safeParse({ ...monthly, unitPrice: 1000 }).success).toBe(false);
  });
  it("dueMonthsAfter は 0〜12", () => {
    expect(BillingTermsInput.safeParse({ ...hourly, dueMonthsAfter: 0 }).success).toBe(true);
    expect(BillingTermsInput.safeParse({ ...hourly, dueMonthsAfter: 12 }).success).toBe(true);
    expect(BillingTermsInput.safeParse({ ...hourly, dueMonthsAfter: -1 }).success).toBe(false);
    expect(BillingTermsInput.safeParse({ ...hourly, dueMonthsAfter: 13 }).success).toBe(false);
    expect(BillingTermsInput.safeParse({ ...hourly, dueMonthsAfter: 1.5 }).success).toBe(false);
  });
  it("dueDay は 1〜28 または 31。29・30 は拒否（R8）", () => {
    const ok = (dueDay: number) => BillingTermsInput.safeParse({ ...hourly, dueDay }).success;
    expect([ok(1), ok(28), ok(31)]).toEqual([true, true, true]);
    expect([ok(0), ok(29), ok(30), ok(32)]).toEqual([false, false, false, false]);
  });
  it("defaultItemName は空でない", () => {
    expect(BillingTermsInput.safeParse({ ...hourly, defaultItemName: "" }).success).toBe(false);
  });
});

describe("WorkHoursInput", () => {
  const entry = (hours: number) => ({ entries: [{ partnerId: ID, hours }] });
  it("hours は 0 以上の 0.5 の倍数", () => {
    for (const h of [0, 0.5, 1, 7.5, 160]) {
      expect(WorkHoursInput.safeParse(entry(h)).success).toBe(true);
    }
  });
  it("1.25・負数は拒否", () => {
    for (const h of [1.25, 0.1, -0.5, -1]) {
      expect(WorkHoursInput.safeParse(entry(h)).success).toBe(false);
    }
  });
  it("partnerId は UUID", () => {
    expect(WorkHoursInput.safeParse({ entries: [{ partnerId: "x", hours: 1 }] }).success).toBe(
      false,
    );
  });
});

describe("InvoiceDraftRequest", () => {
  it("month は YYYY-MM。partnerIds は任意", () => {
    expect(InvoiceDraftRequest.safeParse({ month: "2026-10" }).success).toBe(true);
    expect(InvoiceDraftRequest.safeParse({ month: "2026-10", partnerIds: [ID, ID2] }).success).toBe(
      true,
    );
    for (const bad of ["2026-13", "2026-00", "2026-1", "202610", "2026-10-01"]) {
      expect(InvoiceDraftRequest.safeParse({ month: bad }).success).toBe(false);
    }
  });
});

describe("InvoiceInput", () => {
  const item = { name: "システム開発", amount: 100000 };
  const ok = { partnerId: ID, targetMonth: "2026-10", items: [item] };
  it("最小の入力が通る。発行日・計上日・confirmDuplicate は任意", () => {
    expect(InvoiceInput.safeParse(ok).success).toBe(true);
    expect(
      InvoiceInput.safeParse({
        ...ok,
        issueDate: "2026-11-01",
        salesDate: "2026-10-31",
        confirmDuplicate: true,
      }).success,
    ).toBe(true);
  });
  it("明細は 1〜5 行", () => {
    expect(InvoiceInput.safeParse({ ...ok, items: [] }).success).toBe(false);
    expect(InvoiceInput.safeParse({ ...ok, items: Array(5).fill(item) }).success).toBe(true);
    expect(InvoiceInput.safeParse({ ...ok, items: Array(6).fill(item) }).success).toBe(false);
  });
  it("name は空でない。amount は正の整数", () => {
    expect(InvoiceInput.safeParse({ ...ok, items: [{ ...item, name: "" }] }).success).toBe(false);
    for (const amount of [0, -1, 100.5]) {
      expect(InvoiceInput.safeParse({ ...ok, items: [{ ...item, amount }] }).success).toBe(false);
    }
  });
  it("quantity は 0.5 の倍数で正", () => {
    const withQty = (quantity: number, amount: number) => ({
      ...ok,
      items: [{ name: "開発", quantity, unitPrice: 5000, unit: "時間", amount }],
    });
    expect(InvoiceInput.safeParse(withQty(0.5, 2500)).success).toBe(true);
    expect(InvoiceInput.safeParse(withQty(10, 50000)).success).toBe(true);
    expect(InvoiceInput.safeParse(withQty(0, 1)).success).toBe(false);
    expect(InvoiceInput.safeParse(withQty(-0.5, 2500)).success).toBe(false);
    expect(InvoiceInput.safeParse(withQty(1.25, 6250)).success).toBe(false);
  });
  it("数量と単価があるとき amount は floor(数量 × 単価) と一致する（切り捨て）", () => {
    const line = (quantity: number, unitPrice: number, amount: number) => ({
      ...ok,
      items: [{ name: "開発", quantity, unitPrice, amount }],
    });
    // 7.5 時間 × 3333 円 = 24997.5 → 24997
    expect(InvoiceInput.safeParse(line(7.5, 3333, 24997)).success).toBe(true);
    expect(InvoiceInput.safeParse(line(7.5, 3333, 24998)).success).toBe(false);
  });
  it("targetMonth は YYYY-MM、日付は実在する日付", () => {
    expect(InvoiceInput.safeParse({ ...ok, targetMonth: "2026-13" }).success).toBe(false);
    expect(InvoiceInput.safeParse({ ...ok, issueDate: "2026-02-30" }).success).toBe(false);
  });
});

describe("PaymentInput", () => {
  const ok = { receivedOn: "2026-11-30", amount: 108000, depositAccountId: ID };
  it("最小の入力が通る。補助科目・treatDifferenceAsFee は任意", () => {
    expect(PaymentInput.safeParse(ok).success).toBe(true);
    expect(
      PaymentInput.safeParse({ ...ok, depositSubAccountId: ID2, treatDifferenceAsFee: true })
        .success,
    ).toBe(true);
  });
  it("amount は正の整数", () => {
    for (const amount of [0, -1, 1.5]) {
      expect(PaymentInput.safeParse({ ...ok, amount }).success).toBe(false);
    }
  });
});

describe("InvoicingVoidInput（H:§1 の末尾）", () => {
  it("version なしで通る", () => {
    expect(InvoicingVoidInput.safeParse({ reason: "誤発行" }).success).toBe(true);
  });
  it("reason なしで落ちる", () => {
    expect(InvoicingVoidInput.safeParse({}).success).toBe(false);
    expect(InvoicingVoidInput.safeParse({ version: 1 }).success).toBe(false);
  });
});
