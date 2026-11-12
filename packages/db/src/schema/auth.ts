import { sql } from "drizzle-orm";
import { blob, check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * data/auth.sqlite（暗号化しない。008 の D2）。秘密を持たない: 公開鍵、PRF の salt、包んだ DK、
 * トークンのハッシュ、操作の記録だけ。施錠中（DK なし）でも開ける
 */

/** パスキー（WebAuthn の認証器）。物理削除（包みは ON DELETE CASCADE で消える）。004 の data-model §1.1 */
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    publicKey: blob("public_key", { mode: "buffer" }).notNull(),
    counter: integer("counter").notNull(),
    rpId: text("rp_id").notNull(),
    transports: text("transports"),
    name: text("name").notNull(),
    /** WebAuthn PRF の入力（資格情報ごとの 32 バイトの乱数。008 の D1） */
    prfSalt: blob("prf_salt", { mode: "buffer" }).notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [
    check("passkeys_counter", sql`${t.counter} >= 0`),
    check("passkeys_name", sql`length(${t.name}) > 0`),
    check("passkeys_prf_salt", sql`length(${t.prfSalt}) = 32`),
  ],
);

/**
 * DK の包み（AES-256-GCM。008 の D1・D2、INV-53）。passkey は資格情報ごとに 1 行（UNIQUE と外部キー）、
 * recovery は常に 1 行（部分 UNIQUE は手書きの SQL で足す）。kind が passkey ⇔ credential_id が NOT NULL
 */
export const keyWraps = sqliteTable(
  "key_wraps",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["passkey", "recovery"] }).notNull(),
    credentialId: text("credential_id")
      .unique()
      .references(() => passkeys.id, { onDelete: "cascade" }),
    salt: blob("salt", { mode: "buffer" }).notNull(),
    iv: blob("iv", { mode: "buffer" }).notNull(),
    tag: blob("tag", { mode: "buffer" }).notNull(),
    wrapped: blob("wrapped", { mode: "buffer" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("key_wraps_kind", sql`${t.kind} IN ('passkey', 'recovery')`),
    check("key_wraps_credential", sql`(${t.kind} = 'passkey') = (${t.credentialId} IS NOT NULL)`),
    check(
      "key_wraps_lengths",
      sql`length(${t.salt}) = 32 AND length(${t.iv}) = 12 AND length(${t.tag}) = 16 AND length(${t.wrapped}) = 32`,
    ),
  ],
);

/** セッション。passkey_id は外部キーにしない。004 の data-model §1.3 */
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

/**
 * リモート（Tailscale）の設定（1 行。端末に結びつくのでバックアップに含めない）。004/R4。
 * 秘密を持たない（ホスト名だけ）ので、施錠中も Host の検査のために読める
 */
export const remoteSettings = sqliteTable(
  "remote_settings",
  {
    id: integer("id").primaryKey(),
    enabled: integer("enabled").notNull().default(0),
    host: text("host"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("remote_settings_single", sql`${t.id} = 1`),
    check("remote_settings_enabled", sql`${t.enabled} IN (0, 1)`),
    check("remote_settings_host", sql`${t.host} IS NULL OR ${t.host} LIKE '%.ts.net'`),
    check("remote_settings_enabled_host", sql`${t.enabled} = 0 OR ${t.host} IS NOT NULL`),
  ],
);

/** ペアリングのトークン（ハッシュのみ、単回・期限つき）。004 の data-model §1.7 */
export const pairingTokens = sqliteTable("pairing_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  rpId: text("rp_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

/** 認証の監査ログ。追記のみ（トリガーは手書きの SQL）。004 の data-model §1.4 */
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
