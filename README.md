# trebuchet

個人事業主向けの複式簿記の会計アプリ。自分の Mac だけで動かす（ローカル専用）。1 人の個人事業主が使い、パスキー（Touch ID）でサインインする。

## 機能

| 機能 | 内容 | 仕様と手順 |
|---|---|---|
| 001 帳簿コア | 事業体、勘定科目、仕訳の入力・訂正・取消、総勘定元帳・試算表などの帳票、期間の締め | [specs/001-ledger-core/](specs/001-ledger-core/) |
| 002 freee の取込 | freee の仕訳帳・総勘定元帳の取込、期首残高、元帳との照合、取消 | [specs/002-freee-import/](specs/002-freee-import/) |
| 003 決算書 | 青色申告決算書（一般用）の作成、家事按分、少額減価償却資産、控除の判定 | [specs/003-tax-return/](specs/003-tax-return/) |
| 004 認証とバックアップ | パスキーのサインイン、回復コード、暗号化したバックアップ（`.tbk`）と復元。Tailscale によるリモートの利用は保留 | [specs/004-auth-backup/](specs/004-auth-backup/) |
| 005 請求と定期仕訳 | 工数、請求書の発行（印刷）、入金の消し込み、定期仕訳 | [specs/005-recurring-invoicing/](specs/005-recurring-invoicing/) |

要件の一覧と状態は [docs/requirements.md](docs/requirements.md)。各機能の動作確認の手順は、上の `specs/*/quickstart.md`。

## 必要なもの

- Node.js 26 以上（`package.json` の `engines` は `>=26.5.1`、`.nvmrc` は `26`）
- pnpm 11.3.0（`package.json` の `packageManager` で指定）

## セットアップ

```sh
pnpm install
```

`better-sqlite3` は macOS arm64 向けのビルド済みバイナリを使う。ビルド手順は不要。

## 起動

```sh
pnpm dev
```

- API サーバー: `http://127.0.0.1:8787`（`/api/health` で確認）
- 画面: `http://localhost:5173`（`127.0.0.1:5173` ではパスキーが使えない。必ず `localhost` で開く）

サーバーは `127.0.0.1`（ループバック）だけで待ち受ける。外部からは接続できない。初回はパスキーの登録の画面になり、登録のあとに**回復コード**が表示される。「控えた」を押す前に、紙などに書いて Mac とは別の場所に保管する。

テスト、型チェック、lint、E2E、性能計測、バックアップの復元などのコマンドは [AGENTS.md](AGENTS.md) の「コマンド」にある。

## データの場所

- 既定: リポジトリ直下の `data/`（初回起動時に作られる）
- 変更: 環境変数 `TREBUCHET_DATA_DIR` にディレクトリを指定する

```text
<データディレクトリ>/
├── registry.sqlite          事業体の一覧と認証の情報
└── tenants/
    └── <事業体ID>.sqlite    事業体ごとの帳簿（1 事業体 1 ファイル）
```

- 帳簿は事業体ごとに別の SQLite ファイルに保存する（[ADR 0002](docs/adr/0002-tenant-per-db-file.md)）。SQLite は WAL モードで開く
- `data/` と `work/` は実データを含む。Git にコミットしない（`.gitignore` で除外済み）
- バックアップは、設定した置き場所へパスフレーズで暗号化して書く（[ADR 0007](docs/adr/0007-backup-format.md)）。**パスフレーズを失うとバックアップは復元できない**（回復の手段がない）。Mac の外にも控える
- `data/` を手でコピーする場合は、サーバーを止めてから行い、`-wal` と `-shm` のファイルも一緒にコピーする

## ドキュメント

- [AGENTS.md](AGENTS.md): 構成、依存の向き、コマンド、開発の規約
- [specs/INVARIANTS.md](specs/INVARIANTS.md): 不変条件（INV-1〜39）の索引
- [docs/requirements.md](docs/requirements.md): 要件定義と各要件の状態
- [docs/adr/](docs/adr/): 設計判断の記録
- [.specify/memory/constitution.md](.specify/memory/constitution.md): 憲法
