import { sql } from "drizzle-orm";
import { blob, check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** data/registry.sqlite。事業体の一覧のみ（帳簿データは持たない） */
export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["individual", "corporation"] }).notNull(),
    dbFile: text("db_file").notNull().unique(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [check("entities_kind", sql`${t.kind} IN ('individual', 'corporation')`)],
);

/** パスキー（WebAuthn の認証器）。物理削除。data-model §1.1 */
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    publicKey: blob("public_key", { mode: "buffer" }).notNull(),
    counter: integer("counter").notNull(),
    rpId: text("rp_id").notNull(),
    transports: text("transports"),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [
    check("passkeys_counter", sql`${t.counter} >= 0`),
    check("passkeys_name", sql`length(${t.name}) > 0`),
  ],
);

/**
 * 回復コード（ハッシュのみ）。data-model §1.2
 * 「有効な行は高々1つ」の部分 UNIQUE インデックスは手書きの SQL（0002）で足す
 */
export const recoveryCodes = sqliteTable("recovery_codes", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  createdAt: text("created_at").notNull(),
  usedAt: text("used_at"),
  revokedAt: text("revoked_at"),
});

/** セッション。passkey_id は外部キーにしない。data-model §1.3 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind", { enum: ["normal", "recovery"] }).notNull(),
    rpId: text("rp_id").notNull(),
    passkeyId: text("passkey_id"),
    userAgent: text("user_agent"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [check("sessions_kind", sql`${t.kind} IN ('normal', 'recovery')`)],
);

/** 認証の監査ログ。追記のみ（トリガーは 0002）。data-model §1.4 */
export const authEvents = sqliteTable(
  "auth_events",
  {
    id: text("id").primaryKey(),
    occurredAt: text("occurred_at").notNull(),
    kind: text("kind", {
      enum: [
        "register",
        "sign_in",
        "sign_in_failed",
        "recovery_used",
        "recovery_failed",
        "recovery_regenerated",
        "passkey_renamed",
        "passkey_deleted",
        "session_revoked",
        "sign_out",
        "pairing_issued",
        "pairing_used",
        "remote_settings_changed",
      ],
    }).notNull(),
    rpId: text("rp_id"),
    passkeyId: text("passkey_id"),
    sessionId: text("session_id"),
    userAgent: text("user_agent"),
    detail: text("detail"),
  },
  (t) => [
    check(
      "auth_events_kind",
      sql`${t.kind} IN ('register', 'sign_in', 'sign_in_failed', 'recovery_used', 'recovery_failed', 'recovery_regenerated', 'passkey_renamed', 'passkey_deleted', 'session_revoked', 'sign_out', 'pairing_issued', 'pairing_used', 'remote_settings_changed')`,
    ),
  ],
);

/** 端末に結びつく設定（バックアップに含めない）。data-model §1.5 */
export const appSettings = sqliteTable(
  "app_settings",
  {
    key: text("key", {
      enum: [
        "mac_id",
        "remote_enabled",
        "remote_host",
        "backup_folder",
        "backup_passphrase_set",
        "backup_force_write",
        "recovery_code_acknowledged",
      ],
    }).primaryKey(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check(
      "app_settings_key",
      sql`${t.key} IN ('mac_id', 'remote_enabled', 'remote_host', 'backup_folder', 'backup_passphrase_set', 'backup_force_write', 'recovery_code_acknowledged')`,
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

/** ペアリングのトークン（ハッシュのみ、単回・期限つき）。data-model §1.7 */
export const pairingTokens = sqliteTable("pairing_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  rpId: text("rp_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

/**
 * AI の接続の設定（1 行。端末に結びつくのでバックアップに含めない）。006 の data-model §2.1・R12。
 * API キーはキーチェーン（`trebuchet-ai-api-key`）に置き、この表に持たない
 */
export const aiSettings = sqliteTable(
  "ai_settings",
  {
    id: integer("id").primaryKey(),
    localEnabled: integer("local_enabled").notNull().default(1),
    externalEnabled: integer("external_enabled").notNull().default(0),
    externalBaseUrl: text("external_base_url"),
    externalModel: text("external_model"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("ai_settings_single", sql`${t.id} = 1`),
    check("ai_settings_local_enabled", sql`${t.localEnabled} IN (0, 1)`),
    check("ai_settings_external_enabled", sql`${t.externalEnabled} IN (0, 1)`),
    check(
      "ai_settings_external",
      sql`${t.externalEnabled} = 0 OR (${t.externalBaseUrl} IS NOT NULL AND ${t.externalModel} IS NOT NULL)`,
    ),
  ],
);
