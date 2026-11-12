import type { Account } from "@/features/accounts/api";

// routes のテストが共有するフィクスチャ。値が同じものだけをここに置く（テストごとに違う値は各テストに置く）

/** テストの事業体 `e1` の API の基点 */
export const ENTITY = "/api/entities/e1";

/** `uuid(1020)` → `00000000-0000-4000-8000-000000001020` */
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** 勘定科目。ID は `uuid(n)`、コードは `String(n)`。分類（category・normalSide・reportSection）は呼び出し側が決める */
export const account = (
  n: number,
  name: string,
  rest: Pick<Account, "category" | "normalSide" | "reportSection"> & Partial<Account>,
): Account => ({
  id: uuid(n),
  code: String(n),
  name,
  reportLine: null,
  sortOrder: n,
  isSystem: false,
  isActive: true,
  ...rest,
});

/** 資産の勘定科目（借方側）。違う項目だけ `over` で上書きする */
export const assetAccount = (n: number, name: string, over: Partial<Account> = {}): Account =>
  account(n, name, { category: "asset", normalSide: "debit", reportSection: "BS_ASSET", ...over });

/** 税区分の一覧（対象外・課税売上 10%・課税仕入 10%） */
export const TAX_CATEGORIES = [
  { code: "OUT_OF_SCOPE", name: "対象外", kind: null },
  { code: "SALES_10", name: "課税売上 10%", kind: "sales" },
  { code: "PURCHASE_10", name: "課税仕入 10%", kind: "purchase" },
];
