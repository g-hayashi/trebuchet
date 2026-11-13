# AGENTS.md

このリポジトリで作業するエージェント（および人間の開発者）向けの手順と規約。
個人事業主向けの会計アプリ（ローカル専用、Mac）。pnpm モノレポ。

## 構成と依存の向き

```
apps/web ──→ packages/schema
apps/server ──→ packages/db ──→ packages/domain ──→ packages/schema
（db・server は schema にも、server は domain にも直接依存する）
```

| パッケージ | 役割 | 制約 |
|---|---|---|
| `packages/schema` | Zod スキーマ（API と入力の形）、共有の定数 | 他のパッケージに依存しない |
| `packages/domain` | 業務ルール（仕訳の検証、締め、帳票、ユースケース） | **純粋関数のみ**。`node:fs` / `node:sqlite`、DB、Hono、React を import しない（`biome.json` の `noRestrictedImports` が列挙分を止める。他の `node:` と `zod` の直接 import はレビューで確認） |
| `packages/db` | SQLite（better-sqlite3-multiple-ciphers + Drizzle。ADR 0001・0011）、マイグレーション、リポジトリ実装 | DB へのアクセスはここに閉じる |
| `apps/server` | Hono の API サーバー（`127.0.0.1:8787`） | HTTP の入出力と DI の組み立て。業務ルールは書かない |
| `apps/web` | React + Vite の画面（`http://localhost:5173`、`/api` は 8787 へ proxy） | 業務ルールを持たない。`@trebuchet/server` は `hc<AppType>` の型だけを `import type` する |

## コマンド

| 目的 | コマンド |
|---|---|
| 開発サーバー（server 8787 と web 5173） | `pnpm dev` |
| 全テスト / 1 プロジェクト | `pnpm test` / `pnpm vitest run --project <domain\|db\|server\|web\|schema>` |
| 型チェック・Lint・整形 | `pnpm typecheck`・`pnpm lint`・`pnpm format` |
| マニュアルの更新漏れの検知（012） | `pnpm manual:check` |
| web のビルド（`routeTree.gen.ts` を再生成） | `pnpm --filter @trebuchet/web build` |

- CI は `pnpm typecheck`、`pnpm lint`、`pnpm manual:check`、`pnpm test`。変更を終える前に少なくともこれを通す。
- CI の外のコマンド（`pnpm start`、bench・eval・restore・verify・promo、E2E）は [docs/development.md の「CI の外のコマンド」](docs/development.md#ci-の外のコマンド)。

## 開発の進め方

全機能の `tasks.md` に共通のルール。**詳細（関数名、置き場所、例外）は [docs/development.md](docs/development.md) にあり、コードを書く前に該当の節を読む**。毎回守る要点:

- **TDD**（Constitution V）。失敗するテストを確認してから実装する。テストの共通部品を使う。
- **複数回書くユースケースは `TenantUnitOfWork` の中**。監査は `auditEntry`、月・日付は domain の `dates.ts`、server は `respond`/`fail`、web の API は `features/<機能>/api.ts`。
- **金額は整数**（`0 < amount < 1e12`）。ID・日時は `IdGenerator`・`Clock` のポートで渡す。
- **Node 26 の型の除去で直接実行**: 相対 import に `.ts`、`enum`・パラメーター・プロパティ・`namespace` 禁止、`import type`、`?: T | undefined`。
- **依存を足す前に利用者の承認を得る**。エラーコード・共有の型・契約を変えたら `grep -rn <値> packages apps scripts` で担当外も直す。
- **部下への指示**: 担当のプロジェクトのテストだけを実行させ、整形は触ったファイルだけ、変更は Edit / Write で行わせる。全体の検証はメインが最後に 1 回。
- 不変条件は `specs/INVARIANTS.md`（fast-check の性質テスト）。開発中は利用者がいないので移行・互換は考えない。コミットは Conventional Commits（タスク ID を入れる）。

## 機能ごとの文書

**その機能のコードを触る前に、該当する文書を読む**。仕様は `specs/<機能>/`、設計判断は `docs/adr/`、文書の置き場所の規則は [docs/development.md の「仕様と文書の置き場所」](docs/development.md#仕様と文書の置き場所)。

| 機能 | 文書 | 主な ADR |
|---|---|---|
| 001 帳簿の中核 | `specs/001-ledger-core/`・`docs/development.md` | 0001〜0003 |
| 002 freee の取込 | `docs/features/002-freee-import.md` | 0004 |
| 003 決算書（按分、少額の特例、税制の値） | `docs/features/003-tax-return.md` | 0005 |
| 004 認証とバックアップ、リモート | `docs/features/004-auth-backup.md` | 0006・0007 |
| 005 請求と定期仕訳 | `docs/features/005-recurring-invoicing.md` | 0008・0013 |
| 006 明細の取込と AI 仕訳 | `docs/features/006-mfme-ai-journal.md` | 0009 |
| 007 汎用の明細取込 | `docs/features/007-generic-statement-import.md` | 0010 |
| 008 パスキーと回復キーによる DB の暗号化 | `docs/features/008-passkey-vault.md` | 0011 |
| 009 定額法・一括償却資産・開業費 | `docs/features/009-depreciation-deferred.md` | 0012 |
| 010 証憑 | `docs/features/010-receipts.md` | 0014 |
| 011 画面の作り直し | `docs/features/011-ui-overhaul.md` | — |
| 012 アプリ内マニュアル | `docs/features/012-app-manual.md` | — |
| 013 源泉徴収 | `docs/features/013-withholding-tax.md` | 0015 |
| 014 デモ事業 | `docs/features/014-demo-entity.md` | — |

### 機能をまたいで守る規則

どの機能を触るときも守る。詳細は各文書。

- **実データ**: `work/` を読むのは `scripts/verify-freee-import.ts` と `scripts/verify-tax-return.ts` だけ（002・003）。出力・実データの数値・取引先名・摘要・按分率をコミット・文書・`tasks.md` に書かない。テストのフィクスチャは合成（`packages/domain/test/fixtures/`）。
- **認証**: 全 `/api` に Host → CSRF → 認証の順で検査を掛ける。公開の手続きは domain の `requiresAuth` の一覧だけ（INV-29）。許す Host・オリジン・RP ID は `apps/server/src/lib/origin.ts` の 1 か所。**認証を無効にする設定・環境変数・テスト用の分岐を本番のコードに作らない**（004）。
- **鍵**: DK・DB の鍵・バックアップと証憑の鍵・回復キー・セッションのトークンを、平文でディスク・ログ・環境変数・応答に出さない（INV-51・61）。施錠中は registry・事業体・証憑を開けない（`VaultLockedError`、401 `LOCKED`）（008・010）。
- **AI へ送る情報**: `buildAiPayload`（明細）・`buildJournalEntryPayload`（仕訳の入力）を通したものだけ（INV-45）。例外は証憑の画像の `ReceiptReader` の 1 経路だけ（010、ADR 0014）。列の案の AI は端末内だけ（INV-48）。AI の出力は Zod で検証する。テストは `fm`・外部の AI を呼ばず偽物を使う。
- **AI の評価**: プロンプト・推定の経路・時間切れの値を変えるときは、前後で `pnpm eval:columns`／`eval:statements`／`eval:receipts` を比べる（Constitution IV）。結果は件数と割合だけを残す。
- **税制の値・償却率**: `seed/` の正本とマイグレーションの**両方**に、適用の期間と出典の URL つきで足す（003・009）。
- **仕訳を作る機能**: 請求・入金の仕訳は `JOURNAL_LINKED` で通常の訂正・取消を拒む（005）。決算整理は案を利用者が確かめて `createJournal` で登録する（003・009）。明細の承認だけが明細から仕訳を作る（006）。
- **作らないもの**: 銀行の自動連携（006）、申告の控えの表とアプリの中の評価（011 で削除）、互換の別名（007）。
- **web**: 各画面で `variant="default"` のボタンは 1 つ（011 の ui-shell §7）。ブラウザに覚える値は `localStorage`。
- **マニュアル**: 利用者の操作・表示・制約を変えたら、`docs/features/012-app-manual.md` の「更新手順」で記事と画像を更新し、`pnpm manual:check` を通す（Codex では `$app-manual`）。画像と本文の確認はコミットの前に行う。

## データと一時ファイル

- **実データを読まない、コミットしない**。`work/` と `data/` は実データを含む（中身を開く・要約する・テストの入力にしない）。既定のデータ位置は `data/`（`TREBUCHET_DATA_DIR` で変更）。
- **一時ファイルは `.tmp/` の下だけ**（`/tmp`・`os.tmpdir()` は使わない。テストは `useTempDataDir`）。引き継ぎメモも `.tmp/` に置き、コミットしない。
