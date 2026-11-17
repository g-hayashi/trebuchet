# 開発の規約

全機能（001〜）の `tasks.md` に共通のルールの詳細。AGENTS.md の「開発の進め方」には各規則の 1 文だけがあり、細部はここにある。各 `tasks.md` の「全タスク共通のルール」は、これに従うことと、その機能に固有の規則だけを書く。

## 目次

- [テストと検証](#テストと検証)
- [ドメインとユースケース](#ドメインとユースケース)
- [db](#db)
- [server](#server)
- [web](#web)
- [言語と型](#言語と型)
- [不変条件とテストの共通部品](#不変条件とテストの共通部品)
- [進め方（依存、契約の変更、マイグレーション、コミット）](#進め方依存契約の変更マイグレーションコミット)

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
- **コミットメッセージは Conventional Commits**（タスク ID を入れる）。
- **tasks.md は 1 タスク 1 行を 500 字程度までにする**。長くなる細部は research・data-model・contracts の節に置き、タスクからは節の番号で参照する。

## 互換性（公開後）

2026-11-16 に公開し、利用者がいる。利用者は手元の DB と証憑とバックアップを持ったまま、新しい版に更新する。更新で帳簿が開けない・エラーになる・消えることを、帳簿の不変条件（Constitution I）と同じ重さで避ける。

- **マイグレーションは足すだけ**。適用済みのファイル（`packages/db/drizzle/<auth|registry|tenant>/` と `meta/_journal.json` の既存の項目）を書き換えない・消さない・番号を振り直さない。直したいときは新しいマイグレーションを足す。
- **既存の行があっても通る**ように書く。`NOT NULL` の列は既定値を付けるか、同じマイグレーションで埋める。制約・トリガー・UNIQUE を足すときは、既存の行が違反しないこと（違反するなら先に直す SQL）を確かめる。表・列の削除と型の変更は、データを写してから行い、写しが元と一致することをテストで確かめる。
- **旧版のデータを新版で開くテスト**: スキーマ・形式を変えるときは、変更前の版で作った DB（または変更前のマイグレーションまで当てた DB に行を入れたもの）に、新しいマイグレーションを当てて開き、帳簿の読み取り（仕訳・残高・帳票）が変わらないことを確かめる。
- **読む形式は旧形式も読む**: `.tbk`（`format` とヘッダー）、証憑の置き場所、`localStorage` のキーと値、設定ファイル。形式を変えるときは版を上げ、旧形式の読み込みと変換を残す。読めない値は既定値に戻すだけで、例外で画面を止めない。新しい版が書いたものを古い版で読めることまでは求めない（拒否の文言を出す）。
- **バックアップは古い版のものを復元できる**こと。復元したデータには、今の版までのマイグレーションを当てる。
- **機能・画面・API・CLI のフラグの削除と、大きな振る舞いの変更**（計算の結果、帳票の数値、エラーの扱い）は、一覧にして利用者の承認を得てから行う。web と server は同じ版で配るので、内部の API の形は一緒に変えてよい。
- **データを消す・作り直す手順を案内しない**（「`data/` を消して作り直す」など）。不具合で壊れたデータは、直すマイグレーションか修復の手順で戻す。
