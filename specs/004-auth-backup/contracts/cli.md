# Contract: コマンドとモジュール（004-auth-backup）

## 復元のコマンド（research R13、FR-024〜029）

```bash
pnpm restore -- --file <path/to/backup.tbk> [--data-dir <dir>] [--yes]
```

- パスフレーズは端末から入力（エコーなし）。引数・環境変数では受け取らない
- `--data-dir` の既定は `TREBUCHET_DATA_DIR`、なければリポジトリ直下の `data/`
- 手順と出力:
  1. server が 127.0.0.1:8787 で応答すれば中止（終了コード 3）
  2. 復号と検証。失敗は「パスフレーズが違うか、ファイルが壊れています」（終了コード 1）。新しい版は「アプリを更新してください」（終了コード 1）
  3. 要約（作成日時、作った Mac、事業体ごとの年度と仕訳の件数）を表示し、`--yes` がなければ確認を求める
  4. データ場所に帳簿があれば、今の帳簿を同じパスフレーズでバックアップし、場所を表示
  5. `<dataDir>.restore-<日時>/` に展開し、マイグレーションと `PRAGMA integrity_check`
  6. `<dataDir>` → `<dataDir>.before-restore-<日時>/`、展開先 → `<dataDir>` に改名。失敗したら元に戻す
  7. 「復元しました。アプリを起動し、パスキーを登録してください」（終了コード 0）
- 終了コード: 0 = 成功、1 = 検査の失敗、2 = 使い方の誤り、3 = server が動いている、4 = 取り消し

## 起動のコマンド（research R3）

```bash
pnpm start   # web をビルドし、server が http://localhost:8787 で web と API を配信する
```

## モジュール（packages/db/src/backup/、R8・R9）

| 関数 | 入力 | 出力 |
|---|---|---|
| `snapshotDataDir(dataDir, tmpDir)` | データ場所 | `{ files: { path, bytes }[], manifest }`（`VACUUM INTO`、registry から認証の表と `mac_id` を除く） |
| `packArchive(snapshot)` / `unpackArchive(bytes)` | | アーカイブのバイト列 / `{ manifest, files }`（各ファイルの SHA-256 を検査） |
| `encryptBackup(archive, passphrase, header)` | | `.tbk` のバイト列（Argon2id ＋ AES-256-GCM、ヘッダーを AAD） |
| `decryptBackup(bytes, passphrase)` | | `Result<{ header, archive }, "INVALID" \| "TOO_NEW">` |
| `writeBackupFile(folder, name, bytes)` | | 一時名で書き、読み戻して検証し、改名 |
| `listBackupFiles(folder)` | | `{ name, macId, createdAt }[]` |

## ポート（packages/domain/src/ports.ts）

```ts
interface SecretStore {             // macOS キーチェーン（R12）。テストはメモリの偽物
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
interface AuthStore { ... }         // passkeys・recovery_codes・sessions・auth_events・app_settings
interface BackupStore { ... }       // backup_runs、app_settings のバックアップの項目
```
