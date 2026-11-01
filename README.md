# trebuchet

<img src="apps/web/public/app-icon.png" alt="硬貨と財布を載せた投石機を描いたTrebuchetのアプリアイコン" width="320" height="320" />

個人事業主向けの複式簿記の会計アプリ。自分の Mac だけで動かす（ローカル専用）。1 人の個人事業主が使い、パスキー（Touch ID）でサインインする。

## 機能

| 機能 | 内容 | 仕様と手順 |
|---|---|---|
| 001 帳簿コア | 事業体、勘定科目、仕訳の入力・訂正・取消、総勘定元帳・試算表などの帳票、期間の締め | [specs/001-ledger-core/](specs/001-ledger-core/) |
| 002 freee の取込 | freee の仕訳帳・総勘定元帳の取込、期首残高、元帳との照合、取消 | [specs/002-freee-import/](specs/002-freee-import/) |
| 003 決算書 | 青色申告決算書（一般用）の作成、家事按分、少額減価償却資産、控除の判定 | [specs/003-tax-return/](specs/003-tax-return/) |
| 004 認証とバックアップ | パスキーのサインイン、暗号化したバックアップ（`.tbk`）と復元。Tailscale によるリモートの利用は保留。回復コードとパスフレーズは 008 で回復キーに替わった | [specs/004-auth-backup/](specs/004-auth-backup/) |
| 005 請求と定期仕訳 | 工数、請求書の発行（印刷）、入金の消し込み、定期仕訳 | [specs/005-recurring-invoicing/](specs/005-recurring-invoicing/) |
| 008 パスキーと DB の暗号化 | パスキー（PRF）と回復キーでデータ鍵を守り、DB 全体を暗号化する。解錠するまで帳簿を読めない | [specs/008-passkey-vault/design.md](specs/008-passkey-vault/design.md)、[ADR 0011](docs/adr/0011-passkey-prf-vault.md) |

要件の一覧と状態は [docs/requirements.md](docs/requirements.md)。各機能の動作確認の手順は、上の `specs/*/quickstart.md`。

## 必要なもの

- Node.js 26 以上（`package.json` の `engines` は `>=26.5.1`、`.nvmrc` は `26`）
- pnpm 11.3.0（`package.json` の `packageManager` で指定）

## セットアップ

```sh
pnpm install
```

SQLite のドライバー `better-sqlite3-multiple-ciphers`（DB の暗号化に使う）は macOS arm64 向けのビルド済みバイナリを使う。ビルド手順は不要。

## 起動

```sh
pnpm dev
```

- API サーバー: `http://127.0.0.1:8787`（`/api/health` で確認）
- 画面: `http://localhost:5173`（`127.0.0.1:5173` ではパスキーが使えない。必ず `localhost` で開く）

サーバーは `127.0.0.1`（ループバック）だけで待ち受ける。外部からは接続できない。起動した直後の帳簿は**施錠**されていて、パスキーで解錠するまで読めない（無操作 30 分で、またはサインアウトで施錠する）。初回は「初回の設定」の画面になり、パスキーを登録すると**回復キー**が 1 回だけ表示される。「控えた」を押す前に、紙などに書いて Mac とは別の場所に保管する。パスキーを失ったときは、回復キーで解錠して新しいパスキーを登録する。パスキーは PRF に対応したもの（iCloud キーチェーン、1Password など）が要る。**回復キーとすべてのパスキーを失うと、帳簿は読めない**（回復の手段がない）。

テスト、型チェック、lint、E2E、性能計測、バックアップの復元などのコマンドは [AGENTS.md](AGENTS.md) の「コマンド」にある。

## データの場所

- 既定: リポジトリ直下の `data/`（初回起動時に作られる）
- 変更: 環境変数 `TREBUCHET_DATA_DIR` にディレクトリを指定する

```text
<データディレクトリ>/
├── auth.sqlite              パスキー、DK を包んだ鍵、セッション、認証の記録（平文。秘密は持たない）
├── registry.sqlite          事業体の一覧と端末の設定（暗号化）
└── tenants/
    └── <事業体ID>.sqlite    事業体ごとの帳簿（1 事業体 1 ファイル。暗号化）
```

- 帳簿は事業体ごとに別の SQLite ファイルに保存する（[ADR 0002](docs/adr/0002-tenant-per-db-file.md)）。SQLite は WAL モードで開く
- `registry.sqlite` と事業体の DB は、データ鍵（DK）から作った鍵で暗号化する。DK はディスクに平文で置かず、パスキーの PRF と回復キーで包んで `auth.sqlite` に保存する（[ADR 0011](docs/adr/0011-passkey-prf-vault.md)）。初回の設定のとき、前の `registry.sqlite` と `tenants/` は `discarded-<時刻>/` に移す（消さない）
- `data/` と `work/` は実データを含む。Git にコミットしない（`.gitignore` で除外済み）
- バックアップは、設定した置き場所へ DK から作った鍵で暗号化して書く（[ADR 0007](docs/adr/0007-backup-format.md)、[ADR 0011](docs/adr/0011-passkey-prf-vault.md)）。パスフレーズはなく、新しい Mac では回復キーだけで復元できる。**回復キーとすべてのパスキーを失うとバックアップは復元できない**（回復の手段がない）。回復キーは Mac の外にも控える
- `data/` を手でコピーする場合は、サーバーを止めてから行い、`-wal` と `-shm` のファイルも一緒にコピーする

## ドキュメント

- [AGENTS.md](AGENTS.md): 構成、依存の向き、コマンド、開発の規約
- [specs/INVARIANTS.md](specs/INVARIANTS.md): 不変条件（INV-1〜54）の索引
- [docs/requirements.md](docs/requirements.md): 要件定義と各要件の状態
- [docs/adr/](docs/adr/): 設計判断の記録
- [.specify/memory/constitution.md](.specify/memory/constitution.md): 憲法
