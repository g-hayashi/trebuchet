/** リポジトリ実装の共通部品（packages/db の内部だけで使う。外へは export しない） */
import type { TaxCategoryCode } from "@trebuchet/domain";
import type { RunResult } from "better-sqlite3";
import { type SQL, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase, SQLiteTable } from "drizzle-orm/sqlite-core";
import type * as tenantSchema from "./schema/tenant.ts";

/** テナントの DB、またはそのトランザクション */
export type TenantConn = BaseSQLiteDatabase<"sync", RunResult, typeof tenantSchema>;

/** 挿入の順（SQLite の rowid）。単一の表を読むときの並び順に使う */
export const insertionOrder = sql`rowid`;

/** 結合などで表を明示したい場合の rowid（`orderBy(rowidOf(t))`、`desc(rowidOf(t))`） */
export const rowidOf = (table: SQLiteTable): SQL => sql`${table}.rowid`;

/**
 * 外部キー（tax_categories）で守られた列の文字列を `TaxCategoryCode` として扱う。
 * 列の型は string なので、ここで 1 回だけ変換する
 */
export function asTaxCategory(value: string): TaxCategoryCode;
export function asTaxCategory(value: string | null): TaxCategoryCode | null;
export function asTaxCategory(value: string | null): TaxCategoryCode | null {
  return value as TaxCategoryCode | null;
}
