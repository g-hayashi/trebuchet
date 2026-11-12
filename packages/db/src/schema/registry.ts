import { ENTITY_KINDS } from "@trebuchet/schema";
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * data/registry.sqlite（DK から作る鍵で暗号化。008 の D1・D2）。事業体の一覧と端末の設定
 * （帳簿データは持たない）。認証の表は data/auth.sqlite（`schema/auth.ts`）
 */
export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ENTITY_KINDS }).notNull(),
    dbFile: text("db_file").notNull().unique(),
    createdAt: text("created_at").notNull(),
    status: text("status", { enum: ["active", "archived", "deleting", "preparing"] })
      .notNull()
      .default("active"),
    /** デモ事業の印（014 R3）。作成後に変えない */
    isDemo: integer("is_demo").notNull().default(0),
  },
  (t) => [
    check("entities_kind", sql`${t.kind} IN ('individual', 'corporation')`),
    check("entities_status", sql`${t.status} IN ('active', 'archived', 'deleting', 'preparing')`),
    check("entities_is_demo", sql`${t.isDemo} IN (0, 1)`),
  ],
);

/** 端末に結びつく設定（バックアップに含めない）。data-model §1.5。リモートの設定は auth.sqlite（`remote_settings`）にある */
export const appSettings = sqliteTable(
  "app_settings",
  {
    key: text("key", {
      enum: ["mac_id", "backup_folder", "backup_force_write", "recovery_code_acknowledged"],
    }).primaryKey(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check(
      "app_settings_key",
      sql`${t.key} IN ('mac_id', 'backup_folder', 'backup_force_write', 'recovery_code_acknowledged')`,
    ),
  ],
);

/** バックアップの実行の記録（終わったものだけ）。data-model §1.6 */
export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: text("id").primaryKey(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at").notNull(),
    trigger: text("trigger", { enum: ["manual", "auto"] }).notNull(),
    status: text("status", { enum: ["succeeded", "skipped", "failed"] }).notNull(),
    errorCode: text("error_code"),
    fileName: text("file_name"),
    sizeBytes: integer("size_bytes"),
    contentSha256: text("content_sha256"),
    summary: text("summary"),
  },
  (t) => [
    check("backup_runs_trigger", sql`${t.trigger} IN ('manual', 'auto')`),
    check("backup_runs_status", sql`${t.status} IN ('succeeded', 'skipped', 'failed')`),
  ],
);

/**
 * AI の接続の設定（1 行。端末に結びつくのでバックアップに含めない）。006 の data-model §2.1・R12。
 * API キーはキーチェーン（`trebuchet-ai-api-key`）に置き、この表に持たない
 */
export const aiSettings = sqliteTable(
  "ai_settings",
  {
    id: integer("id").primaryKey(),
    /** 端末内の AI は非推奨（精度が低い）なので既定は無効 */
    localEnabled: integer("local_enabled").notNull().default(0),
    externalEnabled: integer("external_enabled").notNull().default(0),
    externalBaseUrl: text("external_base_url"),
    externalModel: text("external_model"),
    /** 010 R15: 証憑の画像を外部の AI へ送ってよいか。1 にできるのは external_enabled = 1 のときだけ */
    receiptImagesEnabled: integer("receipt_images_enabled").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("ai_settings_single", sql`${t.id} = 1`),
    check("ai_settings_local_enabled", sql`${t.localEnabled} IN (0, 1)`),
    check("ai_settings_external_enabled", sql`${t.externalEnabled} IN (0, 1)`),
    check("ai_settings_receipt_images_enabled", sql`${t.receiptImagesEnabled} IN (0, 1)`),
    check(
      "ai_settings_receipt_images_external",
      sql`${t.receiptImagesEnabled} = 0 OR ${t.externalEnabled} = 1`,
    ),
    check(
      "ai_settings_external",
      sql`${t.externalEnabled} = 0 OR (${t.externalBaseUrl} IS NOT NULL AND ${t.externalModel} IS NOT NULL)`,
    ),
  ],
);
