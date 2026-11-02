# Data Model: 認証とバックアップ

**Feature**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **Date**: 2026-10-20

事業体の DB（tenant）の表は変えない。`registry.sqlite` に次の7表を足す（マイグレーション `packages/db/drizzle/registry/0001_auth_backup`。生成後に STRICT にし、トリガーは `--custom` で足す）。日時は ISO 8601（UTC）。

## 1. 表（registry）

### 1.1 `passkeys`（FR-005, FR-012）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK（credential ID、base64url） |
| `public_key` | blob | NOT NULL（COSE 公開鍵） |
| `counter` | integer | ≥ 0 |
| `rp_id` | text | NOT NULL（`localhost` または ts.net の名前） |
| `transports` | text | JSON の配列、NULL 可 |
| `name` | text | 空でない（利用者が付ける名前。既定は端末の情報から） |
| `created_at` / `last_used_at` | text | `last_used_at` は NULL 可 |

- 削除は物理削除（認証器の登録は帳簿ではない）。削除は `auth_events` に残す。削除できないのは `localhost` の最後の1つだけ（ドメインで検査。ts.net の名前のパスキーは全部消せる）
- 削除したパスキーで作ったセッション（`sessions.passkey_id`）は、同じトランザクションで失効する

### 1.2 `recovery_codes`（FR-002, FR-006, FR-007）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `code_hash` | text | NOT NULL（SHA-256、hex） |
| `created_at` | text | |
| `used_at` / `revoked_at` | text | NULL 可 |

- 有効（`used_at` も `revoked_at` も NULL）な行は高々1つ（部分 UNIQUE インデックス）
- 回復コードの入力の成功（`/auth/recovery/verify`）では消費しない。`/auth/recovery/register/verify`（新しいパスキーの登録の成功）で `used_at` を付け、新しい行を追加する（1トランザクション）。`/auth/recovery/regenerate` は `revoked_at` を付けて新しい行を追加する

### 1.3 `sessions`（FR-004, FR-013）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `token_hash` | text | UNIQUE（SHA-256） |
| `kind` | text | `normal` / `recovery`（CHECK。`recovery` は回復用の一時セッション） |
| `rp_id` | text | NOT NULL |
| `passkey_id` | text | NULL 可（このセッションを作ったパスキー。回復用の一時セッションは NULL） |
| `user_agent` | text | NULL 可 |
| `created_at` / `last_seen_at` | text | |
| `revoked_at` | text | NULL 可 |

- 有効 ⇔ `revoked_at IS NULL` かつ（`kind = normal` なら `now − last_seen_at < SESSION_IDLE_MS`（8時間）、`kind = recovery` なら `now − created_at < RECOVERY_SESSION_MS`（10分））。失効した行は残す（7日より古いものは起動時に消してよい）
- `passkey_id` は外部キーにしない（パスキーは物理削除する。削除時にそのセッションを失効する）

### 1.4 `auth_events`（FR-008）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `occurred_at` | text | |
| `kind` | text | `register` / `sign_in` / `sign_in_failed` / `recovery_used` / `recovery_failed` / `recovery_regenerated` / `passkey_renamed` / `passkey_deleted` / `session_revoked` / `sign_out` / `pairing_issued` / `pairing_used` / `remote_settings_changed`（CHECK。13種） |
| `rp_id` | text | NULL 可 |
| `passkey_id` / `session_id` | text | NULL 可 |
| `user_agent` | text | NULL 可 |
| `detail` | text | JSON、NULL 可（コード・トークン・鍵を入れない） |

- 更新・削除をトリガーで禁止
- `recovery_used` は回復コードの入力の成功（一時セッションの発行）、`recovery_regenerated` は新しい回復コードの発行（作り直し、回復用の登録の成功）の記録

### 1.5 `app_settings`（FR-010, FR-014, R14）

> **008/US4（2026-11-02）**: `remote_enabled`・`remote_host` は registry の `app_settings` から外し、平文の `data/auth.sqlite` に移す（Host の検査が施錠中も読むため。research R4）。ここの CHECK の 7 種は、移した後は 5 種。

| 列 | 型 | 制約 |
|---|---|---|
| `key` | text | PK。`mac_id` / `remote_enabled` / `remote_host` / `backup_folder` / `backup_passphrase_set` / `backup_force_write` / `recovery_code_acknowledged`（CHECK。7種） |
| `value` | text | NOT NULL |
| `updated_at` | text | |

- すべて端末に結びつく設定。**バックアップに含めない**（R9）
- パスフレーズそのものは保存しない（キーチェーン。R12）。`backup_passphrase_set` は設定済みかの印だけ
- `backup_force_write`: `"1"` のとき次の自動のバックアップで skip しない。設定・パスフレーズの変更で立て、ファイルを書いた成功で消す（R10）
- `recovery_code_acknowledged`: 回復コードを表示して利用者が「控えた」と確認したときに `"1"`。コードを発行する（登録、回復用の登録の成功、作り直し）たびに `"0"` に戻す。`"1"` でない間は、サインインの後に作り直しを促す

### 1.6 `backup_runs`（FR-020）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `started_at` / `finished_at` | text | |
| `trigger` | text | `manual` / `auto`（CHECK） |
| `status` | text | `succeeded` / `skipped` / `failed`（CHECK） |
| `error_code` | text | NULL 可（`FOLDER_NOT_FOUND`、`WRITE_FAILED`、`VERIFY_FAILED`、`PASSPHRASE_MISSING` など） |
| `file_name` | text | NULL 可 |
| `size_bytes` | integer | NULL 可 |
| `content_sha256` | text | NULL 可（変更の有無の判断、R10） |
| `summary` | text | JSON（事業体ごとの年度と仕訳の件数）、NULL 可 |

- 終わった実行だけを1行として書く（実行中は server のメモリで持つ）。復元の前のバックアップ（C: の復元のコマンド）は DB を使わないので、ここに記録しない
- 設定・パスフレーズの変更の直後のバックアップの `trigger` は `manual`

### 1.7 `pairing_tokens`（FR-012）

> **008/US4（2026-11-02）**: この表は registry から外し、平文の `data/auth.sqlite` に移す（列は同じ。ハッシュと期限だけで秘密は持たない。research R4・R17）。

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `token_hash` | text | NOT NULL UNIQUE（SHA-256、hex。トークンの平文は保存しない） |
| `rp_id` | text | NOT NULL（ts.net の名前。登録するパスキーの RP ID） |
| `created_at` | text | |
| `expires_at` | text | NOT NULL（`created_at` の10分後） |
| `used_at` | text | NULL 可 |

- 単回・期限つき。有効 ⇔ `used_at IS NULL` かつ `now < expires_at`。期限切れの行は起動時に消してよい

## 2. バックアップのファイル（R8）

```text
"TBK1"（4 バイト）| ヘッダーの長さ（uint32 BE）| ヘッダー（UTF-8 の JSON）| 暗号文 | 認証タグ（16 バイト）
```

- ヘッダー: `{ format: 1, appVersion: { registry: <適用数>, tenant: <適用数> }, macId, createdAt, kdf: { alg: "argon2id", salt, memory: 65536, passes: 3, parallelism: 1 }, cipher: { alg: "aes-256-gcm", nonce } }`（salt・nonce は base64）。AAD = マジック ＋ 長さ ＋ ヘッダー
- 平文（アーカイブ）: `マニフェストの長さ（uint32 BE）| マニフェスト（JSON）| ファイル1 | ファイル2 | …`。マニフェスト: `{ files: [{ path: "registry.sqlite" | "tenants/<id>.sqlite", size, sha256 }], entities: [{ id, name, fiscalYears: [{ year, journals }] }] }`
- `content_sha256`（R10）はアーカイブの平文の SHA-256
- アーカイブの `registry.sqlite` は、認証の表・`app_settings`・`backup_runs`・`pairing_tokens` の行を消した写し（R9）

## 3. ドメインの型と純関数（保存しない）

- `isSessionActive(session, now)`（INV-28）: `revoked_at` があれば false。`kind = normal` は最後の操作から8時間、`kind = recovery` は作成から10分で切れる
- `requiresAuth(method, path)`: 次の**完全一致の一覧**（メソッドとパスの組）だけ false、それ以外はすべて true（INV-29）。パスのプレフィックスや `/api/auth/*` のワイルドカードで公開にしない
  - `GET /api/health`
  - `GET /api/auth/status`
  - `POST /api/auth/register/options`・`POST /api/auth/register/verify`（前提: パスキーが0件、かつローカルの Host）
  - `POST /api/auth/sign-in/options`・`POST /api/auth/sign-in/verify`
  - `POST /api/auth/recovery/verify`
  - `POST /api/auth/recovery/register/options`・`POST /api/auth/recovery/register/verify`（前提: 回復用の一時セッション）
  - `POST /api/auth/pairing/register/options`・`POST /api/auth/pairing/register/verify`（前提: 有効なペアリングのトークン）
  - `POST /api/auth/recovery/regenerate` は公開ではない（要サインイン）
- `recoveryLocked(events, now)`: 直近の連続した `recovery_failed`（`recovery_used` で連続が切れる）が5回以上、かつ最後の失敗から15分未満。ロック中の試行は検証せず、`recovery_failed` に記録しない（ロックは延びない）
- `shouldRunAutoBackup(lastCheck, now)`、`backupAlert({ configured, passphraseAvailable, lastCheck, lastRun, now })`、`shouldSkipBackup({ trigger, forceWrite, contentSha256, lastSuccess, existingFiles })`。「最後の確認」は `backup_runs` の最後の `succeeded` または `skipped`（R10）
- `selectBackupsToPrune(files, macId, now)`（INV-27）
- `canDeletePasskey(passkeys, id)`

## 4. 不変条件（INV-1〜24 に追加）

- **INV-25**: 任意の合成の帳簿（複数の事業体。0件を含む）について、`restore(backup(data, pass), pass)` の後のすべての表の内容が元と一致する（除くのは、認証の表・`app_settings`・`backup_runs`・`pairing_tokens` の行。これらは復元後の registry で空）。復元後の registry に、元と同じトリガーと索引が残る
- **INV-26**: バックアップのファイルの任意の1バイトの変更、任意の位置での切り詰め、異なるパスフレーズは、復号の段階で必ず失敗し、平文を返さない
- **INV-27**: `selectBackupsToPrune` は、この Mac のファイルだけを対象にし、直近30日の各日の最新・それより前の各月の最新（7年以内）・今回のファイルを決して選ばない。ほかの Mac のファイルを選ばない
- **INV-28**: セッションは、`revoked_at` があるか、期限（`normal` は最後の操作から8時間、`recovery` は作成から10分）を過ぎると必ず無効
- **INV-29**: 公開の手続きの完全一致の一覧（§3）以外のすべての `/api` のルートは、有効なセッションがなければ 401 を返す（server のルートの一覧から機械的に検査する）。公開の手続きは、前提の状態（回復用の一時セッション、ペアリングのトークン、パスキー0件、ローカルの Host）がなければ 401 か 409 か 421 を返す
