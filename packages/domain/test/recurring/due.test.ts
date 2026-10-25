import type { Recurring } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { planRecurringRuns, type RecurringContext } from "../../src/recurring/due.ts";
import { loadContext } from "../../src/usecases/create-journal.ts";
import { setupInvoicing } from "../invoicing-setup.ts";
import { MONTH_START_NOW } from "../test-dates.ts";

// R17: 回の計画（blocked の理由を含む）。INV-35 の純関数の部分は recurring-plan.property.test.ts

const NOW = MONTH_START_NOW;

function setup(options: { taxable?: boolean } = {}) {
  const t = setupInvoicing({ taxable: options.taxable ?? true });
  const partner = t.addPartner();
  const ctx: RecurringContext = loadContext(t.masters);
  const def = (over: Partial<Recurring> = {}): Recurring => ({
    id: "rec-1",
    name: "家賃",
    memo: "事務所の家賃",
    dayOfMonth: 25,
    startMonth: "2026-08",
    endMonth: null,
    status: "active",
    version: 1,
    lines: [
      {
        lineNo: 1,
        side: "debit",
        accountId: t.accountId("地代家賃"),
        subAccountId: null,
        amount: 80_000,
        taxCategory: null,
        partnerId: partner.id,
        description: null,
      },
      {
        lineNo: 2,
        side: "credit",
        accountId: t.accountId("普通預金"),
        subAccountId: null,
        amount: 80_000,
        taxCategory: null,
        partnerId: null,
        description: null,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  return { ...t, partner, ctx, def };
}

const plan = (
  t: ReturnType<typeof setup>,
  today: string,
  over: Partial<Recurring> = {},
  doneMonths: string[] = [],
  ctx: RecurringContext = t.ctx,
) => planRecurringRuns({ def: t.def(over), today, doneMonths, ctx });

describe("planRecurringRuns: 対象の月", () => {
  it("開始 8 月・25 日・10 月 26 日なら 8・9・10 月の 25 日付の 3 件（US3 Acceptance 1）", () => {
    const t = setup();
    const r = plan(t, "2026-10-26");
    expect(r.blocked).toEqual([]);
    expect(r.post.map((p) => [p.month, p.date, p.draft.date])).toEqual([
      ["2026-08", "2026-08-25", "2026-08-25"],
      ["2026-09", "2026-09-25", "2026-09-25"],
      ["2026-10", "2026-10-25", "2026-10-25"],
    ]);
    expect(r.post[0]?.draft.memo).toBe("事務所の家賃");
    expect(r.post[0]?.draft.lines).toHaveLength(2);
  });

  it("予定日の当日から対象になる。前日は対象外", () => {
    const t = setup();
    expect(plan(t, "2026-10-25").post.map((p) => p.month)).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    expect(plan(t, "2026-10-24").post.map((p) => p.month)).toEqual(["2026-08", "2026-09"]);
  });

  it("開始月の予定日より前なら空", () => {
    const t = setup();
    expect(plan(t, "2026-08-24")).toEqual({ post: [], blocked: [] });
  });

  it("終了月までで止まる", () => {
    const t = setup();
    const r = plan(t, "2026-12-31", { endMonth: "2026-09" });
    expect(r.post.map((p) => p.month)).toEqual(["2026-08", "2026-09"]);
  });

  it("登録済み・飛ばした月（doneMonths）は含めない", () => {
    const t = setup();
    const r = plan(t, "2026-10-26", {}, ["2026-09"]);
    expect(r.post.map((p) => p.month)).toEqual(["2026-08", "2026-10"]);
  });

  it("停止中は空", () => {
    const t = setup();
    expect(plan(t, "2026-10-26", { status: "paused" })).toEqual({ post: [], blocked: [] });
  });

  it("末日の定義は月ごとの末日付になる（Acceptance 3）", () => {
    const t = setup();
    const r = plan(t, "2027-01-31", { dayOfMonth: 31, startMonth: "2026-10", endMonth: null });
    expect(r.post.map((p) => p.date)).toEqual(["2026-10-31", "2026-11-30", "2026-12-31"]);
    expect(r.blocked.map((b) => [b.month, b.reason])).toEqual([["2027-01", "OUT_OF_PERIOD"]]);
  });
});

describe("planRecurringRuns: blocked", () => {
  it("締め済みの年度の回は PERIOD_CLOSED（登録しない）", () => {
    const t = setup();
    t.closeYear(2026);
    const ctx = loadContext(t.masters);
    const r = plan(t, "2026-10-26", {}, [], ctx);
    expect(r.post).toEqual([]);
    expect(r.blocked.map((b) => [b.month, b.date, b.reason])).toEqual([
      ["2026-08", "2026-08-25", "PERIOD_CLOSED"],
      ["2026-09", "2026-09-25", "PERIOD_CLOSED"],
      ["2026-10", "2026-10-25", "PERIOD_CLOSED"],
    ]);
  });

  it("会計期間がない月は OUT_OF_PERIOD", () => {
    const t = setup();
    const r = plan(t, "2027-02-01", { dayOfMonth: 1, startMonth: "2026-12" });
    expect(r.post.map((p) => p.month)).toEqual(["2026-12"]);
    expect(r.blocked.map((b) => [b.month, b.reason])).toEqual([
      ["2027-01", "OUT_OF_PERIOD"],
      ["2027-02", "OUT_OF_PERIOD"],
    ]);
  });

  it("使用停止の科目は ACCOUNT_INACTIVE", () => {
    const t = setup();
    const debitAccount = t.accountId("地代家賃");
    const ctx: RecurringContext = {
      ...t.ctx,
      accounts: t.ctx.accounts.map((a) => (a.id === debitAccount ? { ...a, isActive: false } : a)),
    };
    const r = plan(t, "2026-09-26", {}, [], ctx);
    expect(r.post).toEqual([]);
    expect(r.blocked.map((b) => b.reason)).toEqual(["ACCOUNT_INACTIVE", "ACCOUNT_INACTIVE"]);
  });

  it("存在しない科目は ACCOUNT_NOT_FOUND", () => {
    const t = setup();
    const base = t.def();
    const lines = base.lines.map((l, i) => (i === 0 ? { ...l, accountId: "no-such-account" } : l));
    const r = plan(t, "2026-08-26", { lines });
    expect(r.post).toEqual([]);
    expect(r.blocked.map((b) => b.reason)).toEqual(["ACCOUNT_NOT_FOUND"]);
  });

  it("使用停止の取引先は PARTNER_INACTIVE（001 の検証は見ないのでここで足す）", () => {
    const t = setup();
    const ctx: RecurringContext = {
      ...t.ctx,
      partners: t.ctx.partners.map((p) => (p.id === t.partner.id ? { ...p, isActive: false } : p)),
    };
    const r = plan(t, "2026-08-26", {}, [], ctx);
    expect(r.post).toEqual([]);
    expect(r.blocked.map((b) => [b.month, b.reason])).toEqual([["2026-08", "PARTNER_INACTIVE"]]);
  });

  it("消費税の設定の空白の月は JOURNAL_INVALID（details.code = TAX_SETTING_GAP）で post に入らない", () => {
    const t = setup();
    t.masters.replaceTaxSettings([
      {
        id: "ts-1",
        effectiveFrom: "2026-09-01",
        taxpayerStatus: "general",
        accountingMethod: "tax_included",
      },
    ]);
    const ctx = loadContext(t.masters);
    // 2026 年度の期首〜 8 月が空白（最初の設定の適用開始日より前）
    const r = plan(t, "2026-10-26", {}, [], ctx);
    expect(r.post.map((p) => p.month)).toEqual(["2026-09", "2026-10"]);
    expect(r.blocked).toEqual([
      {
        month: "2026-08",
        date: "2026-08-25",
        reason: "JOURNAL_INVALID",
        details: { code: "TAX_SETTING_GAP" },
      },
    ]);
  });

  it("税抜経理の期間は JOURNAL_INVALID（TAX_METHOD_UNSUPPORTED）", () => {
    const t = setup();
    t.masters.replaceTaxSettings([
      {
        id: "ts-1",
        effectiveFrom: "2025-01-01",
        taxpayerStatus: "general",
        accountingMethod: "tax_excluded",
      },
    ]);
    const ctx = loadContext(t.masters);
    const r = plan(t, "2026-09-26", {}, [], ctx);
    expect(r.post).toEqual([]);
    expect(r.blocked.map((b) => [b.reason, b.details])).toEqual([
      ["JOURNAL_INVALID", { code: "TAX_METHOD_UNSUPPORTED" }],
      ["JOURNAL_INVALID", { code: "TAX_METHOD_UNSUPPORTED" }],
    ]);
  });

  it("使用停止の補助科目の行は JOURNAL_INVALID（VALIDATION）", () => {
    const t = setup();
    const accountId = t.accountId("地代家賃");
    const ctx: RecurringContext = {
      ...t.ctx,
      subAccounts: [{ id: "sub-1", accountId, name: "旧事務所", isActive: false }],
    };
    const base = t.def();
    const lines = base.lines.map((l, i) => (i === 0 ? { ...l, subAccountId: "sub-1" } : l));
    const r = plan(t, "2026-08-26", { lines }, [], ctx);
    expect(r.post).toEqual([]);
    expect(r.blocked.map((b) => [b.reason, b.details])).toEqual([
      ["JOURNAL_INVALID", { code: "VALIDATION" }],
    ]);
  });

  it("blocked の月と post の月は同じ定義の中で混ざる（締めた年度だけ blocked）", () => {
    const t = setup();
    t.closeYear(2025);
    const ctx = loadContext(t.masters);
    const r = plan(t, "2026-02-01", { dayOfMonth: 1, startMonth: "2025-12" }, [], ctx);
    expect(r.blocked.map((b) => [b.month, b.reason])).toEqual([["2025-12", "PERIOD_CLOSED"]]);
    expect(r.post.map((p) => p.month)).toEqual(["2026-01", "2026-02"]);
  });
});
