import { ACCOUNT_CODES } from "@trebuchet/schema";
import type { TaxCategoryCode } from "../types.ts";

/**
 * freee の名前から帳簿の科目・税区分への対応の初期案（research R13）。
 * 科目は seed（accounts.individual.ts）のコードで指す。名前はすべて normalizeName（NFKC）済みの表記
 */

/** 名前が帳簿の科目と違う既知の言い換え */
export const FREEE_ACCOUNT_ALIASES: Readonly<Record<string, string>> = {
  交際費: "5140",
  その他口座: "1020",
  事務用品費: "5170",
};

/** 名前がこの語で終わる科目は、カードの科目（未払金＋同じ名前の補助科目）とする */
export const FREEE_CARD_SUFFIX = "カード";
export const FREEE_CARD_ACCOUNT_CODE = ACCOUNT_CODES.accountsPayable;

/** 対応づけない freee の科目（年初付の決算振替にだけ出てくる） */
export const FREEE_UNMAPPABLE_ACCOUNTS: readonly string[] = ["損益"];

/** 税区分の初期案。非課税・不課税の表記は分析メモにないため置かない */
export const FREEE_TAX_PROPOSALS: Readonly<Record<string, TaxCategoryCode>> = {
  対象外: "OUT_OF_SCOPE",
  "課税売上10%": "SALES_10",
  "課税売上8%(軽)": "SALES_8R",
  "課対仕入10%": "PURCHASE_10",
  "課対仕入8%(軽)": "PURCHASE_8R",
};
