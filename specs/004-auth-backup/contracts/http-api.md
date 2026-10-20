# Contract: HTTP API（004-auth-backup）

001 の [http-api.md](../../001-ledger-core/contracts/http-api.md) の規約（ベースパス `/api`、エラー形式、Hono RPC）を使う。入出力の正本は `packages/schema/src/auth.ts` と `backup.ts` の Zod 定義。

## 全ルートに掛かる検査（research R6）

| 順 | 検査 | 失敗 |
|---|---|---|
| 1 | `Host` が許す名前か（`localhost:5173`・`localhost:8787`・`127.0.0.1:8787`、リモートが有効なら登録した ts.net の名前） | 421 `HOST_NOT_ALLOWED` |
| 2 | 変更の要求の `Origin`（なければ `Sec-Fetch-Site: same-origin`）が許すオリジンか | 403 `CSRF_REJECTED` |
| 3 | 公開の手続き（下の「公開」）以外は有効なセッションがあるか | 401 `UNAUTHENTICATED` |

セッションの cookie は `trebuchet_session`（`HttpOnly`、`SameSite=Strict`、`Path=/`、https のとき `Secure`）。セッションの `rp_id` と要求の `Host` の名前が違えば無効として扱う。

## 追加するエラーコード

| HTTP | code | 発生条件 | 要件 |
|---|---|---|---|
| 401 | `UNAUTHENTICATED` | セッションがない・失効・無効化 | FR-003, FR-004 |
| 403 | `CSRF_REJECTED` | Origin の検査に失敗 | FR-009 |
| 421 | `HOST_NOT_ALLOWED` | 許さない Host | FR-011 |
| 409 | `ALREADY_REGISTERED` | パスキーがあるのに初回の登録を呼んだ | FR-001 |
| 400 | `WEBAUTHN_FAILED` | 登録・認証の応答の検証に失敗（challenge の不一致、期限切れを含む） | FR-001, FR-002 |
| 400 | `RECOVERY_INVALID` | 回復コードが違う | FR-006 |
| 429 | `RECOVERY_LOCKED` | 15分に5回の誤り。`details.retryAfter` | FR-006 |
| 409 | `LAST_PASSKEY` | `localhost` の最後のパスキーを削除しようとした | FR-005 |
| 422 | `PASSPHRASE_TOO_SHORT` / `PASSPHRASE_MISMATCH` / `PASSPHRASE_WRONG` | パスフレーズの設定・変更・検査 | FR-014, FR-023 |
| 422 | `BACKUP_FOLDER_NOT_FOUND` | 置き場所がない・書けない | FR-014, FR-020 |
| 409 | `BACKUP_NOT_CONFIGURED` | 未設定でバックアップを求めた | FR-019 |
| 409 | `BACKUP_RUNNING` | 実行中に重ねて求めた | FR-019 |
| 422 | `BACKUP_INVALID` | 検査で、壊れている・パスフレーズが違う | FR-024 |
| 422 | `BACKUP_TOO_NEW` | 今より新しい版のファイル | FR-027 |
| 422 | `REMOTE_HOST_INVALID` | `*.ts.net` の形でない名前 | FR-010 |

## 認証（公開）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/auth/status` | — | 200 `{ registered: boolean, signedIn: boolean, rpId, remote: { enabled, host } }` | FR-001 |
| POST | `/auth/register/options` | — | 200 `PublicKeyCredentialCreationOptionsJSON`。パスキーが1つ以上あれば 409 `ALREADY_REGISTERED`（サインイン中の追加は下の「認証（要サインイン）」） | FR-001 |
| POST | `/auth/register/verify` | `{ response, name? }` | 201 `{ recoveryCode }`。セッションの cookie を付ける | FR-001, FR-002 |
| POST | `/auth/sign-in/options` | — | 200 `PublicKeyCredentialRequestOptionsJSON`（この RP ID のパスキー） | FR-003 |
| POST | `/auth/sign-in/verify` | `{ response }` | 200 `{ ok: true }` ＋ cookie | FR-003 |
| POST | `/auth/recovery/verify` | `{ code }` | 200 `{ ok: true }` ＋ 回復用の一時セッション（パスキーの登録だけに使える、10分） | FR-006 |
| POST | `/auth/recovery/register/options` / `verify` | 回復用のセッションで | `verify` は 201 `{ recoveryCode }`（新しいコード）＋ 通常のセッション | FR-006 |

challenge はサーバーのメモリに5分保持する（要求ごとに1つ。成功・失敗で破棄）。

## 認証（要サインイン）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| POST | `/auth/sign-out` | — | 204 | FR-004 |
| GET | `/auth/passkeys` | — | 200 `{ passkeys: { id, name, rpId, createdAt, lastUsedAt }[] }` | FR-005 |
| POST | `/auth/passkeys/options` / `verify` | `verify`: `{ response, name? }` | 201 `{ passkey }`（今の接続先の RP ID で追加） | FR-005, FR-012 |
| PATCH | `/auth/passkeys/:id` | `{ name }` | 200 | FR-005 |
| DELETE | `/auth/passkeys/:id` | — | 204 / 409 `LAST_PASSKEY` | FR-005 |
| POST | `/auth/recovery/regenerate` | — | 201 `{ recoveryCode }` | FR-007 |
| GET | `/auth/sessions` | — | 200 `{ sessions: { id, rpId, userAgent, createdAt, lastSeenAt, current }[] }` | FR-013 |
| DELETE | `/auth/sessions/:id` | — | 204 | FR-013 |
| GET | `/auth/events` | `?limit=` | 200 `{ events }`（新しい順） | FR-008 |
| GET / PUT | `/settings/remote` | PUT: `{ enabled, host }` | 200 `{ enabled, host }` | FR-010, FR-011 |

## バックアップ（要サインイン）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/backup/status` | — | 200 `{ configured, folder, lastSuccess, lastRun, alert: null \| { reason } , running }` | FR-020 |
| PUT | `/backup/settings` | `{ folder, passphrase, passphraseConfirm, acknowledged: true }` | 200（すぐに最初のバックアップを始める） | FR-014, FR-015 |
| PUT | `/backup/passphrase` | `{ current, passphrase, passphraseConfirm }` | 200 | FR-023 |
| POST | `/backup/run` | — | 202 `{ runId }` | FR-019 |
| GET | `/backup/runs` | `?limit=` | 200 `{ runs }` | FR-020 |
| POST | `/backup/inspect` | multipart: `file`、`passphrase` | 200 `{ createdAt, macId, appVersion, entities }` / 422 `BACKUP_INVALID` / `BACKUP_TOO_NEW`。帳簿は変えない | FR-024 |

復元そのものは HTTP では行わない（[cli.md](./cli.md)、research R13）。
