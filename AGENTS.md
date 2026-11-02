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
| 全テスト（Vitest の全プロジェクト） | `pnpm test` |
| 1 プロジェクトのテスト | `pnpm vitest run --project <domain\|db\|server\|web\|schema>` |
| 型チェック（全パッケージ + scripts） | `pnpm typecheck` |
| Lint（Biome） | `pnpm lint` |
| 整形（Biome で書き換え） | `pnpm format` |
| 性能計測（SC-004 の仕訳 2,000 件、003 の SC-006 の決算書、009 の SC-005 の資産の画面。認証つき） | `pnpm bench:reports` |
| 性能計測（freee 取込の 500 仕訳、002 の SC-002） | `pnpm bench:import` |
| 性能計測（バックアップ、004 の SC-005） | `pnpm bench:backup`（環境変数でしきい値と件数を変えられる。使い方は `scripts/bench-backup.ts` の先頭のコメント） |
| 性能計測（明細 500 件の CSV の読み取り・確認・候補、007 の SC-006。AI は呼ばない） | `pnpm bench:statements`（環境変数でしきい値・回数・件数を変えられる。使い方は `scripts/bench-statements.ts` の先頭のコメント） |
| 列の案の評価（端末内の AI `fm serve` を呼ぶ。合成の例。CI に含まれない） | `pnpm eval:columns`（結果を `.tmp/eval-columns/` に残し前回と比べる。使い方は `scripts/eval-column-suggestions.ts` の先頭のコメント） |
| バックアップ（`.tbk`）の復元（server を止めて行う） | `pnpm restore -- --file <.tbk> [--data-dir <dir>] [--yes]`（回復キーを標準入力から読む。`scripts/restore-backup.ts` の先頭のコメント） |
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
- **不変条件**は `specs/INVARIANTS.md`（INV-1〜60 の索引。正本は各 `data-model.md` §4）。対応するテストは fast-check の性質テストで書く。`fc.assert(fc.property(...))` を直接呼ぶ（`@fast-check/vitest` は使わない。001/R6）。
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

## freee の取込（002）

仕様: `specs/002-freee-import/`。決算振替の扱い: [ADR 0004](docs/adr/0004-freee-closing-entries.md)。

| 層 | 場所 |
|---|---|
| CSV の解析、freee 形式の読み取り、対応表、決算振替の判定、期首残高の案、照合、取込の計画 | `packages/domain/src/import/`（`csv.ts`、`freee/` の `columns.ts`、`read.ts`、`mapping.ts`、`closing.ts`、`opening.ts`、`reconcile.ts`、`plan.ts`） |
| ユースケース | `packages/domain/src/usecases/import-freee.ts` |
| 永続化（取込のトランザクション、取消） | `packages/db/src/import-repository.ts` |
| HTTP | `apps/server/src/routes/imports.ts` |
| 画面 | `apps/web/src/features/imports/`、`apps/web/src/routes/e/$entityId/imports/` |

- **実データ（`work/`）を読むのは `scripts/verify-freee-import.ts`（`pnpm verify:freee`）と `scripts/verify-tax-return.ts`（`pnpm verify:tax-return`）だけ**。共通部分は `scripts/lib/freee-import-runner.ts`。出力（件数、科目別の金額など）はコミットしない。ドキュメントや `tasks.md` にも実データの数値・取引先名・摘要・按分率を書かない。
- **テストのフィクスチャは合成の CSV**（`packages/domain/test/fixtures/freee/`。作り方と匿名化の方針は同じ場所の `README.md`）。生成スクリプトはリポジトリに置かない（使い捨て）。手で直す場合は全項目をクォートし、LF で終える。元帳は UTF-8 の元（`ledger-2025.utf8.csv`）から CP932 の `ledger-2025.csv` を `iconv` で作る。変えたら README の「検算」をして `expected.ts` を直す。
- 取込のプロパティテスト（INV-14, 16, 17）は `packages/domain/test/freee-arbitraries.ts` のジェネレーターで、貸借一致の仕訳から freee 形式の仕訳帳と元帳を作って検証する。
- 年初付の決算振替は仕訳として取り込まず、期首残高に繰り込む（ADR 0004）。

## 決算書（003）

仕様: `specs/003-tax-return/`。青色申告決算書（一般用、個人の事業体だけ）。按分・減価償却を仕訳で登録する理由: [ADR 0005](docs/adr/0005-closing-adjustments-as-journals.md)。定額法・一括償却資産・開業費は下の 009 の節。

| 層 | 場所 |
|---|---|
| 決算書の組み立て（様式、按分、減価償却、控除の判定、月別売上と売上先、期首の貸借対照表の検査、CSV） | `packages/domain/src/blue-return/`（`form.ts`、`build.ts`、`home-use.ts`、`depreciation.ts`、`deduction.ts`、`sales.ts`、`balance-sheet.ts`、`opening-check.ts`、`tax-parameters.ts`、`csv.ts`） |
| ユースケース | `packages/domain/src/usecases/blue-return.ts` |
| 永続化（按分・資産・控除の回答・メモ・控えの保存、決算整理の仕訳との結びつけ） | `packages/db/src/closing-repository.ts` |
| HTTP | `apps/server/src/routes/blue-return.ts`、`fixed-assets.ts`、`tax-return.ts` |
| 画面 | `apps/web/src/features/blue-return/`、`fixed-assets/`、`tax-return/`、`apps/web/src/routes/e/$entityId/` の `blue-return/`・`fixed-assets/`・`tax-return/` |

- **按分と減価償却（少額の特例のほか、009 の定額法・一括償却・開業費）は、決算整理の「仕訳」として登録する**。ドメインが案を作り、利用者が確かめて 001 の `createJournal` で登録する。決算書は帳簿の損益計算書・貸借対照表と一致する。
- **税制の値の足し方**（基準額、控除額など。Constitution VI）: 次の**両方**に、適用の期間つきの行を足す。出典の URL は必須（国税庁・財務省などの一次資料）。
  1. `packages/domain/src/seed/tax-parameters.ts`（正本）
  2. マイグレーション。`pnpm --filter @trebuchet/db exec drizzle-kit generate --custom --config drizzle.tenant.config.ts` で空の SQL を作り、`INSERT` を手で書く（既存の行は書き換えず、適用の終了日を足すか新しい行を足す）。`packages/db/test/closing-repository.test.ts`（`listTaxParameters`）が、seed とマイグレーションの値の一致を確かめる
  - 新しい `key` を足すときは、`tax_parameters` の CHECK 制約（`key IN (...)`）と型 `TaxParameter` の `key` も直す。
- 様式の値（欄番号、行の定義）は `packages/domain/src/blue-return/form.ts` に置き、国税庁の様式の原本と照らして確かめる（003/R2）。
- 性能は `pnpm bench:reports` が SC-006（約 500 仕訳で決算書の画面が使う API が 2 秒以内）も確かめる。
- 実データでの照合は `pnpm verify:tax-return`（`--closing` の JSON の形はスクリプトの先頭のコメント）。出力は欄の識別子と一致・不一致の件数だけで、金額・取引先名・按分率は出さない。

## 定額法・一括償却資産・開業費（009）

仕様: `specs/009-depreciation-deferred/`。償却を属性から計算し、開業費の決定だけ保存する理由: [ADR 0012](docs/adr/0012-multi-year-depreciation.md)。003 の決算整理の仕組み（案 → 利用者が確かめて仕訳を登録）に、複数年の償却を足した。

| 層 | 場所 |
|---|---|
| 償却の計算（定額法、一括償却、開業費の上限・目安・決定、台帳と帳簿の照合。純関数） | `packages/domain/src/blue-return/`（`straight-line.ts`、`lump-sum.ts`、`deferred-asset.ts`、`asset-register.ts`。少額の特例は 003 の `depreciation.ts`）、償却率の正本は `packages/domain/src/seed/depreciation-rates.ts` |
| ユースケース | `packages/domain/src/usecases/deferred-assets.ts`（003 の `blue-return.ts` の `getAdjustmentProposals`・`commitAdjustment` も開業費を扱う） |
| 永続化（償却率の表 `straight_line_rates`、開業費、年度ごとの決定） | `packages/db/src/closing-repository.ts` |
| HTTP | `apps/server/src/routes/deferred-assets.ts`（資産は 003 の `fixed-assets.ts`） |
| 画面 | `apps/web/src/features/deferred-assets/`（`api.ts`、`DeferredAssetForm.tsx`、`AmortizationDecision.tsx`）、資産の画面 `routes/e/$entityId/fixed-assets/` |

- **償却率の表の足し方**（耐用年数省令の改正など）: `seed/depreciation-rates.ts`（正本）と、マイグレーション（`drizzle-kit generate --custom` の空の SQL に `INSERT` を手で書く。既存の行は書き換えず、適用の終了日を足すか新しい行を足す）の**両方**に、適用の期間と出典の URL つきの行を足す。`packages/db/test/closing-repository.test.ts`（`listStraightLineRates`）が値の一致を確かめる。率は取得日で選ぶ（009/R2）。
- **定額法・一括償却の各年度の償却費は、資産の属性（取得価額、方法、耐用年数、供用日、前年までの累計、除却日）と税制の値から計算し、保存しない**（ADR 0012）。登録した仕訳の金額を計算に使わない。償却を忘れた年度も償却したものとして残高が減る（強制償却）。
- **開業費だけ、年度ごとの償却額の決定（0 円を含む）を `deferred_amortizations` に保存する**。上限は期首の未償却残高（取り消されていない仕訳に結びつく決定を差し引く）、目安は 60 か月の均等。上限を超えれば 422 `DEFERRED_AMORTIZATION_OVER_LIMIT`（`details.limit`）。0 円は記録だけで、仕訳の案を作らない（任意償却）。
- **登録済みの償却の仕訳がある資産・開業費は、計算に効く項目を変えると 409 `DEPRECIATION_JOURNAL_EXISTS`**（`details.years`）。仕訳を取り消してから変える。名称・備考だけの変更は通る。
- **定額法の除却は種類（`disposal_kind`）で分ける**: 廃棄は除却の年度の月割りの償却と残りの未償却残高（除却損。家事分は事業主貸）を 1 つの案にする。売却は残高を事業主貸へ振り替える（譲渡所得の計算は範囲外）。一括償却は除却しても額が変わらない。
- 実データの照合 `pnpm verify:tax-return` の `--closing` の JSON は 009 で広がった（`assets` の `method`・`inServiceOn` など、`deferredAssets`。形はスクリプトの先頭のコメント）。

## 認証とバックアップ（004）

仕様: `specs/004-auth-backup/`。設計判断: [ADR 0006](docs/adr/0006-passkey-sessions.md)（パスキー、Host → CSRF → 認証。セッションと回復コードは 008 で置き換わった）、[ADR 0007](docs/adr/0007-backup-format.md)（形式、スナップショット、復元。鍵とパスフレーズは 008 で置き換わった）。鍵まわりは下の 008 の節と [ADR 0011](docs/adr/0011-passkey-prf-vault.md)。

| 層 | 場所 |
|---|---|
| 業務ルール（パスキー・セッションの判定、公開の手続きの一覧 `requiresAuth`、バックアップの要否・世代の選び方・警告） | `packages/domain/src/auth/`、`packages/domain/src/backup/` |
| 永続化（認証の表、セッションのトークンのハッシュ `hashToken`） | `packages/db/src/auth-hash.ts`、`auth-repository.ts` |
| バックアップの形式と復元 | `packages/db/src/backup/`（`snapshot.ts`、`archive.ts`、`crypto.ts`、`file.ts`、`repository.ts`、`restore.ts`） |
| HTTP の検査（Host → CSRF → 認証の順） | `apps/server/src/middleware/`（`host.ts`、`csrf.ts`、`auth.ts`） |
| server の部品 | `apps/server/src/lib/`（`origin.ts`、`session.ts`、`webauthn.ts`、`challenges.ts`、`keychain.ts`（006 の外部 AI の API キー用）、`backup-run.ts`、`backup-scheduler.ts`、`startup.ts`。解錠まわりは 008 の節） |
| HTTP のルート | `apps/server/src/routes/auth.ts`、`backup.ts` |
| 画面 | `apps/web/src/features/auth/`、`features/backup/`、`apps/web/src/routes/settings/`（`security.tsx`、`backup.tsx`） |
| E2E の仮想の認証器 | `apps/web/e2e/helpers/`（`virtual-authenticator.ts`、`auth.ts`） |
| 復元のコマンド | `scripts/restore-backup.ts`（本体は `scripts/lib/restore-cli.ts`） |

- **開発の URL は `http://localhost:5173`**（`127.0.0.1` ではパスキーが使えない）。`apps/web/vite.config.ts` の proxy は `changeOrigin: false` が必須（`true` だと Host が書き換わる）。
- **許す Host・オリジン・RP ID の決定は `apps/server/src/lib/origin.ts` の 1 か所**。別の場所で名前の一覧を書かない。
- **全 `/api` に Host → CSRF → 認証の順で検査を掛ける**。CSRF は `hono/csrf` を使わず自前。公開の手続きは `requiresAuth`（domain）の完全一致の一覧だけ。`apps/server/test/auth-coverage.test.ts`（INV-29）が、一覧にないルートは未サインインで 401 になることを確かめる。
- **認証を無効にする設定・環境変数・テスト用の分岐を本番のコードに作らない**。
- **DK・DB の鍵・回復キー・セッションのトークンを平文でログ・データ場所・リポジトリに置かない**。セッションのトークンは DB にハッシュだけを保存する（ハッシュは db の `hashToken` に一本化）。回復キーはハッシュも保存しない（008）。バックアップの鍵は DK から作り、パスフレーズはない。
- **キーチェーン（`SecretStore`）は 006 の外部の AI の API キーだけに使う**。`/usr/bin/security -i` の標準入力に 1 行を流す（引数は `ps` に出る。004/R12）。テストはキーチェーンに触れず、`SecretStore` の偽物を使う。
- **平文の写しは `.tmp/` の下に作り、`finally` で必ず消す**。server の起動時に、前回の異常終了で残った `.tmp/backup-snapshot-*/` を消す。
- バックアップには、端末に結びつく設定（`app_settings`）と認証の表（`auth.sqlite`）を含めない。復元した帳簿は、次の起動で回復キーで解錠し、パスキーを登録するところから始まる。
- **US4（Tailscale によるリモートの利用: `pnpm start`、server の静的配信、ペアリング）は保留**（2026-10-24）。未実装なので、これらのコマンドや場所を前提にしない。

## 請求と定期仕訳（005）

仕様: `specs/005-recurring-invoicing/`。請求・入金と仕訳の結びつき、トランザクション、取消の規則: [ADR 0008](docs/adr/0008-invoice-journal-linkage.md)。

| 層 | 場所 |
|---|---|
| 業務ルール（請求の金額と税、請求番号、支払期限、状態、仕訳の案、定期仕訳の予定日と登録する回の選び方） | `packages/domain/src/invoicing/`（`amounts.ts`、`tax.ts`、`number.ts`、`due-date.ts`、`status.ts`、`draft.ts`、`detail.ts`、`journal-drafts.ts`）、`packages/domain/src/recurring/`（`due.ts`。予定日・月の計算は `dates.ts`） |
| ユースケース | `packages/domain/src/usecases/invoicing.ts`、`recurring.ts` |
| 永続化（設定・条件・工数・請求書・消し込み・定期仕訳・操作の記録） | `packages/db/src/invoicing-repository.ts`、`recurring-repository.ts` |
| HTTP | `apps/server/src/routes/invoicing.ts`、`recurring.ts` |
| server の部品 | `apps/server/src/lib/today.ts`（`todayOf`）、`recurring-scheduler.ts` |
| 画面 | `apps/web/src/features/invoicing/`、`features/recurring/`、`apps/web/src/routes/e/$entityId/` の `invoice-settings.tsx`・`work-hours.tsx`・`invoices/`・`recurring/` |
| E2E | `apps/web/e2e/invoicing.spec.ts`（対象月・発行日・入金日は固定の日付で、実行日に依存しない） |

- **発行・入金・取消は 1 つの `InvoicingUnitOfWork` の中で書く**（ADR 0008）。複数回書くユースケースの一般の規則（「開発の進め方」）のとおり、`err` を返せば仕訳も請求の記録も巻き戻る。
- **請求書・入金の仕訳は `JOURNAL_LINKED` で守る**（005/R13）。`source` が `invoice` / `payment` の仕訳は、001 の通常の訂正・取消を 409 で拒否する。請求・入金の取消だけが `{ linked: true }` で仕訳を取り消す。`recurring` の仕訳は通常どおり訂正・取消できる。消し込みのある請求書は取消せない（`INVOICE_HAS_PAYMENTS`）。
- **請求書は発行時の写しを持つ**。写しの列と明細は DB のトリガーで更新を止め、取消で書けるのは取消の列だけ。物理削除しない。
- **「今日」は `today: string`（`YYYY-MM-DD`）で domain に渡す**。server は `todayOf(clock)` で作る（005/R22）。ルートは `invoicingRoutes({ clock })`・`recurringRoutes({ clock })`（ほかのルートも同じ形）。server のテストは偽の時計を渡し、時刻を日付の境目から離す。
- **仕訳の科目はコードで引く**（005/R10）。定数 `INVOICING_ACCOUNT_CODES`（`journal-drafts.ts`）が売掛金・売上高・支払手数料のコードを持つ。科目の選択の設定は増やさない。
- **工数は半時間の整数**、明細の金額は `Math.floor(quantityHalves * unitPrice / 2)`。請求の `priceMode` は税込/税抜入力を表し、内訳表示 `taxDisplay` と分ける。税込の内訳は `computeInclusiveTax`、税抜の加算は税率ごとの小計に対し一度だけ切り捨てる（005/R27）。免税でも消費税相当額を請求でき、帳簿は加算後の全額を対象外の売上とする。
- 請求・入金の操作は `invoicing_audit_log`（追記のみ）に記録する。仕訳そのものの記録は 001 の `audit_log`。

## 明細の取込と AI 仕訳（006）

仕様: `specs/006-mfme-ai-journal/`。推定の順序、AI の呼び出し、送る情報のマスク、候補の保存と承認、評価: [ADR 0009](docs/adr/0009-ai-journal-suggestions.md)。

| 層 | 場所 |
|---|---|
| 入出力の型（明細・口座・候補・ルール・評価、AI の出力 `AiSuggestion`） | `packages/schema/src/statements.ts`、`ai.ts` |
| 業務ルール（表の読み取り（007 で `paste.ts` を置き換えた。下の 007 の節）、安定したキー、正規化、仕訳の形、振替、既存の仕訳との照合、ルール、マスクと送信の内容、プロンプト、評価、状態の導出） | `packages/domain/src/statements/`（`table.ts`、`columns.ts`、`keys.ts`、`normalize.ts`、`journal-shape.ts`、`transfer.ts`、`match-existing.ts`、`rules.ts`、`mask.ts`、`prompt.ts`、`evals.ts`、`status.ts`） |
| ユースケース | `packages/domain/src/usecases/statements.ts`、`statement-candidates.ts`、`statement-approval.ts`、`inference.ts`、`inference-rules.ts`、`evals.ts` |
| 永続化（取込の回・明細・候補・結びつき・ルール・評価・操作の記録、registry の AI 設定） | `packages/db/src/statement-repository.ts`、`ai-settings-repository.ts` |
| HTTP | `apps/server/src/routes/statements.ts`、`ai-settings.ts` |
| server の部品 | `apps/server/src/lib/`（`ai-client.ts`、`ai-runtime.ts`、`fm-server.ts`、`jobs.ts`） |
| 画面 | `apps/web/src/features/statements/`、`features/ai-settings/`、`apps/web/src/routes/e/$entityId/statements/`、`apps/web/src/routes/settings/ai.tsx` |
| E2E・性能 | `apps/web/e2e/statements.spec.ts`、`scripts/bench-statements.ts` |

- **AI へ送る情報は `buildAiPayload`（`mask.ts`）を通したものだけ**（006/R11、INV-45）。端末内も外部も、評価も同じ `createAiSuggester`（`usecases/inference.ts`）を共有する。口座の名前・メモ・取引先の一覧は送らない。AI の出力は `AiSuggestion`（Zod）で検証し、形に合わない・一覧にないコードは「候補なし」にする（INV-46）。
- **`inferWithAi` は 読む → AI を呼ぶ（UnitOfWork の外）→ 書く の 3 段**（006/R8）。AI の呼び出し（遅い、外部に出る）をトランザクションの中に入れない。取込と承認は 1 つの `StatementUnitOfWork` の中で書く（INV-47）。
- **端末内のモデルは `fm serve`**（モデル名 `system`。`stream` は送らない（`stream: false` には応答しない。省くと SSE で返り、`ai-client.ts` が読み分ける）。ポート `TREBUCHET_FM_PORT`、既定 18790）。最初の推定で起動し、server の終了で止める（006/R10）。外部の AI の API キーはキーチェーン（004 と同じ `SecretStore`）に置く。`ai_settings` は registry の表で、バックアップに含めない（006/R12）。
- **AI の設定の必須項目の検査**（外部を有効にするのに URL・モデル・API キーがそろっていなければ 422 `AI_NOT_CONFIGURED`）は `apps/server/src/routes/ai-settings.ts` にある。帳簿の業務ルールではなく、端末の設定値の検査なので server に置く。
- **MF ME の画面からの取得（US4）は取りやめた**（2026-10-26。利用者の判断。汎用の明細取込を 007 で作った）。取込は貼り付けとファイル（007）。`apps/server` は Playwright に依存しない。
- **評価のジョブは同時に 1 つ**（409 `JOB_RUNNING`。`lib/jobs.ts` の `startTask`）。server の差し替えは `createApp({ jobs, ai: { fetch, secrets, settings, fm } })`。
- **テストは `fm`・外部の AI を呼ばない**。偽の `SuggestionProvider`（domain）と偽の `fetch`（server）を使う。
- **明細の承認だけが仕訳を作る**（INV-41）。仕訳の `source` は `statement`（通常どおり訂正・取消できる）。明細の状態は保存せず、結びつき・除外・仕訳の状態から導く（006/R15）。
- **実環境の確認（貼り付けの形、`fm serve`）の結果は、値・口座名・摘要を書かない**。形だけを記録する（quickstart §3）。

## 汎用の明細取込（007）

仕様: `specs/007-generic-statement-import/`。列の対応の保存と当てはめ、AI を列の案だけに使う理由: [ADR 0010](docs/adr/0010-generic-statement-import.md)。006 の取込（MF ME の貼り付けに決め打ち）を、取込元を問わない読み取りに置き換えた。読み取りの後（候補・承認・ルール・評価）は 006 のまま。

| 層 | 場所 |
|---|---|
| 入出力の型（列の役割・対応、layout、取込元、口座の案、AI の列の案 `AiColumnSuggestion`） | `packages/schema/src/statements.ts`、`ai.ts` |
| 業務ルール（区切り文字と見出しの行の判定・値の読み取り、見出しの辞書と列の案、取込元の照合、口座の推定、列の案のプロンプトと出力の検証） | `packages/domain/src/statements/`（`table.ts`、`columns.ts`、`sources.ts`、`account-inference.ts`、`column-prompt.ts`）、区切りつきの分割は `packages/domain/src/import/csv.ts` の `parseDelimited` |
| ユースケース | `packages/domain/src/usecases/statements.ts`、`statement-sources.ts`、`statement-columns.ts`（`suggestStatementColumns`、`evaluateColumnSuggestions`） |
| 永続化（取込元 `statement_sources`、取込の確定と同じ UnitOfWork での保存） | `packages/db/src/statement-repository.ts` |
| HTTP | `apps/server/src/routes/statements.ts`（`/statements/imports/layout`・`column-suggestion`・`preview`・commit、`/statement-sources`）、受け取りは `apps/server/src/lib/upload.ts`・`statement-input.ts` |
| 端末内の AI の列の案 | `apps/server/src/lib/ai-client.ts`（`createColumnProvider`、`COLUMN_TIMEOUT_MS`） |
| 画面 | `apps/web/src/features/statements/`（`StatementInput.tsx`、`ColumnMappingEditor.tsx`、`ColumnSuggestionNote.tsx`、`SourcePicker.tsx`、`SourceList.tsx`、`AccountMappingForm.tsx`、`ImportWorkspace.tsx`）、`apps/web/src/routes/e/$entityId/statements/import.tsx` |
| フィクスチャ・評価・性能 | `packages/domain/test/fixtures/statements/`（`README.md`、`expected.ts`、`column-evals.ts`）、`scripts/eval-column-suggestions.ts`、`scripts/bench-statements.ts` |

- **値（日付・金額・内容）の読み取りはプログラムだけ**（FR-006、INV-49）。AI の出力から値を作らない。読み取りは利用者が確かめた列の対応（`readStatementTable`）だけに基づく。金額 1 列の符号の向き（`amountSign`）は自動で決めず利用者が選ぶ。
- **列の案の AI は端末内だけ**（FR-018、INV-48）。`createColumnProvider` に渡すのは端末内の endpoint だけで、外部の endpoint を受け取る口を持たない。外部の AI の設定にかかわらず外部へ送らず、006 の `createAiSuggester` も通さない。渡すのは見出しと先頭の明細の行 `COLUMN_PROMPT_ROWS`（5）件だけ（`buildColumnPrompt`）で、前置きの行（口座番号など）は渡さず保存もしない。AI を呼ぶのは、辞書の案で必須の役割がそろわず、保存した対応も当てはまらないときだけ。出力は `AiColumnSuggestion`（Zod）で検証し、外れたら案なし。
- **見出しの辞書と口座の語の表は 1 か所の一覧**。新しい銀行・カードの見出しは `columns.ts` の `COLUMN_ROLE_NAMES`、口座の種類・用途を決める語は `account-inference.ts` の `ACCOUNT_CUES`・`USAGE_CUES` にだけ足す（比べるときは NFKC。辞書は完全一致、語の表は部分一致）。足したら同じ値を使うテストと `fixtures/statements/` の README を合わせる。
- **取込元の保存は取込の確定と同じ `StatementUnitOfWork`**（INV-47）。確定しなければ保存しない。`fixed_account_name` が NULL ⇔ 対応が `accountName` の役割を持つ（INV-50）。見出しの署名が 1 件だけ一致すれば次回から列の選択を飛ばす。見出しが変われば自動では当てはめない（007/R8）。
- **フィクスチャは合成**（`packages/domain/test/fixtures/statements/`。作り方・匿名化・検算は同じ場所の `README.md`）。実データから写してよいのは列名と書式だけ。銀行の CSV は UTF-8 の元（`bank-two-columns.utf8.csv`）から CP932 の `bank-two-columns.csv` を `iconv` で作る。変えたら README の「検算」をして `expected.ts` を直す。
- **プロンプト・`COLUMN_PROMPT_ROWS`・`COLUMN_TIMEOUT_MS` を変えるときは、変更の前と後で `pnpm eval:columns` を実行して結果を比べる**（Constitution IV、007/R15）。`fm` を呼ぶので CI に含まれない。結果は `.tmp/eval-columns/` に件数と割合だけを残し、見出し・値を書かない。CI のテストは偽の `ColumnSuggestionProvider` で集計だけを確かめる。
- **互換の別名を残さない**（007/R13）。`PastedRow`・`MfmePaste`・`parseMfmePaste`・`MFME_COLUMNS`・`mfme_fetch`・`STATEMENT_PASTE_UNREADABLE` は消した。入力は貼り付けもファイルも multipart の `file` と `options`。上限は 5 MB・20,000 行・50 列。

## パスキーと回復キーによる DB の暗号化（008）

設計: `specs/008-passkey-vault/design.md`（D1〜D12。spec・plan・research はない）。判断の記録: [ADR 0011](docs/adr/0011-passkey-prf-vault.md)。004 の認証とバックアップの鍵まわりを置き換えた（回復コード、バックアップのパスフレーズ、キーチェーンの経路は消えた）。

| 層 | 場所 |
|---|---|
| ファイル | `data/auth.sqlite`（平文。`passkeys`（`prf_salt` つき）、`key_wraps`、`sessions`、`auth_events`）、`data/registry.sqlite` と `data/tenants/<id>.sqlite`（DK から HKDF で作った鍵で SQLCipher 方式に暗号化） |
| 鍵の計算（DK の包み、HKDF、回復キーの生成・解析。純関数） | `packages/db/src/vault-crypto.ts`、`recovery-key.ts`（復元のコマンドが使うので db に置く。domain は `node:crypto` を使えない） |
| DK の保持と DB の開き方（`setDataKey`・`clearDataKey`・`VaultLockedError`・`openAuth`・`openRegistry`・`openTenant`） | `packages/db/src/tenant-store.ts`。ドライバーは `packages/db/src/driver.ts`（`better-sqlite3-multiple-ciphers`） |
| 認証の表のスキーマとマイグレーション | `packages/db/src/schema/auth.ts`、`packages/db/drizzle/auth/`、`drizzle.auth.config.ts`（registry の `schema/registry.ts`・`drizzle/registry/` とは別） |
| server の解錠まわり | `apps/server/src/lib/`（`vault.ts`、`session-sweeper.ts`、`reauth.ts`、`startup.ts`）、`routes/auth.ts` |
| 画面 | `apps/web/src/features/auth/`（`AuthGate.tsx`、`RegisterPasskey.tsx`、`SignIn.tsx`、`Recovery.tsx`、`RecoveryCodePanel.tsx`、`PasskeyList.tsx`、`webauthn-client.ts`）、`routes/settings/security.tsx` |
| E2E | `apps/web/e2e/helpers/`（`virtual-authenticator.ts` は `hasPrf: true`、`auth.ts` の `enterVault`） |

- **DK・DB の鍵・バックアップの鍵は、平文でディスク・ログ・環境変数・応答に出さない**（INV-51）。回復キーは作成・再発行の応答で 1 回だけ返す。DK は `setDataKey` で渡したバッファだけが持ち、`clearDataKey` が `fill(0)` する。
- **施錠中は registry・事業体を開けない**（`VaultLockedError`）。帳簿の API は、セッションがなければ 401、セッションがあって施錠中なら 401 `LOCKED`。誤った鍵は `SQLITE_NOTADB` を例外として上げる。空の DB として扱わない。
- **正しさの判定は包みが開けたこと（GCM の検証）だけ**。回復キーのハッシュを保存しない。包みの AAD は種類と資格情報 ID（INV-52）。設定済みなら recovery の包みは 1 行、passkey の包みはパスキーと 1 対 1（INV-53）。
- **エラーコード**: 401 `LOCKED`、403 `REAUTH_REQUIRED`、400 `PRF_UNSUPPORTED`。パスキーの追加・削除、回復キーの再発行は、全権のセッションに加え、直近 5 分以内の再認証（`POST /api/auth/reauth/options`・`verify`）を要求する。最後の 1 本のパスキーは削除できない。
- **セッションは `auth.sqlite`**。無操作 30 分で失効し、有効なセッションが 1 つもなくなると施錠する。**起動時・施錠時に `sessions` を全部消す**。サインアウトは全セッションを消して施錠する。**新しいセッションを入れてから期限切れを掃除する**（逆にすると解錠の直後に施錠される）。
- **回復キーの試行はロックしない**。失敗ごとに 1 秒待たせる。
- **初回の設定**は `key_wraps` に recovery の行がないときだけ。以前の registry・事業体は `data/discarded-<時刻>/` に移す（消さない）。
- **バックアップの定期実行と定期仕訳の自動登録は、解錠中だけ**動く（`lib/startup.ts` を vault の状態に結びつける）。
- **バックアップの鍵は `HKDF(DK, ヘッダーの salt, "trebuchet/backup/v1")`**。ヘッダーに取った時点の recovery の包みを入れる（INV-54）。中の SQLite の写しは平文で、外側の AES-GCM が守る。`pnpm restore` は回復キーを標準入力から読み、ヘッダーの包み → 今の `auth.sqlite` の包みの順に試す。復元した後の `auth.sqlite` は recovery の包みだけ。画面のファイルの検査は解錠中に DK で行う。
- **テストは `useTempDataDir` が固定のテスト用 DK を `setDataKey` する**（cleanup で `clearDataKey`）。既存の db・server のテストは鍵を意識しない。server のテストのセッションは `auth.sqlite` に作る（`createTestSession`）。
- **E2E の仮想の認証器は `hasPrf: true`**。パスキーを書き出して戻すと PRF を失うので使わない。テストの間は回復キーを引き継ぎ、`enterVault` で回復キーで解錠して新しいパスキーを登録してから始める。E2E は利用者の端末で実行する。
- **`pnpm verify:freee --continue` は使えない**（実行ごとに乱数の DK で作るため。利用者の判断で使えないままにする）。
- **registry のマイグレーションは 008 で作り直した**（認証の表を `auth.sqlite` に分けたため）。以前の `data/` の DB は読めない。

## データと一時ファイル

- **実データを読まない、コミットしない**。`work/` と `data/` は実データを含む。中身を開く・要約する・テストの入力にする・コミットすることをしない。`.gitignore` で除外済み。
- 既定のデータ位置はリポジトリ直下の `data/`。`TREBUCHET_DATA_DIR` で変更できる。テストでは実データに触れないよう、一時のデータ場所を使う。
- **一時ファイルは `.tmp/` の下だけに作る**（`/tmp` や `os.tmpdir()` は使わない）。`packages/db/src/testing.ts` の `useTempDataDir` を使う。E2E と bench も `.tmp/` を使う。

## 仕様と文書

- Spec Kit の成果物は `specs/<NNN-feature>/`（001〜007）に置く: `spec.md`、`plan.md`、`research.md`、`data-model.md`、`quickstart.md`、`tasks.md`（`contracts/`、`checklists/` がある機能もある）。完了した機能の `tasks.md` と `checklists/` は記録として残す。
- **番号は機能ごとに振り直される**（research の R、タスクの T）。他の機能の番号を指すときは `001/R6`、`005/T024` の形で機能の番号をつける。不変条件の INV だけは通し番号（`specs/INVARIANTS.md`）。
- Spec Kit のテンプレート、スクリプト、憲法（`.specify/memory/constitution.md`）は `.specify/` に置く。
- Spec Kit のスキルは、Claude Code 用が `.claude/skills/speckit-*`、GitHub Copilot CLI 用が `.github/skills/speckit-*` にある。どちらも `uvx --from git+https://github.com/github/spec-kit.git@v1.2.1 specify integration upgrade <claude|copilot>` で更新する（手で片方だけを直さない）。
- Claude Code は、CLAUDE.md がないときにこの AGENTS.md を読む。リポジトリに CLAUDE.md を作らない（作る場合は `@AGENTS.md` を取り込む）。`work/` と `data/` の読み取りは `.claude/settings.json` で拒否している。
- 設計判断は `docs/adr/` に ADR として書く（`NNNN-短い名前.md`、番号は連番。書式は `0001-sqlite-driver.md`）。状態は「採用」か「置き換え: ADR NNNN」。置き換えるときは、古い ADR の状態を書き換え、新しい ADR の「関連」に古い番号を書く。
- 要件の一覧と各要件の状態は `docs/requirements.md`。
- AGENTS.md は憲法と矛盾させない。

