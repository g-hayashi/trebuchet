# trebuchet

個人事業主向けの複式簿記の会計アプリ。自分の Mac だけで動かす（ローカル専用）。
仕訳の入力、総勘定元帳・試算表などの帳票、期間の締めを扱う。

- 対象: 1 人の個人事業主が使う（認証なし）
- 機能: 001（ledger-core）、002（freee-import: freee からの取込）

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
| 性能計測（freee 取込の 500 仕訳、002 の SC-002） | `pnpm bench:import` |
| freee の書き出しの確認と照合（実データ、ローカル専用） | `pnpm verify:freee` |

- E2E は API サーバーと Vite を自分で起動する。一時データは `.tmp/` に作る。
- web のビルド（`pnpm --filter @trebuchet/web build`）は `routeTree.gen.ts` を再生成する。
- CI（`.github/workflows/ci.yml`）は typecheck、lint、test を実行する。

## freee からの移行

freee の書き出しを取り込んで、帳簿を移す手順。取込のあと、期首残高を freee の元帳から読み込み、元帳と照合して確かめる。年度ごとに行う。

1. **freee で書き出す**: 年ごとに、「仕訳帳（freee 汎用形式）」と「総勘定元帳」の CSV を書き出す
2. **事業体を作る**: 最初に取り込む年を開始年度にして作る（会計期間がない日付の仕訳は取り込めない）
3. **取込 → 新しい取込**: 「仕訳帳のファイル」で仕訳帳の CSV を選ぶ。件数・期間・借方と貸方の合計が表示される。この時点で帳簿は変わらない。年初付の前年分の決算振替は判定「対象外」に出る（[ADR 0004](docs/adr/0004-freee-closing-entries.md)）
4. **対応表**: 名前から推測した「案」を確かめ、未定の freee の科目・税区分には帳簿の科目・税区分を選んで、「対応表を保存」を押す。未定がなくなると「取り込む」が押せる。保存した対応表は次の取込でも使う
5. **取り込む**: 「取り込む」を押す。同じファイルをもう一度選ぶと、取り込んだ仕訳は「取込済み」になり（「新しく取り込む仕訳はありません。」）、二重には登録されない
6. **期首残高を元帳から読み込む**: 「会計期間」→ 年度の「期首残高」→「freee の元帳から読み込む」で総勘定元帳の CSV を選ぶ。決算振替を繰り込んだ案を確かめて「保存する」
7. **元帳と照合**: 「取込」→「元帳と照合」で年度と総勘定元帳を選ぶ。すべての科目が「一致」になれば完了
8. **翌年以降**: 年ごとに 1・3〜7 を繰り返す。年度は取り込む前に作り、期首残高はその年の元帳から読み込む。前年度の帳簿の繰越との差は警告で示される。freee 側で仕訳を追加・変更・削除したときは、書き出し直したファイルを選ぶ。追加分だけが新規になり、変更・削除は警告に出るだけで、帳簿の仕訳は変わらない
9. **取消**: 取込の履歴から取込を開き、「取込を取り消す」を押す。取込のあとに訂正した仕訳があると、件数が示される。理由を入れて確定すると、仕訳は帳簿から除かれ、内容と理由は変更履歴に残る。締め済みの年度の仕訳を含む取込は取り消せない

- `work/` と `data/` は実データを含む。Git にコミットしない
- 実データでの確認は `pnpm verify:freee`（使い方は `scripts/verify-freee-import.ts` の先頭のコメント）。出力はコミットしない
- 手順の詳細と動作確認は [specs/002-freee-import/quickstart.md](specs/002-freee-import/quickstart.md)

## ドキュメント

- [AGENTS.md](AGENTS.md): 構成、依存の向き、開発の規約
- [specs/001-ledger-core/](specs/001-ledger-core/): 仕様（`spec.md`）、設計（`plan.md`、`data-model.md`、`research.md`）、手順（`quickstart.md`）、タスク（`tasks.md`）
- [specs/002-freee-import/](specs/002-freee-import/): freee 取込の仕様、設計、手順
- [docs/adr/](docs/adr/): 設計判断の記録
