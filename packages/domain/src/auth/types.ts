import type { AuthEvent, AuthEventKind, BackupRun } from "@trebuchet/schema";

/** 004-auth-backup（data-model §1）。日時は ISO 8601（UTC） */

export type { AuthEvent, AuthEventKind, BackupRun };

export type AppSettingKey =
  | "mac_id"
  | "remote_enabled"
  | "remote_host"
  | "backup_folder"
  | "backup_passphrase_set"
  | "backup_force_write"
  | "recovery_code_acknowledged";

export type SessionKind = "normal" | "recovery";

export interface Passkey {
  /** credential ID（base64url） */
  id: string;
  /** COSE 公開鍵 */
  publicKey: Uint8Array;
  counter: number;
  /** `localhost` または ts.net の名前 */
  rpId: string;
  transports: string[] | null;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type NewPasskey = Omit<Passkey, "lastUsedAt">;

export interface Session {
  id: string;
  tokenHash: string;
  kind: SessionKind;
  rpId: string;
  /** 回復用の一時セッションは null */
  passkeyId: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

/** createdAt と lastSeenAt は `now` で初期化する */
export interface NewSession {
  id: string;
  tokenHash: string;
  kind: SessionKind;
  rpId: string;
  passkeyId: string | null;
  userAgent: string | null;
  now: string;
}

/** 追記のみ。省略した列は null で保存する。detail にコード・トークン・鍵を入れない */
export interface NewAuthEvent {
  id: string;
  occurredAt: string;
  kind: AuthEventKind;
  rpId?: string | null;
  passkeyId?: string | null;
  sessionId?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
}

/** 終わった実行の 1 行（BackupRun と同じ形） */
export type NewBackupRun = BackupRun;
