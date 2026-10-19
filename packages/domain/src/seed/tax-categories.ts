import type { TaxCategory } from "../types.ts";

/** 税区分（FR-010, data-model §2）。DB へはマイグレーション 0001_integrity.sql で投入する（一致をテストで確認） */
export const TAX_CATEGORIES: readonly TaxCategory[] = [
  { code: "OUT_OF_SCOPE", name: "対象外", kind: null },
  { code: "SALES_10", name: "課税売上10%", kind: "sales" },
  { code: "SALES_8R", name: "課税売上8%（軽）", kind: "sales" },
  { code: "PURCHASE_10", name: "課対仕入10%", kind: "purchase" },
  { code: "PURCHASE_8R", name: "課対仕入8%（軽）", kind: "purchase" },
  { code: "EXEMPT", name: "非課税", kind: null },
  { code: "NON_TAXABLE", name: "不課税", kind: null },
];
