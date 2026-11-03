# Contract: HTTP API（004-auth-backup）

001 の [http-api.md](../../001-ledger-core/contracts/http-api.md) の規約（ベースパス `/api`、エラー形式、Hono RPC）を使う。入出力の正本は `packages/schema/src/auth.ts` と `backup.ts` の Zod 定義。

## 全ルートに掛かる検査（research R6）

許す Host・オリジンは `apps/server/src/lib/origin.ts` の1か所で決める（research R2）。

| 順 | 検査 | 失敗 |
|---|---|---|
| 1 | `Host` が許す名前か（`localhost:5173`・`localhost:8787`・`127.0.0.1:8787`、リモートが有効なら登録した ts.net の名前） | 421 `HOST_NOT_ALLOWED` |
| 2 | GET・HEAD・OPTIONS 以外の要求は、`Content-Type` によらず、`Origin` が許すオリジンの一覧（`lib/origin.ts`）にあるか。`Origin` がなければ `Sec-Fetch-Site: same-origin` か（`hono/csrf` は使わない） | 403 `CSRF_REJECTED` |
| 3 | 公開の手続き（下の「公開」の完全一致の一覧）以外は有効なセッションがあるか | 401 `UNAUTHENTICATED` |

セッションの cookie は `trebuchet_session`（`HttpOnly`、`SameSite=Strict`、`Path=/`、https のとき `Secure`）。セッションの `rp_id` と要求の `Host` の名前が違えば無効として扱う。

## 追加するエラーコード（19種）

| HTTP | code | 発生条件 | 要件 |
|---|---|---|---|
| 401 | `UNAUTHENTICATED` | セッションがない・失効・無効化。公開の手続きで、前提の回復用の一時セッションがない | FR-003, FR-004 |
| 403 | `CSRF_REJECTED` | Origin の検査に失敗 | FR-009 |
| 421 | `HOST_NOT_ALLOWED` | 許さない Host。ローカルの Host だけの手続き（`register/*`、`POST /auth/pairing`）を、ほかの Host から呼んだ | FR-001, FR-011, FR-012 |
| 409 | `ALREADY_REGISTERED` | パスキーがあるのに初回の登録を呼んだ | FR-001 |
| 400 | `WEBAUTHN_FAILED` | 登録・認証の応答の検証に失敗（challenge の不一致、期限切れを含む） | FR-001, FR-002 |
| 400 | `RECOVERY_INVALID` | 回復コードが違う | FR-006 |
| 429 | `RECOVERY_LOCKED` | 5回連続で誤り、最後の失敗から15分未満。`details.retryAfter` | FR-006 |
| 409 | `LAST_PASSKEY` | `localhost` の最後のパスキーを削除しようとした | FR-005 |
| 422 | `PASSPHRASE_TOO_SHORT` / `PASSPHRASE_MISMATCH` / `PASSPHRASE_WRONG` | パスフレーズの設定・変更・検査 | FR-014, FR-023 |
| 422 | `BACKUP_FOLDER_NOT_FOUND` | 置き場所がない・書けない | FR-014, FR-020 |
| 409 | `BACKUP_NOT_CONFIGURED` | 未設定でバックアップを求めた | FR-019 |
| 409 | `BACKUP_RUNNING` | 実行中に重ねて求めた | FR-019 |
| 422 | `BACKUP_INVALID` | 検査で、壊れている・パスフレーズが違う | FR-024 |
| 422 | `BACKUP_VERSION_MISMATCH` | アプリの版が今と一致しないファイル（新しくても古くても） | FR-027 |
| 422 | `REMOTE_HOST_INVALID` | `*.ts.net` の形でない名前 | FR-010 |
| 409 | `REMOTE_NOT_CONFIGURED` | リモートが無効、または名前が未登録でペアリングを求めた | FR-012 |
| 401 | `PAIRING_TOKEN_INVALID` | ペアリングのトークンがない・違う・期限切れ・使用済み | FR-012 |
| 401 | `LOCKED` | （008）施錠中に `pairing/register/*` や帳簿の API を呼んだ | FR-012 |
| 400 | `PRF_UNSUPPORTED` | （008）パスキーが PRF に対応していない（ペアリングの登録で DK を包めない） | FR-012 |
| 403 | `REAUTH_REQUIRED` | （008）`POST /auth/pairing` で直近 5 分以内の再認証がない | FR-012 |

（既存の 413 `FILE_TOO_LARGE` を、検査のファイルの上限超えに使う。新しいコードは足さない。）

## 認証（公開）

公開の手続きは、**次の完全一致の一覧（メソッドとパスの組）だけ**。ワイルドカードで公開にしない。`/auth/recovery/regenerate` など、ここにない `/api/auth/*` はすべて要サインイン。

| メソッド | パス | 入力 | 出力 | 前提（なければ） | 要件 |
|---|---|---|---|---|---|
| GET | `/health` | — | 200 | — | 001 |
| GET | `/auth/status` | — | 200 `{ registered, signedIn, rpId, remote: { enabled, host }, recoveryAcknowledged }`（`recoveryAcknowledged` は `signedIn` のときだけ boolean、ほかは null） | — | FR-001, FR-007 |
| POST | `/auth/register/options` | — | 200 `PublicKeyCredentialCreationOptionsJSON` | パスキーが0件（1件以上なら 409 `ALREADY_REGISTERED`）、かつローカルの Host（でなければ 421 `HOST_NOT_ALLOWED`）。サインイン中の追加は下の「認証（要サインイン）」 | FR-001 |
| POST | `/auth/register/verify` | `{ response, name? }` | 201 `{ recoveryCode }`。セッションの cookie を付ける | 同上 | FR-001, FR-002 |
| POST | `/auth/sign-in/options` | — | 200 `PublicKeyCredentialRequestOptionsJSON`（この RP ID のパスキー） | — | FR-003 |
| POST | `/auth/sign-in/verify` | `{ response }` | 200 `{ ok: true }` ＋ cookie | — | FR-003 |
| POST | `/auth/recovery/verify` | `{ code }` | 200 `{ ok: true }` ＋ 回復用の一時セッション（パスキーの登録だけに使える、10分）。**回復コードは消費しない**（一時セッションの間は登録をやり直せる）。**008 で廃止**（回復コードは回復キーに替わった。`specs/008-passkey-vault/design.md`） | — | FR-006 |
| POST | `/auth/recovery/register/options` | — | 200 `PublicKeyCredentialCreationOptionsJSON` | 回復用の一時セッション（なければ 401 `UNAUTHENTICATED`） | FR-006 |
| POST | `/auth/recovery/register/verify` | `{ response, name? }` | 201 `{ recoveryCode }`（新しいコード。使ったコードはここで無効になる）＋ 通常のセッション | 回復用の一時セッション（なければ 401 `UNAUTHENTICATED`） | FR-006 |
| POST | `/auth/pairing/register/options` | `{ token }` | 200 `PublicKeyCredentialCreationOptionsJSON`（トークンの RP ID で） | 有効なペアリングのトークン（なければ 401 `PAIRING_TOKEN_INVALID`） | FR-012 |
| POST | `/auth/pairing/register/verify` | `{ token, response, name? }` | 201 `{ passkey }` ＋ 通常のセッション（トークンを使用済みにする） | 同上 | FR-012 |

**008 以降の変更（2026-11-02、US4 の再開）**: `pairing/register/*` は解錠中だけ有効で、施錠中は 401 `LOCKED`。PRF の出力で DK を包んでパスキーを登録するので、PRF がなければ 400 `PRF_UNSUPPORTED`（トークンは消費しない）。トークンの消費は包みを作り終えてから。ペアリングのトークンとリモートの設定は `data/auth.sqlite`（research R4・R17）。

challenge はサーバーのメモリに5分、最大100件まで保持する（要求ごとに1つ。成功・失敗で破棄。100件を超えたら古いものから捨てる）。

## 認証（要サインイン）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| POST | `/auth/sign-out` | — | 204 | FR-004 |
| GET | `/auth/passkeys` | — | 200 `{ passkeys: { id, name, rpId, createdAt, lastUsedAt }[] }` | FR-005 |
| POST | `/auth/passkeys/options` / `verify` | `verify`: `{ response, name? }` | 201 `{ passkey }`（今の接続先の RP ID で追加） | FR-005 |
| PATCH | `/auth/passkeys/:id` | `{ name }` | 200 | FR-005 |
| DELETE | `/auth/passkeys/:id` | — | 204 / 409 `LAST_PASSKEY`（`localhost` の最後の1つ）。そのパスキーで作ったセッションを失効する | FR-005 |
| POST | `/auth/recovery/regenerate` | — | 201 `{ recoveryCode }`（古いコードは無効） | FR-007 |
| POST | `/auth/recovery/acknowledge` | — | 204（回復コードを「控えた」と確認。`recovery_code_acknowledged` を立てる） | FR-002, FR-007 |
| POST | `/auth/pairing` | — | 201 `{ token, url, expiresAt }`（`url` は `https://<名前>/pair?token=…`、10分、単回）。ローカルの Host からだけ（でなければ 421 `HOST_NOT_ALLOWED`）。リモートが有効で名前が登録済みのときだけ（でなければ 409 `REMOTE_NOT_CONFIGURED`）。**008 以降（2026-11-02）: 全権のセッションに加え、直近 5 分以内の再認証が要る（なければ 403 `REAUTH_REQUIRED`）。施錠中は 401 `LOCKED`** | FR-012 |
| GET | `/auth/sessions` | — | 200 `{ sessions: { id, rpId, userAgent, createdAt, lastSeenAt, current }[] }` | FR-013 |
| DELETE | `/auth/sessions/:id` | — | 204 | FR-013 |
| GET | `/auth/events` | `?limit=` | 200 `{ events }`（新しい順） | FR-008 |
| GET / PUT | `/settings/remote` | PUT: `{ enabled, host }` | 200 `{ enabled, host }`。PUT は `auth_events` に `remote_settings_changed` を残す | FR-010, FR-011 |

## バックアップ（要サインイン）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/backup/status` | — | 200 `{ configured, folder, lastSuccess, lastCheck, lastRun, alert: null \| { reason: "STALE" \| "LAST_RUN_FAILED" \| "PASSPHRASE_NEEDED" }, running }`（`lastCheck` は最後の成功または変更なし） | FR-020 |
| PUT | `/backup/settings` | `{ folder, passphrase, passphraseConfirm, acknowledged: true }` | 200（すぐに最初のバックアップを `manual` で始める。`backup_force_write` を立てる） | FR-014, FR-015 |
| PUT | `/backup/passphrase` | `{ current?, passphrase, passphraseConfirm }`。`current` は、キーチェーン（キーチェーンが使えない環境ではメモリ）が空のときだけ省略できる | 200（`backup_force_write` を立て、すぐに `manual` で書き直す）。値があるのに `current` が違う・省略なら 422 `PASSPHRASE_WRONG`。**008 で廃止**（バックアップの鍵は DK から作り、パスフレーズはない。ADR 0011） | FR-015, FR-023 |
| POST | `/backup/run` | — | 202 `{ runId }`（手動。内容が同じでも必ずファイルを書く） | FR-019 |
| GET | `/backup/runs` | `?limit=` | 200 `{ runs }` | FR-020 |
| POST | `/backup/inspect` | multipart: `file`、`passphrase` | 200 `{ createdAt, macId, appVersion, entities }` / 422 `BACKUP_INVALID` / 422 `BACKUP_VERSION_MISMATCH` / 413 `FILE_TOO_LARGE`（既存のコード。上限 200 MB）。帳簿は変えない | FR-024, FR-027 |

復元そのものは HTTP では行わない（[cli.md](./cli.md)、research R13）。
