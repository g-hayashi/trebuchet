import type { InvoiceInput } from "@trebuchet/schema";
import fc from "fast-check";
import { itemAmount } from "../src/invoicing/amounts.ts";

/**
 * 請求書（005）の性質テストのジェネレーター: 条件・工数・明細・税の設定・発行と取消の列。
 * 取引先は 3 件（添字 0〜2）、会計期間は 2025・2026 年度（どちらも open）
 */

export const PARTNER_COUNT = 3;

const TAX_CATEGORIES = ["SALES_10", "SALES_8R", "OUT_OF_SCOPE"] as const;
type SalesTaxCategory = (typeof TAX_CATEGORIES)[number];

const pad = (n: number) => String(n).padStart(2, "0");

const arbName = fc.constantFrom("システム開発", "保守", "コンサルティング", "設計");
const arbTaxCategory = fc.option(fc.constantFrom(...TAX_CATEGORIES), { nil: undefined });

/** 明細の元: 数量 × 単価の行（金額は `floor(数量 × 単価)`）か、金額だけの行 */
export type ItemSpec = {
  name: string;
  quantityHalves?: number | undefined;
  unitPrice?: number | undefined;
  amount?: number | undefined;
  taxCategory?: SalesTaxCategory | undefined;
};

export const arbItemSpec: fc.Arbitrary<ItemSpec> = fc.oneof(
  fc.record({
    name: arbName,
    quantityHalves: fc.integer({ min: 1, max: 400 }),
    // 単価 2 円以上なら 0.5 時間でも金額が 1 円以上になる
    unitPrice: fc.integer({ min: 2, max: 2_000_000 }),
    taxCategory: arbTaxCategory,
  }),
  fc.record({
    name: arbName,
    amount: fc.integer({ min: 1, max: 900_000_000 }),
    taxCategory: arbTaxCategory,
  }),
);

export type IssueSpec = {
  /** 取引先の添字（0〜2） */
  partner: number;
  /** 対象月・発行日の年（2025 年度・2026 年度のどちらも会計期間がある） */
  year: 2025 | 2026;
  /** 対象月（1〜12 月） */
  month: number;
  /** 発行日の月・日（日は 1〜28） */
  issueMonth: number;
  issueDay: number;
  items: ItemSpec[];
};

export const arbIssueSpec: fc.Arbitrary<IssueSpec> = fc.record({
  partner: fc.integer({ min: 0, max: PARTNER_COUNT - 1 }),
  year: fc.constantFrom(2025 as const, 2026 as const),
  month: fc.integer({ min: 1, max: 12 }),
  issueMonth: fc.integer({ min: 1, max: 12 }),
  issueDay: fc.integer({ min: 1, max: 28 }),
  items: fc.array(arbItemSpec, { minLength: 1, maxLength: 5 }),
});

/** 発行の入力にする。同じ取引先・対象月の重複は確認済み（`confirmDuplicate`）として発行する */
export function toInvoiceInput(spec: IssueSpec, partnerIds: readonly string[]): InvoiceInput {
  const partnerId = partnerIds[spec.partner];
  if (partnerId === undefined) throw new Error(`取引先がない: ${spec.partner}`);
  return {
    partnerId,
    targetMonth: `${spec.year}-${pad(spec.month)}`,
    issueDate: `${spec.year}-${pad(spec.issueMonth)}-${pad(spec.issueDay)}`,
    confirmDuplicate: true,
    items: spec.items.map((item) => {
      const hasQuantity = item.quantityHalves !== undefined && item.unitPrice !== undefined;
      return hasQuantity
        ? {
            name: item.name,
            quantity: (item.quantityHalves as number) / 2,
            unit: "時間",
            unitPrice: item.unitPrice as number,
            amount: itemAmount(item.quantityHalves as number, item.unitPrice as number),
            ...(item.taxCategory === undefined ? {} : { taxCategory: item.taxCategory }),
          }
        : {
            name: item.name,
            amount: item.amount as number,
            ...(item.taxCategory === undefined ? {} : { taxCategory: item.taxCategory }),
          };
    }),
  };
}

/** 発行と取消の操作。`void` の `target` は、それまでに発行した請求書の何番目か（剰余で選ぶ） */
export type Op =
  | { kind: "issue"; spec: IssueSpec }
  | { kind: "void"; target: number; reason: string };

export const arbOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: arbIssueSpec.map((spec): Op => ({ kind: "issue", spec })) },
  {
    weight: 1,
    arbitrary: fc
      .record({ target: fc.nat(100), reason: fc.constantFrom("誤り", "二重発行", "取り直し") })
      .map(({ target, reason }): Op => ({ kind: "void", target, reason })),
  },
);

/** 発行だけの列 */
export const arbIssueSpecs = fc.array(arbIssueSpec, { minLength: 1, maxLength: 8 });

/** 発行と取消の列 */
export const arbOps = fc.array(arbOp, { minLength: 1, maxLength: 10 });

/**
 * 消し込みの操作。`target` はそれまでに発行した請求書の何番目か（剰余で選ぶ）。
 * `mode`: `full` = 残額ちょうど、`partial` = 残額の `pct`%（1 円以上）、`fee` = `partial` の額で
 * 差額を手数料として扱う、`over` = 残額を `extra` 円超える額
 */
export type PayOp = {
  kind: "pay";
  target: number;
  mode: "full" | "partial" | "fee" | "over";
  pct: number;
  extra: number;
  /** 入金日（2025 年度・2026 年度。年度の締めの後は 2025 年の入金が PERIOD_CLOSED になる） */
  year: 2025 | 2026;
  month: number;
  day: number;
};

/** 消し込みの取消。`target` はそれまでに登録した消し込みの何番目か（剰余で選ぶ。取消済みも選びうる） */
export type VoidPayOp = { kind: "voidPayment"; target: number; reason: string };

export type LedgerOp = Op | PayOp | VoidPayOp;

export const arbPayOp: fc.Arbitrary<PayOp> = fc.record({
  kind: fc.constant("pay" as const),
  target: fc.nat(100),
  mode: fc.constantFrom(
    "full" as const,
    "partial" as const,
    "partial" as const,
    "fee" as const,
    "over" as const,
  ),
  pct: fc.integer({ min: 1, max: 100 }),
  extra: fc.integer({ min: 1, max: 1_000 }),
  year: fc.constantFrom(2025 as const, 2025 as const, 2026 as const),
  month: fc.integer({ min: 1, max: 12 }),
  day: fc.integer({ min: 1, max: 28 }),
});

export const arbVoidPayOp: fc.Arbitrary<VoidPayOp> = fc.record({
  kind: fc.constant("voidPayment" as const),
  target: fc.nat(100),
  reason: fc.constantFrom("誤り", "二重入力", "取り直し"),
});

/** 発行・取消・消し込み・消し込みの取消の列（INV-32・33・34）。消し込みの取消を請求書の取消より多めにする */
export const arbLedgerOp: fc.Arbitrary<LedgerOp> = fc.oneof(
  { weight: 4, arbitrary: arbIssueSpec.map((spec): LedgerOp => ({ kind: "issue", spec })) },
  {
    weight: 1,
    arbitrary: fc
      .record({ target: fc.nat(100), reason: fc.constantFrom("誤り", "二重発行") })
      .map(({ target, reason }): LedgerOp => ({ kind: "void", target, reason })),
  },
  { weight: 6, arbitrary: arbPayOp },
  { weight: 2, arbitrary: arbVoidPayOp },
);

export const arbLedgerOps = fc.array(arbLedgerOp, { minLength: 6, maxLength: 16 });

/** 発行の後に行う、設定・条件・工数・取引先の変更（INV-38） */
export type Change =
  | {
      kind: "settings";
      issuerName: string;
      address: string;
      bankAccount: string;
      taxDisplay: "separate" | "inclusive_only";
      tradeName: string | undefined;
      /** 次の通し番号の下限に足す数（下限以上にする） */
      seqBump: number;
    }
  | {
      kind: "terms";
      partner: number;
      unitPrice: number;
      dueDay: number;
      defaultItemName: string;
      billingName: string | undefined;
    }
  | { kind: "hours"; partner: number; halfHours: number }
  | {
      kind: "partner";
      partner: number;
      name: string;
      honorific: "様" | "御中" | null;
      isActive: boolean;
    };

const arbText = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0);

export const arbChange: fc.Arbitrary<Change> = fc.oneof(
  fc.record({
    kind: fc.constant("settings" as const),
    issuerName: arbText,
    address: arbText,
    bankAccount: arbText,
    taxDisplay: fc.constantFrom("separate" as const, "inclusive_only" as const),
    tradeName: fc.option(arbText, { nil: undefined }),
    seqBump: fc.integer({ min: 0, max: 50 }),
  }),
  fc.record({
    kind: fc.constant("terms" as const),
    partner: fc.integer({ min: 0, max: PARTNER_COUNT - 1 }),
    unitPrice: fc.integer({ min: 1, max: 1_000_000 }),
    dueDay: fc.constantFrom(1, 10, 25, 28, 31),
    defaultItemName: arbText,
    billingName: fc.option(arbText, { nil: undefined }),
  }),
  fc.record({
    kind: fc.constant("hours" as const),
    partner: fc.integer({ min: 0, max: PARTNER_COUNT - 1 }),
    halfHours: fc.integer({ min: 0, max: 400 }),
  }),
  fc.record({
    kind: fc.constant("partner" as const),
    partner: fc.integer({ min: 0, max: PARTNER_COUNT - 1 }),
    name: arbText,
    honorific: fc.constantFrom("様" as const, "御中" as const, null),
    isActive: fc.boolean(),
  }),
);

export const arbChanges = fc.array(arbChange, { minLength: 1, maxLength: 6 });
