import { describe, expect, it } from "vitest";
import { planImport } from "../../src/import/freee/plan.ts";
import type { TaxSettingDraft } from "../../src/tax-settings.ts";
import { freeeJournal, planInput, single } from "./import-setup.ts";

// 003 US7 / FR-037 / R11: 免税の期間の仕訳の TAX_CATEGORY_SUSPICIOUS は、1件にまとめる

const EXEMPT: TaxSettingDraft[] = [
  { effectiveFrom: "2019-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
];

const SWITCH: TaxSettingDraft[] = [
  { effectiveFrom: "2019-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
  { effectiveFrom: "2025-07-01", taxpayerStatus: "general", accountingMethod: "tax_included" },
];

/** 費用（通信費）に課税売上の税区分が付いた仕訳 */
const suspicious = (id: string, date: string) =>
  freeeJournal(id, date, [
    {
      side: "debit",
      accountName: "通信費",
      amount: 1_100,
      taxName: "課税売上10%",
      taxAmount: 100,
    },
    { side: "credit", accountName: "現金", amount: 1_100 },
  ]);

const plain = (id: string, date: string) =>
  freeeJournal(id, date, [
    { side: "debit", accountName: "現金", amount: 1_100 },
    {
      side: "credit",
      accountName: "売上高",
      amount: 1_100,
      taxName: "課税売上10%",
      taxAmount: 100,
    },
  ]);

const codesOf = (plan: ReturnType<typeof planImport>, code: string) =>
  plan.preview.warnings.filter((w) => w.code === code);

describe("planImport: 免税の期間の警告のまとめ（US7）", () => {
  it("シナリオ1: 免税の期間の仕訳は、1件にまとめて件数と freee の仕訳 ID を持つ", () => {
    const plan = planImport(
      planInput(
        single([
          suspicious("e1", "2025-02-01"),
          plain("e2", "2025-02-02"),
          suspicious("e3", "2025-03-01"),
        ]),
        { taxSettings: EXEMPT },
      ),
    );
    expect(codesOf(plan, "TAX_CATEGORY_SUSPICIOUS")).toEqual([]);
    const grouped = codesOf(plan, "TAX_CATEGORY_SUSPICIOUS_EXEMPT");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.details).toEqual({ count: 2, freeeJournalIds: ["e1", "e3"] });
    expect(grouped[0]?.freeeJournalId).toBeUndefined();
    expect(grouped[0]?.message).toContain("2");
    expect(plan.preview.counts.warnings).toBe(plan.preview.warnings.length);
  });

  it("件数が 0 なら、まとめた警告も出さない", () => {
    const plan = planImport(
      planInput(single([plain("e1", "2025-02-01")]), { taxSettings: EXEMPT }),
    );
    expect(codesOf(plan, "TAX_CATEGORY_SUSPICIOUS_EXEMPT")).toEqual([]);
    expect(codesOf(plan, "TAX_CATEGORY_SUSPICIOUS")).toEqual([]);
  });

  it("シナリオ2: 課税の期間の仕訳は、従来どおり1件ずつ", () => {
    const plan = planImport(
      planInput(single([suspicious("t1", "2025-02-01"), suspicious("t2", "2025-03-01")])),
    );
    expect(codesOf(plan, "TAX_CATEGORY_SUSPICIOUS_EXEMPT")).toEqual([]);
    expect(codesOf(plan, "TAX_CATEGORY_SUSPICIOUS").map((w) => w.freeeJournalId)).toEqual([
      "t1",
      "t2",
    ]);
    const item = plan.preview.items.find((i) => i.freeeJournalId === "t1");
    expect(item?.warnings).toEqual(["TAX_CATEGORY_SUSPICIOUS"]);
  });

  it("シナリオ3: 年の途中で免税から課税に変わると、免税の期間の仕訳だけをまとめる", () => {
    const plan = planImport(
      planInput(
        single([
          suspicious("x1", "2025-03-01"),
          suspicious("x2", "2025-06-30"),
          suspicious("y1", "2025-07-01"),
          suspicious("y2", "2025-09-01"),
        ]),
        { taxSettings: SWITCH },
      ),
    );
    const grouped = codesOf(plan, "TAX_CATEGORY_SUSPICIOUS_EXEMPT");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.details).toEqual({ count: 2, freeeJournalIds: ["x1", "x2"] });
    expect(codesOf(plan, "TAX_CATEGORY_SUSPICIOUS").map((w) => w.freeeJournalId)).toEqual([
      "y1",
      "y2",
    ]);
  });

  it("まとめた仕訳の警告の件数は、それぞれの仕訳の warnings に残る", () => {
    const plan = planImport(
      planInput(single([suspicious("e1", "2025-02-01")]), { taxSettings: EXEMPT }),
    );
    const item = plan.preview.items.find((i) => i.freeeJournalId === "e1");
    expect(item?.warnings).toEqual(["TAX_CATEGORY_SUSPICIOUS_EXEMPT"]);
  });
});
