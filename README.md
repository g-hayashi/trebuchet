# trebuchet

個人事業主向けの複式簿記の会計アプリ。自分の Mac だけで動かす（ローカル専用）。
仕訳の入力、総勘定元帳・試算表などの帳票、期間の締めを扱う。

- 対象: 1 人の個人事業主が使う（認証なし）
- 機能: 001（ledger-core）

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
- 画面: `http://127.0.0.1:5173`

サーバーは `127.0.0.1`（ループバック）だけで待ち受ける。外部からは接続できない。

## データの場所

- 既定: リポジトリ直下の `data/`（初回起動時に作られる）
- 変更: 環境変数 `TREBUCHET_DATA_DIR` にディレクトリを指定する

```text
<データディレクトリ>/
├── registry.sqlite          事業体の一覧のみ
└── tenants/
    └── <事業体ID>.sqlite    事業体ごとの帳簿（1 事業体 1 ファイル）
```

- 帳簿は事業体ごとに別の SQLite ファイルに保存する（[ADR 0002](docs/adr/0002-tenant-per-db-file.md)）
- SQLite は WAL モードで開く
- `data/` は実データを含む。Git にコミットしない（`.gitignore` で除外済み）
- バックアップ機能は 001 の範囲外（003 で扱う）。`data/` を手でコピーする場合は、サーバーを止めてから行い、`-wal` と `-shm` のファイルも一緒にコピーする

## テスト・検証

| 目的 | コマンド |
|---|---|
| 全テスト | `pnpm test` |
| 1 プロジェクトのテスト | `pnpm vitest run --project <domain\|db\|server\|web\|schema>` |
| 型チェック | `pnpm typecheck` |
| Lint | `pnpm lint` |
| 整形 | `pnpm format` |
| E2E（Playwright、Chromium） | `pnpm --filter @trebuchet/web e2e` |
| 性能計測（仕訳 2,000 件、SC-004） | `pnpm bench:reports` |

- E2E は API サーバーと Vite を自分で起動する。一時データは `.tmp/` に作る。
- web のビルド（`pnpm --filter @trebuchet/web build`）は `routeTree.gen.ts` を再生成する。
- CI（`.github/workflows/ci.yml`）は typecheck、lint、test を実行する。

## ドキュメント

- [AGENTS.md](AGENTS.md): 構成、依存の向き、開発の規約
- [specs/001-ledger-core/](specs/001-ledger-core/): 仕様（`spec.md`）、設計（`plan.md`、`data-model.md`、`research.md`）、手順（`quickstart.md`）、タスク（`tasks.md`）
- [docs/adr/](docs/adr/): 設計判断の記録
