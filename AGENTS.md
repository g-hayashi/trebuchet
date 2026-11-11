# AGENTS.md

このリポジトリで作業するエージェント（および人間の開発者）向けの手順と規約。
個人事業主向けの会計アプリ（ローカル専用、Mac）。pnpm モノレポ。

## 構成と依存の向き

```
apps/web ──────────────→ packages/schema
apps/server ──→ packages/db ──→ packages/domain ──→ packages/schema
packages/db ──→ packages/schema
apps/server ──→ packages/domain
apps/server ──→ packages/schema
```

| パッケージ | 役割 | 制約 |
|---|---|---|
| `packages/schema` | Zod スキーマ（API と入力の形）、共有の定数 | 他のパッケージに依存しない |
| `packages/domain` | 業務ルール（仕訳の検証、締め、帳票、ユースケース） | **純粋関数のみ**。`node:fs` / `node:sqlite`、DB、Hono、React を import しない |
| `packages/db` | SQLite（better-sqlite3-multiple-ciphers + Drizzle。`src/driver.ts`、ADR 0001・0011）、マイグレーション、リポジトリ実装 | DB へのアクセスはここに閉じる |
| `apps/server` | Hono の API サーバー（`127.0.0.1:8787`） | HTTP の入出力と DI の組み立て。業務ルールは書かない |
| `apps/web` | React + Vite の画面（`http://localhost:5173`、`/api` は 8787 へ proxy） | 業務ルールを持たない。`@trebuchet/schema` に依存する |

- `packages/domain` の import 禁止は `biome.json` の `noRestrictedImports` が機械的に止める（止まるのは列挙した import だけ。`node:` の他のモジュールや `zod` の直接 import はレビューで確認する）。
- パッケージ名は `@trebuchet/schema`・`domain`・`db`・`server`・`web`。
- `packages/domain`・`packages/db` は `@trebuchet/schema` に依存する。`schema` は Zod に依存する。
- `apps/web` は `@trebuchet/server` を devDependency に持つ。`hc<AppType>` のために型だけを import する（`import type`）。実行時のコードは参照しない。

## コマンド

| 目的 | コマンド |
|---|---|
| 開発サーバー（server 8787 と web 5173） | `pnpm dev` |
| web をビルドして server を起動（web と API を `http://localhost:8787` から配信。004 US4。Tailscale の手順は README） | `pnpm start` |
| 全テスト（Vitest の全プロジェクト） | `pnpm test` |
| 1 プロジェクトのテスト | `pnpm vitest run --project <domain\|db\|server\|web\|schema>` |
| 型チェック（全パッケージ + scripts） | `pnpm typecheck` |
| Lint（Biome） | `pnpm lint` |
| 整形（Biome で書き換え） | `pnpm format` |
| マニュアルの更新漏れの検知（CI に含まれる。012） | `pnpm manual:check` |
| マニュアルの画像の撮影と確認版の更新（`manual:capture` → `manual:record`。012。手順は `docs/features/012-app-manual.md`） | `pnpm manual:update` |
| 性能計測（帳票・決算書・資産・証憑の検索・`GET /home`。001・003・009・010・011） | `pnpm bench:reports` |
| 性能計測（freee 取込。002） | `pnpm bench:import` |
| 性能計測（バックアップ。004） | `pnpm bench:backup` |
| 性能計測（明細の CSV の読み取り・確認・候補。007。AI は呼ばない） | `pnpm bench:statements` |
| 列の案の評価（端末内の AI を呼ぶ。007） | `pnpm eval:columns` |
| 明細の推定の評価（ルール → 端末内 → 外部。011） | `pnpm eval:statements` |
| 証憑の読み取りの評価（外部の AI を呼ぶ。010） | `pnpm eval:receipts` |
| バックアップ（`.tbk`）の復元（server を止めて行う。回復キーを標準入力から読む） | `pnpm restore -- --file <.tbk> [--data-dir <dir>] [--receipts-dir <dir>] [--allow-missing-receipts] [--yes]` |
| freee の書き出しの確認と照合（実データ、ローカル専用。`work/` を読む。`--continue` は使えない: 008） | `pnpm verify:freee` |
| 青色申告決算書の照合（実データ、ローカル専用。`work/` を読む） | `pnpm verify:tax-return` |
| 宣伝動画（MP4 と GIF、日本語・英語。ffmpeg が要る） | `pnpm promo:record` |
| E2E（Playwright、Chromium） | `pnpm --filter @trebuchet/web e2e` |
| web のビルド（`routeTree.gen.ts` を再生成する） | `pnpm --filter @trebuchet/web build` |

- bench・eval・restore・verify・promo の使い方（環境変数、しきい値、フラグ）は、`scripts/` の各スクリプトの先頭のコメント（`promo:capture` は `apps/web/e2e/promo.capture.ts`）と該当の機能の文書（`docs/features/`。restore の証憑のフラグは 010）にある。`eval:*`・`verify:*`・`promo:*`・E2E・bench は、AI や実データや端末の環境が要るので CI に含まれない。評価の結果は `.tmp/eval-*/` に残り前回と比べる。
- CI（`.github/workflows/ci.yml`）は `pnpm typecheck`、`pnpm lint`、`pnpm manual:check`、`pnpm test` を実行する。
- 変更を終える前に、少なくとも `pnpm typecheck`、`pnpm lint`、`pnpm test` を通す。マニュアルに関わる変更は `pnpm manual:check` も通す。

## 開発の進め方

全機能（001〜）の `tasks.md` に共通のルール。**各規則の詳細（関数名、置き場所、例外の扱い）は [docs/development.md](docs/development.md)**。各 `tasks.md` の「全タスク共通のルール」は、これに従うことと、その機能に固有の規則だけを書く。

- **テストを先に書く（TDD）**（Constitution V）。失敗するテストを確認してから実装する。
- **複数回書くユースケースは `TenantUnitOfWork` の中で書く**。fn が `err` か例外で全部巻き戻る。ルートで `db.transaction` を張らず、UnitOfWork を別の `run` の中から呼ばない。
- **監査の記録は `auditEntry`（domain の `audit.ts`）で作る**。
- **月・日付の計算は domain の `dates.ts` に集める**。月の計算・`pad`・月の正規表現を書き直さない。
- **db のリポジトリの共通部品は `packages/db/src/internal.ts`**（外へは export しない）。
- **server のルートは `respond(c, result, ...)` で結果を返す**（失敗は `fail`）。`:year` は `validate("param", FiscalYearParam)`、時刻を使うルートは `routes(options: RouteOptions)` で clock を受け取る。
- **不変条件**は `specs/INVARIANTS.md`（INV-1〜77 の索引。正本は各 `data-model.md` §4）。対応するテストは fast-check の性質テスト（`fc.assert(fc.property(...))` を直接呼ぶ。`@fast-check/vitest` は使わない。001/R6）。
- **テストの共通部品を使う**（db・domain・server・bench。同じ準備を各ファイルに書かない）。
- **web のテストはコンポーネントテスト**。新しい API を呼ぶ画面は `mock-api.ts` に既定の応答を足し、ルートを足したら `pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成してから typecheck する。
- **web の API 呼び出しと query key は `features/<機能>/api.ts`**。画面・ルートで `api.api...`・`unwrap(...)` を直接呼ばない。
- **web で仕訳が変わる操作の後は `invalidateLedger(queryClient, entityId)`**（`lib/queries.ts`）。
- **server のテストは `apps/server/test/helpers.ts` を使い、`app.request()` で呼ぶ**。サンドボックスではローカルのポートを開けないので、server を起動する手順（dev サーバー、E2E）は利用者の端末で行う。
- **Node 26 の型の除去で直接実行する**（`tsx` は使わない）。相対 import に `.ts`、`enum`・パラメーター・プロパティ・`namespace` を使わない、型だけの import は `import type`、任意プロパティは `?: T | undefined`。
- **金額は整数**（`0 < amount < 1e12`）。ID は `IdGenerator`、日時は `Clock` のポートで domain に渡す（domain で `Date.now()`・`new Date()`・`randomUUIDv7` を直接呼ばない）。
- **依存（npm パッケージ）を足すときは、`pnpm add` の前に利用者の承認を得る**。
- **エラーコード・共有の型・契約を変えるタスクでは、`grep -rn <値> packages apps scripts` で同じ値を参照するテストと実装を探し、担当外のプロジェクトも含めて直す**。
- **マイグレーション**: `drizzle-kit generate` の後、新しい表の `);` を `) STRICT;` に置き換える（001/R2、001/T024）。トリガー・ビュー・部分 UNIQUE は `--custom` の手書きの SQL。
- **開発中は利用者がいない**ため、既存データの移行・旧版との互換は考えない。帳簿の不変条件（Constitution I）は守る。
- **部下（サブエージェント）への指示**: 担当のプロジェクトのテストだけを実行させる（`pnpm vitest run --project <name>`）。整形は触ったファイルだけ、変更は Edit / Write で行う。全体の検証は最後にメインが 1 回行う。
- **コミットメッセージは Conventional Commits**（タスク ID を入れる）。
- **tasks.md は 1 タスク 1 行を 500 字程度までにする**。細部は research・data-model・contracts の節に置き、節の番号で参照する。

## 機能ごとの文書

機能ごとの置き場所（層の表）と固有の規則は `docs/features/` にある。**その機能のコードを触る前に、該当する文書を読む**。仕様は `specs/<機能>/`、設計判断は `docs/adr/`。

| 機能 | 文書 | 主な ADR |
|---|---|---|
| 001 帳簿の中核 | `specs/001-ledger-core/`（開発の規約は `docs/development.md`） | 0001〜0003 |
| 002 freee の取込 | `docs/features/002-freee-import.md` | 0004 |
| 003 決算書（按分、少額の特例、税制の値の足し方） | `docs/features/003-tax-return.md` | 0005 |
| 004 認証とバックアップ、リモート（Tailscale） | `docs/features/004-auth-backup.md` | 0006・0007（鍵は 008 で置換） |
| 005 請求と定期仕訳 | `docs/features/005-recurring-invoicing.md` | 0008・0013 |
| 006 明細の取込と AI 仕訳 | `docs/features/006-mfme-ai-journal.md` | 0009 |
| 007 汎用の明細取込（列の対応、列の案の AI） | `docs/features/007-generic-statement-import.md` | 0010 |
| 008 パスキーと回復キーによる DB の暗号化 | `docs/features/008-passkey-vault.md` | 0011 |
| 009 定額法・一括償却資産・開業費 | `docs/features/009-depreciation-deferred.md` | 0012 |
| 010 証憑 | `docs/features/010-receipts.md` | 0014 |
| 011 画面の作り直し（骨組み、ホーム、かんたん入力） | `docs/features/011-ui-overhaul.md` | — |
| 012 アプリ内マニュアル | `docs/features/012-app-manual.md` | — |
| 013 源泉徴収（請求書の源泉徴収税額、入金時に事業主貸、年間の一覧） | `docs/features/013-withholding-tax.md` | 0015 |
| 014 デモ事業（空の一覧から作る架空のデータ、全部か無か、素材の同梱） | `docs/features/014-demo-entity.md` | — |

### 機能をまたいで守る規則

どの機能を触るときも守る。詳細は各文書。

- **実データ**: `work/` を読むのは `scripts/verify-freee-import.ts` と `scripts/verify-tax-return.ts` だけ（002・003）。出力・実データの数値・取引先名・摘要・按分率をコミット・文書・`tasks.md` に書かない。テストのフィクスチャは合成（`packages/domain/test/fixtures/`。作り方と検算は各 `README.md`）。
- **認証**: 全 `/api` に Host → CSRF → 認証の順で検査を掛ける。公開の手続きは domain の `requiresAuth` の一覧だけ（INV-29）。許す Host・オリジン・RP ID は `apps/server/src/lib/origin.ts` の 1 か所。**認証を無効にする設定・環境変数・テスト用の分岐を本番のコードに作らない**（004）。
- **鍵**: DK・DB の鍵・バックアップと証憑の鍵・回復キー・セッションのトークンを、平文でディスク・ログ・環境変数・応答に出さない（INV-51・61）。施錠中は registry・事業体・証憑を開けない（`VaultLockedError`、401 `LOCKED`）（008・010）。
- **AI へ送る情報**: `buildAiPayload`（明細）・`buildJournalEntryPayload`（仕訳の入力）を通したものだけ（INV-45）。例外は証憑の画像の `ReceiptReader` の 1 経路だけ（010、ADR 0014）。列の案の AI は端末内だけ（INV-48）。値の読み取りはプログラムだけで、AI の出力は Zod で検証する（006・007・010・011）。テストは `fm`・外部の AI を呼ばず偽物を使う。
- **AI の評価**: プロンプト・推定の経路・時間切れの値を変えるときは、変更の前後で `pnpm eval:columns`（007）／`eval:statements`（011）／`eval:receipts`（010）を実行して比べる（Constitution IV）。結果は `.tmp/eval-*/` に件数と割合だけを残す。
- **税制の値・償却率**: `seed/` の正本とマイグレーションの**両方**に、適用の期間と出典の URL つきで足す（003・009）。
- **仕訳を作る機能の仕訳**: 請求・入金の仕訳は `JOURNAL_LINKED` で通常の訂正・取消を拒む（005）。決算整理（按分・償却）は案を利用者が確かめて `createJournal` で登録する（003・009）。明細の承認だけが明細から仕訳を作る（006）。
- **作らないもの**: 銀行の自動連携（006）、申告の控えの表とアプリの中の評価（011 で削除）、互換の別名（007）。
- **web**: 各画面で `variant="default"` のボタンは 1 つ（011 の ui-shell §7）。ブラウザに覚える値は `localStorage`（DB・API に足さない）。
- **マニュアル**: 利用者の操作・表示・制約を変えたら、`docs/features/012-app-manual.md` の「更新手順」に従って対象の記事と画像を更新し、`pnpm manual:check` を通す（Codex では `$app-manual` が同じ手順を行う）。画像と本文の確認はコミットの前に行う。

## データと一時ファイル

- **実データを読まない、コミットしない**。`work/` と `data/` は実データを含む。中身を開く・要約する・テストの入力にする・コミットすることをしない。`.gitignore` で除外済み。
- 既定のデータ位置はリポジトリ直下の `data/`。`TREBUCHET_DATA_DIR` で変更できる。テストでは実データに触れないよう、一時のデータ場所を使う。
- **一時ファイルは `.tmp/` の下だけに作る**（`/tmp` や `os.tmpdir()` は使わない）。`packages/db/src/testing.ts` の `useTempDataDir` を使う。E2E と bench も `.tmp/` を使う。

## 仕様と文書

- Spec Kit の成果物は `specs/<NNN-feature>/`（001〜011、013、014）に置く: `spec.md`、`plan.md`、`research.md`、`data-model.md`、`quickstart.md`、`tasks.md`、`contracts/`、`checklists/`。例外: 008 は `design.md` と `tasks.md` だけ、012 は `docs/features/012-app-manual.md` だけ（`specs/` にない）。完了した機能の `tasks.md` と `checklists/` は記録として残す。
- **番号は機能ごとに振り直される**（research の R、タスクの T）。他の機能の番号を指すときは `001/R6`、`005/T024` の形で機能の番号をつける。不変条件の INV だけは通し番号（`specs/INVARIANTS.md`）。
- Spec Kit のテンプレート、スクリプト、憲法（`.specify/memory/constitution.md`）は `.specify/` に置く。
- Spec Kit のスキルは、Claude Code 用が `.claude/skills/speckit-*`、GitHub Copilot CLI 用が `.github/skills/speckit-*` にある。どちらも `uvx --from git+https://github.com/github/spec-kit.git@v1.2.1 specify integration upgrade <claude|copilot>` で更新する（手で片方だけを直さない）。
- Claude Code は、CLAUDE.md がないときにこの AGENTS.md を読む。リポジトリに CLAUDE.md を作らない（作る場合は `@AGENTS.md` を取り込む）。`work/` と `data/` の読み取りは `.claude/settings.json` で拒否している。
- 設計判断は `docs/adr/` に ADR として書く（`NNNN-短い名前.md`、番号は連番。書式は `0001-sqlite-driver.md`）。状態は「採用」か「置き換え: ADR NNNN」。置き換えるときは、古い ADR の状態を書き換え、新しい ADR の「関連」に古い番号を書く。
- 要件の一覧と各要件の状態は `docs/requirements.md`。
- **機能の置き場所と固有の規則は `docs/features/<NNN-feature>.md`**（ファイル名は `specs/` と同じ）。新しい機能では AGENTS.md に節を足さず、`docs/features/` に文書を足して「機能ごとの文書」の表に 1 行を足す。機能をまたぐ規則だけを「機能をまたいで守る規則」に書く（AGENTS.md は毎回の文脈に入るので短く保つ）。完了した機能の古い `tasks.md`・plan の「AGENTS.md の〇〇（00N）の節」は、今の `docs/features/00N-*.md` を指す。
- 引き継ぎメモはリポジトリにコミットしない（`.tmp/` に置く）。
- AGENTS.md は憲法と矛盾させない。

