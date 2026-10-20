# Data Model: 認証とバックアップ

**Feature**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **Date**: 2026-10-20

事業体の DB（tenant）の表は変えない。`registry.sqlite` に次の表を足す（マイグレーション `packages/db/drizzle/registry/0001_auth_backup`。生成後に STRICT にし、トリガーは `--custom` で足す）。日時は ISO 8601（UTC）。

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

- 削除は物理削除（認証器の登録は帳簿ではない）。削除は `auth_events` に残す。`rp_id` ごとに最後の1つは削除できない（ドメインで検査。リモートの名前のパスキーは全部消せるが、`localhost` の最後の1つは消せない）

### 1.2 `recovery_codes`（FR-002, FR-006, FR-007）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `code_hash` | text | NOT NULL（SHA-256、hex） |
| `created_at` | text | |
| `used_at` / `revoked_at` | text | NULL 可 |

- 有効（`used_at` も `revoked_at` も NULL）な行は高々1つ（部分 UNIQUE インデックス）

### 1.3 `sessions`（FR-004, FR-013）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `token_hash` | text | UNIQUE（SHA-256） |
| `rp_id` | text | NOT NULL |
| `user_agent` | text | NULL 可 |
| `created_at` / `last_seen_at` | text | |
| `revoked_at` | text | NULL 可 |

- 有効 ⇔ `revoked_at IS NULL` かつ `now − last_seen_at < SESSION_IDLE_MS`（8時間）。失効した行は残す（7日より古いものは起動時に消してよい）

### 1.4 `auth_events`（FR-008）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `occurred_at` | text | |
| `kind` | text | `register` / `sign_in` / `sign_in_failed` / `recovery_used` / `recovery_failed` / `recovery_regenerated` / `passkey_renamed` / `passkey_deleted` / `session_revoked` / `sign_out`（CHECK） |
| `rp_id` | text | NULL 可 |
| `passkey_id` / `session_id` | text | NULL 可 |
| `user_agent` | text | NULL 可 |
| `detail` | text | JSON、NULL 可 |

- 更新・削除をトリガーで禁止

### 1.5 `app_settings`（FR-010, FR-014, R14）

| 列 | 型 | 制約 |
|---|---|---|
| `key` | text | PK。`mac_id` / `remote_enabled` / `remote_host` / `backup_folder` / `backup_passphrase_set`（CHECK） |
| `value` | text | NOT NULL |
| `updated_at` | text | |

- パスフレーズそのものは保存しない（キーチェーン。R12）。`backup_passphrase_set` は設定済みかの印だけ

### 1.6 `backup_runs`（FR-020）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `started_at` / `finished_at` | text | |
| `trigger` | text | `manual` / `auto` / `pre_restore`（CHECK） |
| `status` | text | `succeeded` / `skipped` / `failed`（CHECK） |
| `error_code` | text | NULL 可（`FOLDER_NOT_FOUND`、`WRITE_FAILED`、`VERIFY_FAILED`、`PASSPHRASE_MISSING` など） |
| `file_name` | text | NULL 可 |
| `size_bytes` | integer | NULL 可 |
| `content_sha256` | text | NULL 可（変更の有無の判断、R10） |
| `summary` | text | JSON（事業体ごとの年度と仕訳の件数）、NULL 可 |

## 2. バックアップのファイル（R8）

```text
"TBK1"（4 バイト）| ヘッダーの長さ（uint32 BE）| ヘッダー（UTF-8 の JSON）| 暗号文 | 認証タグ（16 バイト）
```

- ヘッダー: `{ format: 1, appVersion: { registry: <適用数>, tenant: <適用数> }, macId, createdAt, kdf: { alg: "argon2id", salt, memory: 65536, passes: 3, parallelism: 1 }, cipher: { alg: "aes-256-gcm", nonce } }`（salt・nonce は base64）。AAD = マジック ＋ 長さ ＋ ヘッダー
- 平文（アーカイブ）: `マニフェストの長さ（uint32 BE）| マニフェスト（JSON）| ファイル1 | ファイル2 | …`。マニフェスト: `{ files: [{ path: "registry.sqlite" | "tenants/<id>.sqlite", size, sha256 }], entities: [{ id, name, fiscalYears: [{ year, journals }] }] }`
- `content_sha256`（R10）はアーカイブの平文の SHA-256

## 3. ドメインの型と純関数（保存しない）

- `isSessionActive(session, now)`（INV-28）
- `requiresAuth(method, path)`: 公開の手続き（`/api/health`、`/api/auth/status`、`/api/auth/register/*`（パスキーが0件のときだけ）、`/api/auth/sign-in/*`、`/api/auth/recovery/*`）以外は true（INV-29）
- `recoveryLocked(events, now)`: 直近15分の連続の `recovery_failed` が5回以上
- `shouldRunAutoBackup(lastSuccess, lastRun, now)`、`backupAlert(lastSuccess, lastAutoRun, now)`
- `selectBackupsToPrune(files, macId, now)`（INV-27）
- `canDeletePasskey(passkeys, id)`

## 4. 不変条件（INV-1〜24 に追加）

- **INV-25**: 任意の合成の帳簿（複数の事業体）について、`restore(backup(data, pass), pass)` の後のすべての表の内容が元と一致する（認証の表と `mac_id` を除く）
- **INV-26**: バックアップのファイルの任意の1バイトの変更、任意の位置での切り詰め、異なるパスフレーズは、復号の段階で必ず失敗し、平文を返さない
- **INV-27**: `selectBackupsToPrune` は、この Mac のファイルだけを対象にし、直近30日の各日の最新・それより前の各月の最新（7年以内）・今回のファイルを決して選ばない。ほかの Mac のファイルを選ばない
- **INV-28**: セッションは、`revoked_at` があるか、最後の操作から 8 時間以上たつと必ず無効
- **INV-29**: 公開の手続き以外のすべての `/api` のルートは、有効なセッションがなければ 401 を返す（server のルートの一覧から機械的に検査する）
