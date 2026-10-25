import { draftInvoices, getWorkHours, saveWorkHours } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";
import { setupInvoicingDb } from "./invoicing-db-setup.ts";

// 005 US1: 工数の保存・読み戻しと、案が読む「取引先・対象月の有効な請求書」（R3・FR-005・FR-016）。
// トリガー・CHECK・UNIQUE の個別の検査は invoicing-schema.test.ts（T002）

let tmp: TempDataDir;
let t: ReturnType<typeof setupInvoicingDb>;

beforeEach(() => {
  tmp = useTempDataDir("invoicing-work-hours");
  t = setupInvoicingDb();
});
afterEach(() => tmp.cleanup());

describe("工数（work_hours）", () => {
  it("保存して読み戻せる（半時間の整数で持ち、0.5 時間 = 1）。上書きできる", () => {
    const a = t.addPartner("A 社");
    t.setTerms(a.id);
    const saved = saveWorkHours(t.deps, "2026-10", {
      entries: [{ partnerId: a.id, hours: 120.5 }],
    });
    expect(saved).toEqual({ ok: true, value: [{ partnerId: a.id, hours: 120.5 }] });
    expect(t.store.getWorkHours(a.id, "2026-10")).toMatchObject({ halfHours: 241 });

    saveWorkHours(t.deps, "2026-10", { entries: [{ partnerId: a.id, hours: 0.5 }] });
    expect(getWorkHours(t.deps, "2026-10")).toEqual({
      ok: true,
      value: [{ partnerId: a.id, hours: 0.5 }],
    });
    expect(t.count("work_hours")).toBe(1);
    // 別の月・別の取引先とは別の行
    expect(t.store.listWorkHours("2026-09")).toEqual([]);
    expect(t.store.getWorkHours("no-such", "2026-10")).toBeNull();
  });

  it("保存は work_hours の記録（invoicing_audit_log）に残る", () => {
    const a = t.addPartner("A 社");
    t.setTerms(a.id);
    saveWorkHours(t.deps, "2026-10", { entries: [{ partnerId: a.id, hours: 3 }] });
    saveWorkHours(t.deps, "2026-10", { entries: [{ partnerId: a.id, hours: 4 }] });
    const rows = t.db.$client
      .prepare("SELECT target_type, target_id, action FROM invoicing_audit_log ORDER BY rowid")
      .all();
    expect(rows).toEqual([
      { target_type: "work_hours", target_id: `${a.id}:2026-10`, action: "create" },
      { target_type: "work_hours", target_id: `${a.id}:2026-10`, action: "update" },
    ]);
  });

  it("時間単価型でない取引先の工数は保存できない（何も残らない）", () => {
    const m = t.addPartner("月額社");
    t.setTerms(m.id, { billingType: "monthly", unitPrice: null, monthlyAmount: 100_000 });
    const r = saveWorkHours(t.deps, "2026-10", { entries: [{ partnerId: m.id, hours: 1 }] });
    expect(r.ok).toBe(false);
    expect(t.count("work_hours")).toBe(0);
  });
});

describe("listActiveInvoices と案の重複の警告（FR-016）", () => {
  it("取引先・対象月の取消でない請求書だけを返す（seq の順）", () => {
    const a = t.addPartner("A 社");
    const b = t.addPartner("B 社");
    const live = t.seedInvoice({ partnerId: a.id });
    t.seedInvoice({
      partnerId: a.id,
      voidedAt: "2026-10-31T10:00:00.000Z",
      voidReason: "誤り",
    });
    t.seedInvoice({ partnerId: a.id, targetMonth: "2026-09" });
    t.seedInvoice({ partnerId: b.id });
    const live2 = t.seedInvoice({ partnerId: a.id });

    expect(t.store.listActiveInvoices(a.id, "2026-10").map((i) => i.id)).toEqual([
      live.id,
      live2.id,
    ]);
    expect(t.store.listActiveInvoices(a.id, "2026-08")).toEqual([]);
  });

  it("実 DB でも案の警告は取消済みを数えない", () => {
    const a = t.addPartner("A 社");
    t.setTerms(a.id, { billingType: "monthly", unitPrice: null, monthlyAmount: 50_000 });
    t.seedInvoice({ partnerId: a.id, voidedAt: "2026-10-31T10:00:00.000Z", voidReason: "誤り" });
    const none = draftInvoices(t.deps, { month: "2026-10" }, "2026-10-31");
    expect(none.ok && none.value.drafts[0]?.warnings).toEqual([]);
    const live = t.seedInvoice({ partnerId: a.id });
    const warned = draftInvoices(t.deps, { month: "2026-10" }, "2026-10-31");
    expect(warned.ok && warned.value.drafts[0]?.warnings[0]?.details).toEqual({
      invoices: [live.invoiceNo],
    });
  });
});
