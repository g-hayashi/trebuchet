import { z } from "zod";
import { ErrorDetails } from "./errors.ts";

/** 行の識別子。パスキーは credential ID（base64url）、セッション・イベントはサーバーが採番する */
const RowId = z.string().min(1);

// 004-auth-backup（contracts/http-api.md、data-model.md §1・§3）

/** ISO 8601 の日時（UTC） */
const Timestamp = z.string().min(1);
const Name = z.string().min(1, "名前を入力してください").max(200);

/** WebAuthn の応答（@simplewebauthn の JSON。形の検証はサーバーのライブラリが行う） */
const WebAuthnResponse = z.record(z.string(), z.unknown());

/** Tailscale の名前（`*.ts.net`）。`ts.net` だけ・別のドメインに付けた形は拒否する */
const TS_NET_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/i;
export const TsNetHost = z.string().regex(TS_NET_HOST, "*.ts.net の形で入力してください");

export const RemoteSettings = z
  .object({
    enabled: z.boolean(),
    host: TsNetHost.nullable(),
  })
  .refine((v) => !v.enabled || v.host !== null, {
    path: ["host"],
    message: "リモートを有効にするには名前が必要です",
  });
export type RemoteSettings = z.infer<typeof RemoteSettings>;

/**
 * `PUT /settings/remote` の本文の形だけ（名前の検査は `RemoteSettings`。
 * 形が違えば 400 VALIDATION、名前が不正なら 422 REMOTE_HOST_INVALID に分ける）
 */
export const RemoteSettingsInput = z.object({ enabled: z.boolean(), host: z.string().nullable() });

export const AuthStatus = z.object({
  registered: z.boolean(),
  signedIn: z.boolean(),
  rpId: z.string().min(1),
  remote: z.object({ enabled: z.boolean(), host: z.string().nullable() }),
  /** `signedIn` のときだけ boolean。ほかは null */
  recoveryAcknowledged: z.boolean().nullable(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

export const PasskeyView = z.object({
  id: RowId,
  name: z.string(),
  rpId: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export type PasskeyView = z.infer<typeof PasskeyView>;

export const SessionView = z.object({
  id: RowId,
  rpId: z.string(),
  userAgent: z.string().nullable(),
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  current: z.boolean(),
});
export type SessionView = z.infer<typeof SessionView>;

/** data-model §1.4 の 13 種 */
export const AuthEventKind = z.enum([
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
]);
export type AuthEventKind = z.infer<typeof AuthEventKind>;

export const AuthEvent = z.object({
  id: RowId,
  occurredAt: Timestamp,
  kind: AuthEventKind,
  rpId: z.string().nullable(),
  passkeyId: z.string().nullable(),
  sessionId: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** コード・トークン・鍵を入れない */
  detail: ErrorDetails.nullable(),
});
export type AuthEvent = z.infer<typeof AuthEvent>;

export const RegisterVerifyInput = z.object({
  response: WebAuthnResponse,
  name: Name.optional(),
});
export type RegisterVerifyInput = z.infer<typeof RegisterVerifyInput>;

export const RecoveryVerifyInput = z.object({
  code: z.string().min(1, "回復コードを入力してください"),
});
export type RecoveryVerifyInput = z.infer<typeof RecoveryVerifyInput>;

export const PasskeyRenameInput = z.object({ name: Name });
export type PasskeyRenameInput = z.infer<typeof PasskeyRenameInput>;

export const PairingRegisterOptionsInput = z.object({
  token: z.string().min(1),
});
export type PairingRegisterOptionsInput = z.infer<typeof PairingRegisterOptionsInput>;

export const PairingRegisterVerifyInput = z.object({
  token: z.string().min(1),
  response: WebAuthnResponse,
  name: Name.optional(),
});
export type PairingRegisterVerifyInput = z.infer<typeof PairingRegisterVerifyInput>;

export const PairingIssueResult = z.object({
  token: z.string().min(1),
  url: z.string().min(1),
  expiresAt: Timestamp,
});
export type PairingIssueResult = z.infer<typeof PairingIssueResult>;
