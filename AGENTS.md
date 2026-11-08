# AGENTS.md

このリポジトリで作業するエージェント（および人間の開発者）向けの手順と規約。
個人事業主向けの会計アプリ（ローカル専用、Mac）。pnpm モノレポ。

## 構成と依存の向き

```
apps/web ──────────────→ packages/schema
apps/server ──→ packages/db ──→ packages/domain ──→ packages/schema
apps/server ──→ packages/domain
apps/server ──→ packages/schema
```

| パッケージ | 役割 | 制約 |
|---|---|---|
| `packages/schema` | Zod スキーマ（API と入力の形）、共有の定数 | 他のパッケージに依存しない |
| `packages/domain` | 業務ルール（仕訳の検証、締め、帳票、ユースケース） | **純粋関数のみ**。`node:fs` / `node:sqlite`、DB、Hono、React を import しない |
| `packages/db` | SQLite（better-sqlite3 + Drizzle）、マイグレーション、リポジトリ実装 | DB へのアクセスはここに閉じる |
| `apps/server` | Hono の API サーバー（`127.0.0.1:8787`） | HTTP の入出力と DI の組み立て。業務ルールは書かない |
| `apps/web` | React + Vite の画面（`http://localhost:5173`、`/api` は 8787 へ proxy） | 業務ルールを持たない。`@trebuchet/schema` に依存する |

- `packages/domain` の import 禁止は `biome.json` の `noRestrictedImports` が機械的に止める（止まるのは列挙した import だけ。`node:` の他のモジュールや `zod` の直接 import はレビューで確認する）。
- パッケージ名は `@trebuchet/schema`・`domain`・`db`・`server`・`web`。
- `packages/domain` は `@trebuchet/schema` に依存する。`schema` は Zod に依存する。
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
| 性能計測（SC-004 の仕訳 2,000 件、003 の SC-006 の決算書、009 の SC-005 の資産の画面、010 の SC-002 の証憑 5,000 件の検索、011 の SC-003 の `GET /home`。認証つき） | `pnpm bench:reports` |
| 性能計測（freee 取込の 500 仕訳、002 の SC-002） | `pnpm bench:import` |
| 性能計測（バックアップ、004 の SC-005） | `pnpm bench:backup`（環境変数でしきい値と件数を変えられる。使い方は `scripts/bench-backup.ts` の先頭のコメント） |
| 性能計測（明細 500 件の CSV の読み取り・確認・候補、007 の SC-006。AI は呼ばない） | `pnpm bench:statements`（環境変数でしきい値・回数・件数を変えられる。使い方は `scripts/bench-statements.ts` の先頭のコメント） |
| 列の案の評価（端末内の AI `fm serve` を呼ぶ。合成の例。CI に含まれない） | `pnpm eval:columns`（結果を `.tmp/eval-columns/` に残し前回と比べる。使い方は `scripts/eval-column-suggestions.ts` の先頭のコメント） |
| 明細の推定の評価（ルール → 端末内 → 外部。合成の明細。CI に含まれない） | `pnpm eval:statements`（接続先は環境変数。結果を `.tmp/eval-statements/` に残し前回と比べる。使い方は `scripts/eval-statements.ts` の先頭のコメント） |
| 証憑の読み取りの評価（外部の AI を呼ぶ。合成の画像。CI に含まれない） | `pnpm eval:receipts`（接続先は環境変数。結果を `.tmp/eval-receipts/` に残し前回と比べる。使い方は `scripts/eval-receipts.ts` の先頭のコメント） |
| バックアップ（`.tbk`）の復元（server を止めて行う） | `pnpm restore -- --file <.tbk> [--data-dir <dir>] [--receipts-dir <dir>] [--allow-missing-receipts] [--yes]`（回復キーを標準入力から読む。証憑のフラグは `docs/features/010-receipts.md`。`scripts/restore-backup.ts` の先頭のコメント） |
| freee の書き出しの確認と照合（実データ、ローカル専用） | `pnpm verify:freee`（`work/` を読む。`scripts/verify-freee-import.ts` の先頭のコメント。`--continue` は 008 以降使えない: 実行ごとに乱数の DK で作るため） |
| 青色申告決算書の照合（実データ、ローカル専用） | `pnpm verify:tax-return`（`work/` を読む。`scripts/verify-tax-return.ts` の先頭のコメント） |
| E2E（Playwright、Chromium） | `pnpm --filter @trebuchet/web e2e` |
| web のビルド（`routeTree.gen.ts` を再生成する） | `pnpm --filter @trebuchet/web build` |

- CI（`.github/workflows/ci.yml`）は `pnpm typecheck`、`pnpm lint`、`pnpm test` を実行する。E2E、bench、`verify:*` は CI に含まれない。
- 変更を終える前に、少なくとも `pnpm typecheck`、`pnpm lint`、`pnpm test` を通す。

## 開発の進め方

全機能（001〜）の `tasks.md` に共通のルール。各 `tasks.md` の「全タスク共通のルール」は、これに従うことと、その機能に固有の規則だけを書く。

- **テストを先に書く（TDD）**（Constitution V）。失敗するテストを確認してから実装する。
- **複数回書くユースケースは `TenantUnitOfWork` の中で書く**（`packages/domain/src/ports.ts`。db の実装は `drizzleUnitOfWork`、domain のテストの偽物は `FakeUnitOfWork`）。`uow.run(fn)` の fn が `err` を返すか例外を投げれば、fn の中の書き込みはすべて巻き戻る（書く順序で原子性を守る必要はない）。ユースケースが自分で UnitOfWork を使い、ルートで `db.transaction` を張らない。UnitOfWork を受け取るユースケースを、別の `run` の中から呼ばない（入れ子のトランザクションにならない）。001 のリポジトリ 1 つの `ledger.transaction`・`repo.transaction` も同じく `err` か例外で巻き戻る（入れ子は SAVEPOINT。db の実装はどれも `packages/db/src/rollback.ts` の `inTransaction` を通す）。
- **監査の記録は `auditEntry`（`packages/domain/src/audit.ts`）で作る**。before・after は値のまま渡す（null・undefined は null、それ以外は JSON）。書き込みと同じ日時にするときは `at` を渡す。型は `AuditEntry<対象, 操作>`。
- **月・日付（`YYYY-MM`、`YYYY-MM-DD`）の計算は `packages/domain/src/dates.ts` に集める**（`addDays`、`monthEnd`、`dateInMonth`、`addMonths`、`monthIndex`、`monthOfDate` など）。ユースケース・各機能で月の計算・`pad`・月の正規表現を書き直さない。
- **db のリポジトリの共通部品は `packages/db/src/internal.ts`**（`TenantConn`、`insertionOrder`・`rowidOf`、`asTaxCategory`）。リポジトリごとに型や `rowid` の並びを書き直さない（外へは export しない）。
- **server のルートは `respond(c, result, (v) => c.json(..., status))`**（`apps/server/src/errors.ts`）で結果を返す（失敗は `fail`）。パスの `:year` は `validate("param", FiscalYearParam)`（`validator.ts` が 4 桁でない年を「会計期間が見つかりません」にする）。時刻を使うルートは `routes(options: RouteOptions)` で clock を受け取り、`createApp({ clock })` が全ルートに渡す。Zod の issue は `validationError`（`errors.ts`）で `details.issues` にする。
- **不変条件**は `specs/INVARIANTS.md`（INV-1〜77 の索引。正本は各 `data-model.md` §4）。対応するテストは fast-check の性質テストで書く。`fc.assert(fc.property(...))` を直接呼ぶ（`@fast-check/vitest` は使わない。001/R6）。
- **テストの共通部品を使う**（同じ準備を各ファイルに書かない）。db: `packages/db/src/testing.ts` の `createTestEntity`・`accountIdOf`・`useTempDataDir`・`NOW`/`TODAY`。domain: `packages/domain/test/fakes/`（ストアごとのフェイク。`fakes.ts` は再エクスポート）、`test-dates.ts`（`NOW`/`TODAY` の正本）、`ledger-setup.ts`（`setupBase`・`accountIdOf`）。server: `apps/server/test/helpers.ts`（`createTestEntity`・`accountLookup`・`errorOf`・`json`・`okBody`・`makeClock`。`backup-helpers.ts`・`invoicing-helpers.ts` はこれを拡張する）。bench: `scripts/lib/bench-common.ts`。
- **web のテストはコンポーネントテスト**（Testing Library + jsdom。`apps/web/test/render-route.tsx`、`mock-api.ts`、置き場所は `apps/web/test/routes/`）。テストのためだけに node 専用のロジックを別ファイルに切り出さない。新しい API を呼ぶ画面を足したら `mock-api.ts` に既定の応答を足し、既存の web のテストが落ちないことを確かめる。ルートを足したら `pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成してから typecheck する。
- **web の API 呼び出しと query key は `features/<機能>/api.ts`**。画面・ルートのファイルで `api.api...` や `unwrap(...)` を直接呼ばない。`lib/queries.ts` には機能をまたぐ `invalidateLedger` だけを置く。
- **web で仕訳が変わる操作（登録・訂正・取消、請求・入金・定期仕訳・決算整理による登録）の後は `invalidateLedger(queryClient, entityId)`**（`lib/queries.ts`）。仕訳・帳票・請求・定期仕訳・決算書の query をまとめて読み直す。
- **server のテスト**は `apps/server/test/helpers.ts` の `createTestSession`・`testHeaders`（と `createTestEntity`）を使い、`app.request()` で呼ぶ。サンドボックスではローカルのポートを開けないので、server を起動する手順（dev サーバー、E2E）は利用者の端末で行う。
- **Node 26 の型の除去で直接実行する**（`tsx` は使わない）。次を守る:
  - 相対 import は `.ts` を付ける（`allowImportingTsExtensions`。web は bundler の書き方）
  - `enum`、パラメーター・プロパティ、`namespace` を使わない（`erasableSyntaxOnly`）
  - 型だけの import は `import type` と書く（`verbatimModuleSyntax`）
  - 任意プロパティは `?: T | undefined`（`exactOptionalPropertyTypes`）
- **金額は整数**（`0 < amount < 1e12`）。浮動小数で金額を計算しない。ID は `IdGenerator`、日時は `Clock` のポートで domain に渡す。domain で `Date.now()`・`new Date()`・`randomUUIDv7` を直接呼ばない。
- **依存（npm パッケージ）を足すときは、`pnpm add` の前に利用者の承認を得る**。各機能の plan が足してよいものを決める。
- **エラーコード・共有の型・契約を変えるタスクでは、同じ値を参照するテストと実装を `grep -rn <値> packages apps scripts` で探し、担当外のプロジェクトも含めて直す**。
- **マイグレーションの再生成**: `drizzle-kit generate` は `STRICT` を出力しない。生成後、新しい表の `);` を `) STRICT;` に置き換える（001/R2、001/T024）。再生成のたびに同じ置き換えが必要。`tenant-store` のテストが `STRICT` を確認する。
- **トリガー・ビュー・部分 UNIQUE**は `drizzle-kit generate --custom` で手書きの SQL として追加する（001/R2）。
- **開発中は利用者がいない**ため、既存データの移行・旧版との互換は考えない。帳簿の不変条件（Constitution I）は守る。
- **部下（サブエージェント）への指示**: 担当のプロジェクトのテストだけを実行させる（`pnpm vitest run --project <name>`）。整形は触ったファイルだけに掛け、ファイルの変更は Edit / Write で行う。全体の検証（lint、型、全テスト、ビルド、E2E）は最後にメインが 1 回行う。
- **コミットメッセージは Conventional Commits**（タスク ID を入れる）。
- **tasks.md は 1 タスク 1 行を 500 字程度までにする**。長くなる細部は research・data-model・contracts の節に置き、タスクからは節の番号で参照する。

## 機能ごとの文書

機能ごとの置き場所（層の表）と固有の規則は `docs/features/` にある。**その機能のコードを触る前に、該当する文書を読む**。仕様は `specs/<機能>/`、設計判断は `docs/adr/`。

| 機能 | 文書 | 主な ADR |
|---|---|---|
| 001 帳簿の中核 | `specs/001-ledger-core/`（このファイルの「開発の進め方」） | 0001〜0003 |
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
- **マニュアル**: 利用者の操作・表示・制約を変えたら `$app-manual` の手順で対象の記事と画像を更新し、`pnpm manual:check` を通す。撮影と確認版の更新は `pnpm manual:update`（`docs/features/012-app-manual.md`）。画像と本文の確認はコミットの前に行う。

## データと一時ファイル

- **実データを読まない、コミットしない**。`work/` と `data/` は実データを含む。中身を開く・要約する・テストの入力にする・コミットすることをしない。`.gitignore` で除外済み。
- 既定のデータ位置はリポジトリ直下の `data/`。`TREBUCHET_DATA_DIR` で変更できる。テストでは実データに触れないよう、一時のデータ場所を使う。
- **一時ファイルは `.tmp/` の下だけに作る**（`/tmp` や `os.tmpdir()` は使わない）。`packages/db/src/testing.ts` の `useTempDataDir` を使う。E2E と bench も `.tmp/` を使う。

## 仕様と文書

- Spec Kit の成果物は `specs/<NNN-feature>/`（001〜011）に置く: `spec.md`、`plan.md`、`research.md`、`data-model.md`、`quickstart.md`、`tasks.md`（`contracts/`、`checklists/` がある機能もある）。完了した機能の `tasks.md` と `checklists/` は記録として残す。
- **番号は機能ごとに振り直される**（research の R、タスクの T）。他の機能の番号を指すときは `001/R6`、`005/T024` の形で機能の番号をつける。不変条件の INV だけは通し番号（`specs/INVARIANTS.md`）。
- Spec Kit のテンプレート、スクリプト、憲法（`.specify/memory/constitution.md`）は `.specify/` に置く。
- Spec Kit のスキルは、Claude Code 用が `.claude/skills/speckit-*`、GitHub Copilot CLI 用が `.github/skills/speckit-*` にある。どちらも `uvx --from git+https://github.com/github/spec-kit.git@v1.2.1 specify integration upgrade <claude|copilot>` で更新する（手で片方だけを直さない）。
- Claude Code は、CLAUDE.md がないときにこの AGENTS.md を読む。リポジトリに CLAUDE.md を作らない（作る場合は `@AGENTS.md` を取り込む）。`work/` と `data/` の読み取りは `.claude/settings.json` で拒否している。
- 設計判断は `docs/adr/` に ADR として書く（`NNNN-短い名前.md`、番号は連番。書式は `0001-sqlite-driver.md`）。状態は「採用」か「置き換え: ADR NNNN」。置き換えるときは、古い ADR の状態を書き換え、新しい ADR の「関連」に古い番号を書く。
- 要件の一覧と各要件の状態は `docs/requirements.md`。
- **機能の置き場所と固有の規則は `docs/features/<NNN-feature>.md`**（ファイル名は `specs/` と同じ）。新しい機能では AGENTS.md に節を足さず、`docs/features/` に文書を足して「機能ごとの文書」の表に 1 行を足す。機能をまたぐ規則だけを「機能をまたいで守る規則」に書く（AGENTS.md は毎回の文脈に入るので短く保つ）。完了した機能の古い `tasks.md`・plan の「AGENTS.md の〇〇（00N）の節」は、今の `docs/features/00N-*.md` を指す。
- 引き継ぎメモはリポジトリにコミットしない（`.tmp/` に置く）。
- AGENTS.md は憲法と矛盾させない。

