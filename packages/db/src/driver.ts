/**
 * Drizzle を better-sqlite3-multiple-ciphers のハンドルに結びつける（008 の D2）。
 * `drizzle-orm/better-sqlite3` の `drizzle()` は実行時に `better-sqlite3` を import するので使わず、
 * 同じ組み立て（dialect・session・database）をここで行う。session と migrator は `better-sqlite3` を
 * 実行時に読まない（型だけ）。ドライバーの API は better-sqlite3 と同じ。
 * packages/db でドライバーを import するのはこのファイルだけ（型の宣言を参照するため）。ほかは `Database` を
 * ここから import する
 */
/// <reference path="./better-sqlite3-multiple-ciphers.d.ts" />
import Database from "better-sqlite3-multiple-ciphers";
import { createTableRelationsHelpers, extractTablesRelationalConfig } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { BetterSQLiteSession } from "drizzle-orm/better-sqlite3/session";
import { BaseSQLiteDatabase, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

export { Database };

export type SqliteClient = Database.Database;

export type DrizzleDb<S extends Record<string, unknown>> = BetterSQLite3Database<S> & {
  $client: SqliteClient;
};

export function drizzleOf<S extends Record<string, unknown>>(
  client: SqliteClient,
  schema: S,
): DrizzleDb<S> {
  const dialect = new SQLiteSyncDialect();
  const tables = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const relational = {
    fullSchema: schema,
    schema: tables.tables,
    tableNamesMap: tables.tableNamesMap,
  };
  const session = new BetterSQLiteSession(client, dialect, relational);
  const db = new BaseSQLiteDatabase(
    "sync",
    dialect,
    session,
    relational,
  ) as unknown as DrizzleDb<S>;
  db.$client = client;
  return db;
}
