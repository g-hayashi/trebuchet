# Contract: コマンドとモジュール（004-auth-backup）

> **US4（Tailscale によるリモートの利用）は保留（2026-10-24）**。この文書の `pnpm start` とリモートに関する記述は未実装。`pnpm restore` は実装済み。

## 復元のコマンド（research R13、FR-024〜029）

```bash
pnpm restore -- --file <path/to/backup.tbk> [--data-dir <dir>] [--yes]
```

- パスフレーズは端末から入力（エコーなし）。引数・環境変数では受け取らない
- `--data-dir` の既定は `TREBUCHET_DATA_DIR`、なければリポジトリ直下の `data/`
- 手順と出力:
  1. server が 127.0.0.1:8787 で応答すれば中止（終了コード 3）
  2. 復号と検証。失敗は「パスフレーズが違うか、ファイルが壊れています」（終了コード 1）。アプリの版が今と一致しなければ「アプリの版が一致しません。このバックアップを取った版のアプリで復元してください」（終了コード 1）。マイグレーションでの更新はしない
  3. 要約（作成日時、作った Mac、事業体ごとの年度と仕訳の件数）を表示する。データ場所に同じ事業体があれば、事業体ごとの差（仕訳の件数、最後の更新）も表示する。`--yes` がなければ確認を求める
  4. データ場所に帳簿があれば、今の帳簿を同じパスフレーズでバックアップし、場所を表示する（db の `snapshotDataDir`・`encryptBackup`・`writeBackupFile` だけで書く。server の関数は使わない。`<dataDir>/../trebuchet-before-restore-<日時>.tbk`）
  5. `<dataDir>.restore-<日時>/` に展開し、`PRAGMA integrity_check`（マイグレーションは当てない）
  6. 元の `<dataDir>` の `app_settings` の行を、展開した registry に引き継ぐ。`<dataDir>` → `<dataDir>.before-restore-<日時>/`、展開先 → `<dataDir>` に改名。失敗したら元に戻し、展開先を消す
  7. 「復元しました。アプリを起動し、パスキーを登録してください」（終了コード 0）
- 展開先 `<dataDir>.restore-<日時>/` は、成功すれば改名されて残らず、失敗すれば消す。`.gitignore` に `*.tbk`、`data.before-restore-*/`、`data.restore-*/` を足す（`.tmp/` の下は既に除外）
- 終了コード: 0 = 成功、1 = 検査の失敗、2 = 使い方の誤り、3 = server が動いている、4 = 取り消し

## 起動のコマンド（research R3）

```bash
pnpm start   # web をビルドし、server が http://localhost:8787 で web と API を配信する
```

## モジュール（packages/db/src/backup/、R8・R9）

| 関数 | 入力 | 出力 |
|---|---|---|
| `snapshotDataDir(dataDir, tmpDir)` | データ場所、`.tmp/` の下の作業場所 | `{ files: { path, bytes }[], manifest }`。各 DB に `VACUUM INTO`。registry の写しは、トリガーを `DROP` → 認証の表・`app_settings`・`backup_runs`・`pairing_tokens` の行を消す → トリガーを作り直す → `VACUUM`（R9）。平文の写しは `tmpDir` の下に作り、`finally` で必ず消す（呼び出し側が `tmpDir` ごと消す） |
| `currentAppVersion()` | — | `{ registry, tenant }`（マイグレーションの適用数） |
| `removeStaleSnapshots(tmpRoot)` | `.tmp/` | 前回の異常終了で残った `.tmp/backup-snapshot-*/` を消す（server の起動時に呼ぶ） |
| `packArchive(snapshot)` / `unpackArchive(bytes)` | | アーカイブのバイト列 / `{ manifest, files }`（各ファイルの SHA-256 を検査） |
| `encryptBackup(archive, passphrase, header)` | | `.tbk` のバイト列（Argon2id ＋ AES-256-GCM、ヘッダーを AAD） |
| `decryptBackup(bytes, passphrase, currentVersion)` | | `Result<{ header, archive }, "INVALID" \| "VERSION_MISMATCH">`（版が `currentVersion` と一致しなければ `VERSION_MISMATCH`） |
| `writeBackupFile(folder, name, bytes)` | | 一時名で書き、読み戻して検証し、改名 |
| `listBackupFiles(folder)` | | `{ name, macId, createdAt }[]` |
| `restoreBackup(options)` | ファイル、パスフレーズ、データ場所、`confirm` | 復元の手順 3〜6（R13） |
| `hashToken(token)`（`packages/db/src/auth-hash.ts`） | トークンの文字列 | SHA-256 の hex。セッション・回復コード・ペアリングのトークンのハッシュはすべてこれを使う。server は別に SHA-256 を書かない |

## ポート（packages/domain/src/ports.ts）

```ts
interface SecretStore {             // macOS キーチェーン（R12）。テストはメモリの偽物。キーチェーンが使えない環境ではメモリの実装
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

type AppSettingKey =
  | "mac_id" | "remote_enabled" | "remote_host" | "backup_folder"
  | "backup_passphrase_set" | "backup_force_write" | "recovery_code_acknowledged"

interface AuthStore {               // passkeys・recovery_codes・sessions・auth_events・pairing_tokens・app_settings
  // パスキー
  listPasskeys(): Promise<Passkey[]>
  getPasskey(id: string): Promise<Passkey | undefined>
  addPasskey(passkey: NewPasskey): Promise<void>
  renamePasskey(id: string, name: string): Promise<void>
  deletePasskey(id: string): Promise<void>
  recordPasskeyUse(id: string, counter: number, at: string): Promise<void>   // counter と last_used_at
  // 回復コード（ハッシュは hashToken）
  getActiveRecoveryCode(): Promise<{ id: string; codeHash: string } | undefined>
  replaceRecoveryCode(newCodeHash: string, now: string, closeAs: "used" | "revoked"): Promise<void>  // 1トランザクション
  // セッション
  createSession(session: NewSession): Promise<void>   // { id, tokenHash, kind: "normal" | "recovery", rpId, passkeyId: string | null, userAgent, now }
  findSessionByTokenHash(tokenHash: string): Promise<Session | undefined>
  touchSession(id: string, at: string): Promise<void>
  revokeSession(id: string, at: string): Promise<void>
  revokeSessionsByPasskey(passkeyId: string, at: string): Promise<string[]>   // 失効したセッションの id
  listActiveSessions(now: string): Promise<Session[]>
  deleteStaleSessions(before: string): Promise<number>  // 失効済みで before より古いもの
  // 認証の記録（追記のみ）
  appendEvent(event: NewAuthEvent): Promise<void>
  listEvents(limit: number): Promise<AuthEvent[]>                               // 新しい順
  listEventsSince(since: string, kinds: AuthEventKind[]): Promise<AuthEvent[]>  // recoveryLocked の入力
  // ペアリングのトークン（ハッシュは hashToken）
  createPairingToken(token: { id: string; tokenHash: string; rpId: string; now: string; expiresAt: string }): Promise<void>
  isPairingTokenValid(tokenHash: string, rpId: string, now: string): Promise<boolean>
  consumePairingToken(tokenHash: string, rpId: string, now: string): Promise<boolean>  // 有効なら used_at を付けて true（単回）
  deleteExpiredPairingTokens(before: string): Promise<number>
  // アプリの設定（app_settings の読み書きはここに寄せる）
  getSetting(key: AppSettingKey): Promise<string | undefined>
  setSetting(key: AppSettingKey, value: string, now: string): Promise<void>
  getOrCreateMacId(newId: () => string): Promise<string>
}

interface BackupStore {             // backup_runs だけ（app_settings は AuthStore の getSetting・setSetting）
  recordRun(run: NewBackupRun): Promise<void>        // 終わった実行を1行追加
  getLastRun(): Promise<BackupRun | undefined>
  getLastCheck(): Promise<BackupRun | undefined>     // 最後の succeeded または skipped
  getLastSuccess(): Promise<BackupRun | undefined>   // 最後の succeeded
  listRuns(limit: number): Promise<BackupRun[]>      // 新しい順
}
```
