# 開発の規約

全機能（001〜）の `tasks.md` に共通のルールの詳細。AGENTS.md の「開発の進め方」には毎回守る要点だけがあり、細部はここにある。各 `tasks.md` の「全タスク共通のルール」は、これに従うことと、その機能に固有の規則だけを書く。

## 目次

- [テストと検証](#テストと検証)
- [ドメインとユースケース](#ドメインとユースケース)
- [db](#db)
- [server](#server)
- [web](#web)
- [言語と型](#言語と型)
- [不変条件とテストの共通部品](#不変条件とテストの共通部品)
- [進め方（依存、契約の変更、マイグレーション、コミット）](#進め方依存契約の変更マイグレーションコミット)
- [CI の外のコマンド](#ci-の外のコマンド)
- [仕様と文書の置き場所](#仕様と文書の置き場所)

## テストと検証

- **テストを先に書く（TDD）**（Constitution V）。失敗するテストを確認してから実装する。
- **変更を終える前に**、少なくとも `pnpm typecheck`、`pnpm lint`、`pnpm test` を通す（CI は `pnpm typecheck`、`pnpm lint`、`pnpm manual:check`、`pnpm test`）。
- **部下（サブエージェント）への指示**: 担当のプロジェクトのテストだけを実行させる（`pnpm vitest run --project <name>`）。整形は触ったファイルだけに掛け、ファイルの変更は Edit / Write で行う。全体の検証（lint、型、全テスト、ビルド、E2E）は最後にメインが 1 回行う。
- **server のテスト**は `apps/server/test/helpers.ts` の `createTestSession`・`testHeaders`（と `createTestEntity`）を使い、`app.request()` で呼ぶ。サンドボックスではローカルのポートを開けないので、server を起動する手順（dev サーバー、E2E）は利用者の端末で行う。

## ドメインとユースケース

- **複数回書くユースケースは `TenantUnitOfWork` の中で書く**（`packages/domain/src/ports.ts`。db の実装は `drizzleUnitOfWork`、domain のテストの偽物は `FakeUnitOfWork`）。`uow.run(fn)` の fn が `err` を返すか例外を投げれば、fn の中の書き込みはすべて巻き戻る（書く順序で原子性を守る必要はない）。ユースケースが自分で UnitOfWork を使い、ルートで `db.transaction` を張らない。UnitOfWork を受け取るユースケースを、別の `run` の中から呼ばない（入れ子のトランザクションにならない）。001 のリポジトリ 1 つの `ledger.transaction`・`repo.transaction` も同じく `err` か例外で巻き戻る（入れ子は SAVEPOINT。db の実装はどれも `packages/db/src/rollback.ts` の `inTransaction` を通す）。
- **監査の記録は `auditEntry`（`packages/domain/src/audit.ts`）で作る**。before・after は値のまま渡す（null・undefined は null、それ以外は JSON）。書き込みと同じ日時にするときは `at` を渡す。型は `AuditEntry<対象, 操作>`。
- **月・日付（`YYYY-MM`、`YYYY-MM-DD`）の計算は `packages/domain/src/dates.ts` に集める**（`addDays`、`monthEnd`、`dateInMonth`、`addMonths`、`monthIndex`、`monthOfDate` など）。ユースケース・各機能で月の計算・`pad`・月の正規表現を書き直さない。
- **金額は整数**（`0 < amount < 1e12`）。浮動小数で金額を計算しない。ID は `IdGenerator`、日時は `Clock` のポートで domain に渡す。domain で `Date.now()`・`new Date()`・`randomUUIDv7` を直接呼ばない。

## db

- **db のリポジトリの共通部品は `packages/db/src/internal.ts`**（`TenantConn`、`insertionOrder`・`rowidOf`、`asTaxCategory`）。リポジトリごとに型や `rowid` の並びを書き直さない（外へは export しない）。

## server

- **server のルートは `respond(c, result, (v) => c.json(..., status))`**（`apps/server/src/errors.ts`）で結果を返す（失敗は `fail`）。パスの `:year` は `validate("param", FiscalYearParam)`（`validator.ts` が 4 桁でない年を「会計期間が見つかりません」にする）。時刻を使うルートは `routes(options: RouteOptions)` で clock を受け取り、`createApp({ clock })` が全ルートに渡す。Zod の issue は `validationError`（`errors.ts`）で `details.issues` にする。

## web

- **web のテストはコンポーネントテスト**（Testing Library + jsdom。`apps/web/test/render-route.tsx`、`mock-api.ts`、置き場所は `apps/web/test/routes/`）。テストのためだけに node 専用のロジックを別ファイルに切り出さない。新しい API を呼ぶ画面を足したら `mock-api.ts` に既定の応答を足し、既存の web のテストが落ちないことを確かめる。ルートを足したら `pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成してから typecheck する。
- **web の API 呼び出しと query key は `features/<機能>/api.ts`**。画面・ルートのファイルで `api.api...` や `unwrap(...)` を直接呼ばない。`lib/queries.ts` には機能をまたぐ `invalidateLedger` だけを置く。
- **web で仕訳が変わる操作（登録・訂正・取消、請求・入金・定期仕訳・決算整理による登録）の後は `invalidateLedger(queryClient, entityId)`**（`lib/queries.ts`）。仕訳・帳票・請求・定期仕訳・決算書の query をまとめて読み直す。

## 言語と型

- **Node 26 の型の除去で直接実行する**（`tsx` は使わない）。次を守る:
  - 相対 import は `.ts` を付ける（`allowImportingTsExtensions`。web は bundler の書き方）
  - `enum`、パラメーター・プロパティ、`namespace` を使わない（`erasableSyntaxOnly`）
  - 型だけの import は `import type` と書く（`verbatimModuleSyntax`）
  - 任意プロパティは `?: T | undefined`（`exactOptionalPropertyTypes`）

## 不変条件とテストの共通部品

- **不変条件**は `specs/INVARIANTS.md`（INV-1〜77 の索引。正本は各 `data-model.md` §4）。対応するテストは fast-check の性質テストで書く。`fc.assert(fc.property(...))` を直接呼ぶ（`@fast-check/vitest` は使わない。001/R6）。
- **テストの共通部品を使う**（同じ準備を各ファイルに書かない）。db: `packages/db/src/testing.ts` の `createTestEntity`・`accountIdOf`・`useTempDataDir`・`testIds`・`testClock`・`statementIdOf`・`NOW`/`TODAY`。domain: `packages/domain/test/fakes/`（ストアごとのフェイク。`fakes.ts` は再エクスポート）、`test-dates.ts`（`NOW`/`TODAY` の正本）、`result.ts`（`unwrap`・`must`・`errorOf`・`codeOf`。db の testing.ts も再エクスポートする）、`ledger-setup.ts`（`setupBase`・`accountIdOf`）、`statements-setup.ts`（`setupStatements`）。UnitOfWork の巻き戻しは db の `unit-of-work.test.ts` と domain の `fake-unit-of-work.test.ts` の契約テストで全種をまとめて確かめる（機能ごとに書き直さない）。server: `apps/server/test/helpers.ts`（`createTestEntity`・`accountLookup`・`errorOf`・`json`・`jsonRequest`・`okBody`・`makeClock`・`NOW`。`backup-helpers.ts`・`invoicing-helpers.ts` はこれを拡張する）。web: `apps/web/test/fixtures.ts`（`uuid`・`ENTITY`・`account`）、`fake-timers.ts`（`useFakeClock`・`advance`。デバウンスや保存の待ちを実時間で待たない）、`render-route.tsx` の `renderTree`。bench: `scripts/lib/bench-common.ts`・`bench-client.ts`。

## 進め方（依存、契約の変更、マイグレーション、コミット）

- **依存（npm パッケージ）を足すときは、`pnpm add` の前に利用者の承認を得る**。各機能の plan が足してよいものを決める。
- **エラーコード・共有の型・契約を変えるタスクでは、同じ値を参照するテストと実装を `grep -rn <値> packages apps scripts` で探し、担当外のプロジェクトも含めて直す**。
- **マイグレーションの再生成**: `drizzle-kit generate` は `STRICT` を出力しない。生成後、新しい表の `);` を `) STRICT;` に置き換える（001/R2、001/T024）。再生成のたびに同じ置き換えが必要。`tenant-store` のテストが `STRICT` を確認する。
- **トリガー・ビュー・部分 UNIQUE**は `drizzle-kit generate --custom` で手書きの SQL として追加する（001/R2）。
- **開発中は利用者がいない**ため、既存データの移行・旧版との互換は考えない。帳簿の不変条件（Constitution I）は守る。
- **コミットメッセージは Conventional Commits**（タスク ID を入れる）。
- **tasks.md は 1 タスク 1 行を 500 字程度までにする**。長くなる細部は research・data-model・contracts の節に置き、タスクからは節の番号で参照する。

## CI の外のコマンド

AI や実データや端末の環境が要るので CI に含まれない。使い方（環境変数、しきい値、フラグ）は `scripts/` の各スクリプトの先頭のコメント（`promo:capture` は `apps/web/e2e/promo.capture.ts`）と該当の機能の文書（`docs/features/`。restore の証憑のフラグは 010）にある。評価の結果は `.tmp/eval-*/` に残り前回と比べる。

| 目的 | コマンド |
|---|---|
| web をビルドして server を起動（web と API を `http://localhost:8787` から配信。004 US4。Tailscale の手順は README） | `pnpm start` |
| マニュアルの画像の撮影と確認版の更新（`manual:capture` → `manual:record`。手順は `docs/features/012-app-manual.md`） | `pnpm manual:update` |
| 性能計測（帳票・決算書・資産・証憑の検索・`GET /home`。001・003・009・010・011） | `pnpm bench:reports` |
| 性能計測（freee 取込。002） | `pnpm bench:import` |
| 性能計測（バックアップ。004） | `pnpm bench:backup` |
| 性能計測（明細の CSV の読み取り・確認・候補。007。AI は呼ばない） | `pnpm bench:statements` |
| 列の案の評価（端末内の AI を呼ぶ。007） | `pnpm eval:columns` |
| 明細の推定の評価（ルール → 端末内 → 外部。011） | `pnpm eval:statements` |
| 証憑の読み取りの評価（外部の AI を呼ぶ。010） | `pnpm eval:receipts` |
| バックアップ（`.tbk`）の復元（server を止めて行う。回復キーを標準入力から読む） | `pnpm restore -- --file <.tbk> [--data-dir <dir>] [--receipts-dir <dir>] [--allow-missing-receipts] [--yes]` |
| freee の書き出しの確認と照合（実データ、ローカル専用。`work/` を読む。一時の事業体は実行ごとに作って消す。`--continue`・`--keep` はない: 008） | `pnpm verify:freee` |
| 青色申告決算書の照合（実データ、ローカル専用。`work/` を読む） | `pnpm verify:tax-return` |
| 宣伝動画（MP4 と GIF、日本語・英語。ffmpeg が要る） | `pnpm promo:record` |
| E2E（Playwright、Chromium） | `pnpm --filter @trebuchet/web e2e` |

## 仕様と文書の置き場所

- Spec Kit の成果物は `specs/<NNN-feature>/`（001〜011、013、014）に置く: `spec.md`、`plan.md`、`research.md`、`data-model.md`、`quickstart.md`、`tasks.md`、`contracts/`、`checklists/`。例外: 008 は `design.md` と `tasks.md` だけ、012 は `docs/features/012-app-manual.md` だけ（`specs/` にない）。完了した機能の `tasks.md` と `checklists/` は記録として残す。
- **番号は機能ごとに振り直される**（research の R、タスクの T）。他の機能の番号を指すときは `001/R6`、`005/T024` の形で機能の番号をつける。不変条件の INV だけは通し番号（`specs/INVARIANTS.md`）。
- Spec Kit のテンプレート、スクリプト、憲法（`.specify/memory/constitution.md`）は `.specify/` に置く。スキルは Claude Code 用が `.claude/skills/speckit-*`、GitHub Copilot CLI 用が `.github/skills/speckit-*`。どちらも `uvx --from git+https://github.com/github/spec-kit.git@v1.2.1 specify integration upgrade <claude|copilot>` で更新する（手で片方だけを直さない）。
- Claude Code は、CLAUDE.md がないときに AGENTS.md を読む。リポジトリに CLAUDE.md を作らない（作る場合は `@AGENTS.md` を取り込む）。`work/` と `data/` の読み取りは `.claude/settings.json` で拒否している。
- 設計判断は `docs/adr/` に ADR として書く（`NNNN-短い名前.md`、番号は連番。書式は `0001-sqlite-driver.md`）。状態は「採用」か「置き換え: ADR NNNN」。置き換えるときは、古い ADR の状態を書き換え、新しい ADR の「関連」に古い番号を書く。
- 要件の一覧と各要件の状態は `docs/requirements.md`。
- **機能の置き場所と固有の規則は `docs/features/<NNN-feature>.md`**（ファイル名は `specs/` と同じ）。新しい機能では AGENTS.md に節を足さず、`docs/features/` に文書を足して AGENTS.md の「機能ごとの文書」の表に 1 行を足す。機能をまたぐ規則だけを AGENTS.md の「機能をまたいで守る規則」に書く（AGENTS.md は毎回の文脈に入るので短く保つ）。完了した機能の古い `tasks.md`・plan の「AGENTS.md の〇〇（00N）の節」は、今の `docs/features/00N-*.md` を指す。
- AGENTS.md は憲法と矛盾させない。
