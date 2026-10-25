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
| `packages/domain` | 業務ルール（仕訳の検証、締め、帳票、ユースケース） | **純粋関数のみ**。`node:fs` / `node:sqlite`、DB、Hono、React を import しない。Biome の `noRestrictedImports` で機械的に止める |
| `packages/db` | SQLite（better-sqlite3 + Drizzle）、マイグレーション、リポジトリ実装 | DB へのアクセスはここに閉じる |
| `apps/server` | Hono の API サーバー（`127.0.0.1:8787`） | HTTP の入出力と DI の組み立て。業務ルールは書かない |
| `apps/web` | React + Vite の画面（`http://localhost:5173`、`/api` は 8787 へ proxy） | 業務ルールを持たない。`@trebuchet/schema` に依存する |

- `packages/domain` の禁止は Biome が止めるのは次の import だけ: `hono`、`react`、`drizzle-orm`、`better-sqlite3`、`node:fs`、`node:sqlite`、`node:crypto`。`node:` の他のモジュールや `zod` の直接 import は Biome では止まらない。レビューで確認する。
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
| 性能計測（SC-004 の仕訳 2,000 件、003 の SC-006 の決算書） | `pnpm bench:reports` |
| 性能計測（freee 取込の 500 仕訳、002 の SC-002） | `pnpm bench:import` |
| 性能計測（バックアップ、004 の SC-005） | `pnpm bench:backup`（環境変数でしきい値と件数を変えられる。使い方は `scripts/bench-backup.ts` の先頭のコメント） |
| バックアップ（`.tbk`）の復元（server を止めて行う） | `pnpm restore -- --file <.tbk> [--data-dir <dir>] [--yes]`（使い方は `scripts/restore-backup.ts` の先頭のコメント） |
| freee の書き出しの確認と照合（実データ、ローカル専用） | `pnpm verify:freee`（`work/` を読む。使い方は `scripts/verify-freee-import.ts` の先頭のコメント） |
| 青色申告決算書の照合（実データ、ローカル専用） | `pnpm verify:tax-return`（`work/` を読む。使い方は `scripts/verify-tax-return.ts` の先頭のコメント） |
| E2E（Playwright、Chromium） | `pnpm --filter @trebuchet/web e2e` |
| web のビルド（`routeTree.gen.ts` を再生成する） | `pnpm --filter @trebuchet/web build` |

- CI（`.github/workflows/ci.yml`）は `pnpm typecheck`、`pnpm lint`、`pnpm test` を実行する。E2E、bench、`verify:freee`、`verify:tax-return` は CI に含まれない。
- 変更を終える前に、少なくとも `pnpm typecheck`、`pnpm lint`、`pnpm test` を通す。

## 開発の進め方

- **テストを先に書く（TDD）**（Constitution V）。失敗するテストを確認してから実装する。
- **不変条件（INV-1〜INV-10）**は `specs/001-ledger-core/data-model.md` §4 にある。対応するテストは fast-check の性質テストで書く。`fc.assert(fc.property(...))` を直接呼ぶ（`@fast-check/vitest` は使わない。research R6）。
- **web のテストはコンポーネントテスト**（Testing Library + jsdom）。テストのためだけに node 専用のロジックを別ファイルに切り出さない。
- **Node 26 の型の除去で直接実行する**（`tsx` は使わない）。次を守る:
  - 相対 import は `.ts` を付ける（`allowImportingTsExtensions`）
  - `enum`、パラメーター・プロパティ、`namespace` を使わない（`erasableSyntaxOnly`）
  - 型だけの import は `import type` と書く（`verbatimModuleSyntax`）
- **マイグレーションの再生成**: `drizzle-kit generate` は `STRICT` を出力しない。生成後、`0000_init.sql` の `);` を `) STRICT;` に置き換える（research R2 / T024）。再生成のたびに同じ置き換えが必要。`tenant-store` のテストが `STRICT` を確認する。
- **トリガー・ビュー**は `drizzle-kit generate --custom` で手書きの SQL として追加する（research R2）。

## freee の取込（002）

取込の実装は次に置く。

| 層 | 場所 |
|---|---|
| CSV の解析、freee 形式の読み取り、対応表、決算振替の判定、期首残高の案、照合、取込の計画 | `packages/domain/src/import/`（`csv.ts`、`freee/` の `columns.ts`、`read.ts`、`mapping.ts`、`closing.ts`、`opening.ts`、`reconcile.ts`、`plan.ts`） |
| ユースケース | `packages/domain/src/usecases/import-freee.ts` |
| 永続化（取込のトランザクション、取消） | `packages/db/src/import-repository.ts` |
| HTTP | `apps/server/src/routes/imports.ts` |
| 画面 | `apps/web/src/features/imports/`、`apps/web/src/routes/e/$entityId/imports/` |

- 実データ（`work/`）を読むのは `scripts/verify-freee-import.ts`（`pnpm verify:freee`）と `scripts/verify-tax-return.ts`（`pnpm verify:tax-return`）だけ。取込の共通部分は `scripts/lib/freee-import-runner.ts`。出力（件数、科目別の金額など）はコミットしない。ドキュメントや `tasks.md` にも実データの数値を書かない。
- テストのフィクスチャは `packages/domain/test/fixtures/freee/` の **合成の** CSV。作り方と匿名化の方針は同じ場所の `README.md` に書いてある。CSV の生成スクリプトはリポジトリに置かない（使い捨て）。手で直す場合は、全項目をクォートし、LF で終える。元帳は UTF-8 の元（`ledger-2025.utf8.csv`）から CP932 の `ledger-2025.csv` を `iconv` で作る。フィクスチャを変えたら README の「検算」をして `expected.ts` を直す。
- 取込のプロパティテスト（INV-14, 16, 17）は `packages/domain/test/freee-arbitraries.ts` のジェネレーターで、貸借一致の仕訳から freee 形式の仕訳帳と元帳を作って検証する。
- 年初付の決算振替は仕訳として取り込まず、期首残高に繰り込む（[ADR 0004](docs/adr/0004-freee-closing-entries.md)）。

## 決算書（003）

青色申告決算書（一般用、個人の事業体だけ）の実装は次に置く。

| 層 | 場所 |
|---|---|
| 決算書の組み立て（様式、按分、減価償却、控除の判定、月別売上と売上先、期首の貸借対照表の検査、CSV） | `packages/domain/src/blue-return/`（`form.ts`、`build.ts`、`home-use.ts`、`depreciation.ts`、`deduction.ts`、`sales.ts`、`balance-sheet.ts`、`opening-check.ts`、`tax-parameters.ts`、`csv.ts`） |
| ユースケース | `packages/domain/src/usecases/blue-return.ts` |
| 永続化（按分・資産・控除の回答・メモ・控えの保存、決算整理の仕訳との結びつけ） | `packages/db/src/closing-repository.ts` |
| HTTP | `apps/server/src/routes/blue-return.ts`、`fixed-assets.ts`、`tax-return.ts` |
| 画面 | `apps/web/src/features/blue-return/`、`fixed-assets/`、`tax-return/`、`apps/web/src/routes/e/$entityId/` の `blue-return/`・`fixed-assets/`・`tax-return/` |

- 按分と少額減価償却は、決算整理の「仕訳」として登録する。ドメインが案を作り、利用者が確かめて 001 の `createJournal` で登録する（[ADR 0005](docs/adr/0005-closing-adjustments-as-journals.md)）。決算書は帳簿の損益計算書・貸借対照表と一致する。
- **税制の値の足し方**（基準額、控除額など。Constitution VI）: 次の**両方**に、適用の期間つきの行を足す。出典の URL は必須（国税庁・財務省などの一次資料）。
  1. `packages/domain/src/seed/tax-parameters.ts`（正本）
  2. マイグレーション。`pnpm --filter @trebuchet/db exec drizzle-kit generate --custom --config drizzle.tenant.config.ts` で空の SQL を作り、`INSERT` を手で書く（既存の行は書き換えず、適用の終了日を足すか新しい行を足す）。`packages/db/test/closing-repository.test.ts`（`listTaxParameters`）が、seed とマイグレーションで投入された値の一致を確かめる
  - 新しい `key` を足すときは、`tax_parameters` の CHECK 制約（`key IN (...)`）と型 `TaxParameter` の `key` も直す。
- 様式の値（欄番号、行の定義）は `packages/domain/src/blue-return/form.ts` に置き、国税庁の様式の原本と照らして確かめる（research R2）。
- 性能は `pnpm bench:reports` が SC-006（約 500 仕訳で決算書の画面が使う API が 2 秒以内）も確かめる。
- 実データでの照合は `pnpm verify:tax-return`（`--closing` の JSON の形はスクリプトの先頭のコメント）。出力は欄の識別子と一致・不一致の件数だけで、金額・取引先名・按分率は出さない。

## 認証とバックアップ（004）

パスキーのサインイン、セッション、回復コード、暗号化したバックアップ（`.tbk`）と復元の実装は次に置く。

| 層 | 場所 |
|---|---|
| 業務ルール（パスキー・セッションの判定、回復コード、公開の手続きの一覧 `requiresAuth`、バックアップの要否・世代の選び方・警告） | `packages/domain/src/auth/`、`packages/domain/src/backup/` |
| 永続化（認証の表、トークンのハッシュ `hashToken`） | `packages/db/src/auth-hash.ts`、`auth-repository.ts` |
| バックアップの形式と復元（スナップショット、アーカイブ、暗号化、ファイルの書き込みと読み戻し、バックアップの記録、復元） | `packages/db/src/backup/`（`snapshot.ts`、`archive.ts`、`crypto.ts`、`file.ts`、`repository.ts`、`restore.ts`） |
| HTTP の検査（Host → CSRF → 認証の順） | `apps/server/src/middleware/`（`host.ts`、`csrf.ts`、`auth.ts`） |
| server の部品 | `apps/server/src/lib/`（`origin.ts`、`session.ts`、`webauthn.ts`、`challenges.ts`、`recovery-code.ts`、`keychain.ts`、`backup-run.ts`、`backup-scheduler.ts`、`startup.ts`） |
| HTTP のルート | `apps/server/src/routes/auth.ts`、`backup.ts` |
| 画面 | `apps/web/src/features/auth/`、`apps/web/src/features/backup/`、`apps/web/src/routes/settings/`（`security.tsx`、`backup.tsx`） |
| E2E の仮想の認証器 | `apps/web/e2e/helpers/`（`virtual-authenticator.ts`、`auth.ts`） |
| 復元のコマンド | `scripts/restore-backup.ts`（本体は `scripts/lib/restore-cli.ts`） |

- **開発の URL は `http://localhost:5173`**。`127.0.0.1` ではパスキーが使えない（RP ID は IP アドレスにできない）。`apps/web/vite.config.ts` の proxy は `changeOrigin: false` が必須（`true` だと Host が書き換わり、server が RP ID とオリジンを決められない。理由はファイルのコメント）。
- **許す Host・オリジン・RP ID の決定は `apps/server/src/lib/origin.ts` の 1 か所**。Host の検査、CSRF、WebAuthn が同じ関数を使う。別の場所で名前の一覧を書かない。
- **全 `/api` に Host → CSRF → 認証の順で検査を掛ける**。CSRF は `hono/csrf` を使わず自前のミドルウェア（`Content-Type` によらず、GET・HEAD・OPTIONS 以外の要求の `Origin` を検査する）。公開の手続きは `requiresAuth`（domain）の完全一致の一覧だけ。`apps/server/test/auth-coverage.test.ts`（INV-29）が、一覧にないルートは未サインインで 401 になることを確かめる。
- **認証を無効にする設定・環境変数を作らない**。テストで認証を飛ばす分岐も本番のコードに作らない。
- **パスフレーズ・回復コード・トークンを平文でログ・データ場所・リポジトリに置かない**。トークンと回復コードは DB にハッシュだけを保存する（ハッシュは db の `hashToken` に一本化し、server で別に書かない）。バックアップのパスフレーズはキーチェーンに置く。
- **キーチェーンは `/usr/bin/security -i` の標準入力に 1 行を流す**。引数には載せない（`ps` に出るため。research R12 のゲートの結果）。テストはキーチェーンに触れず、`SecretStore` の偽物を使う。
- **平文の写しは `.tmp/` の下に作り、`finally` で必ず消す**（バックアップのスナップショット、復元の展開先）。server の起動時に、前回の異常終了で残った `.tmp/backup-snapshot-*/` を消す。
- **server のテストで API を呼ぶときは `apps/server/test/helpers.ts` の `createTestSession`・`testHeaders` を使う**（cookie と、許す Host・Origin を付ける）。
- `pnpm bench:reports` は認証つき（`scripts/lib/bench-session.ts` がセッションを作る）。
- バックアップには、端末に結びつく設定（Mac の ID、置き場所など。`app_settings`）と認証の表を含めない。復元した帳簿には認証の行がなく、次の起動でパスキーの登録から始まる。
- Tailscale によるリモートの利用（US4: `pnpm start`、server の静的配信、ペアリング）は保留。未実装なので、これらのコマンドや場所を前提にしない。

## 請求と定期仕訳（005）

請求書の発行・入金の消し込み・取消と、定期仕訳の実装は次に置く。

| 層 | 場所 |
|---|---|
| 業務ルール（請求の金額と税、請求番号、支払期限、状態、仕訳の案、発行の巻き戻し `RollbackError`、定期仕訳の予定日と登録する回の選び方） | `packages/domain/src/invoicing/`（`amounts.ts`、`tax.ts`、`number.ts`、`due-date.ts`、`status.ts`、`draft.ts`、`detail.ts`、`journal-drafts.ts`、`rollback.ts`）、`packages/domain/src/recurring/`（`schedule.ts`、`due.ts`） |
| ユースケース | `packages/domain/src/usecases/invoicing.ts`、`recurring.ts` |
| 永続化（設定・条件・工数・請求書・消し込み・定期仕訳・操作の記録） | `packages/db/src/invoicing-repository.ts`、`recurring-repository.ts` |
| HTTP | `apps/server/src/routes/invoicing.ts`、`recurring.ts` |
| server の部品 | `apps/server/src/lib/today.ts`（`todayOf`）、`recurring-scheduler.ts` |
| 画面 | `apps/web/src/features/invoicing/`、`apps/web/src/features/recurring/`、`apps/web/src/routes/e/$entityId/` の `invoice-settings.tsx`・`work-hours.tsx`・`invoices/`・`recurring/` |
| E2E | `apps/web/e2e/invoicing.spec.ts` |

- **書く順序を守る**（research R9）。drizzle のトランザクションは `err` を返しても確定する。ユースケースは (1) 読み取りと検査をすべて先に行い、違反は `err`、(2) 最初の書き込みを 001 の `createJournal` / `voidJournal` にして、その `err` はそのまま返す、(3) 以降の書き込みの失敗・ドメインの判断での中止は `RollbackError`（`DomainError` を持つ例外）を投げて全体を巻き戻し、ユースケースの外側で `err` に直す。
- **請求書・入金の仕訳は `JOURNAL_LINKED` で守る**（R13、[ADR 0008](docs/adr/0008-invoice-journal-linkage.md)）。`source` が `invoice` / `payment` の仕訳は、001 の通常の訂正・取消（`PUT /journals/:id`、`POST /journals/:id/void`）を 409 で拒否する。請求・入金の取消だけが `{ linked: true }` で仕訳を取り消す。`recurring` の仕訳は通常の仕訳と同じく訂正・取消できる。
- **請求書は発行時の写しを持つ**。発行者・宛名・税の表示・支払期限・明細を請求書の行に写し、設定や取引先を後で変えても発行済みの請求書は変わらない。写しの列と明細は DB のトリガーで更新を止める。取消で書けるのは取消の列だけ。物理削除しない。
- **消し込みのある請求書は取消せない**（`INVOICE_HAS_PAYMENTS`）。先に消し込みを取り消す。
- **「今日」は `today: string`（`YYYY-MM-DD`）で domain に渡す**。server は `todayOf(clock)`（`lib/today.ts`）で作る。domain・ルートで `Date.now()`・`new Date()` を直接呼ばない（R22）。ルートは `invoicingRoutes({ clock })`・`recurringRoutes({ clock })`。server のテストは偽の時計を渡し、時刻を日付の境目から離す。
- **仕訳の科目はコードで引く**（R10）。定数 `INVOICING_ACCOUNT_CODES`（`journal-drafts.ts`）が売掛金・売上高・支払手数料のコードを持つ。科目の選択の設定は増やさない。
- **金額と工数は整数**。工数は半時間の整数、明細の金額は `Math.floor(quantityHalves * unitPrice / 2)`。別記の税額は 001 の `computeInclusiveTax` を税率ごとに 1 回。
- 請求・入金の操作は `invoicing_audit_log`（追記のみ）に記録する。仕訳そのものの記録は 001 の `audit_log`。
- E2E（`invoicing.spec.ts`）の対象月・発行日・入金日は固定の日付で、実行日に依存しない。

## データと一時ファイル

- **実データを読まない、コミットしない**。`work/` と `data/` は実データを含む。中身を開く・要約する・テストの入力にする・コミットすることをしない。`.gitignore` で除外済み。
- 既定のデータ位置はリポジトリ直下の `data/`。`TREBUCHET_DATA_DIR` で変更できる。テストでは実データに触れないよう、一時のデータ場所を使う。
- **一時ファイルは `.tmp/` の下だけに作る**（`/tmp` や `os.tmpdir()` は使わない）。`packages/db/src/testing.ts` の `useTempDataDir` を使う。E2E と bench も `.tmp/` を使う。

## 仕様と文書

- Spec Kit の成果物は `specs/<feature>/`（`specs/001-ledger-core/`、`specs/002-freee-import/`、`specs/003-tax-return/`）に置く: `spec.md`、`plan.md`、`research.md`、`data-model.md`、`quickstart.md`、`tasks.md`。
- Spec Kit のテンプレート、スクリプト、憲法（`.specify/memory/constitution.md`）は `.specify/` に置く。
- Spec Kit のスキルは、Claude Code 用が `.claude/skills/speckit-*`、GitHub Copilot CLI 用が `.github/skills/speckit-*` にある。両方の統合を入れてあり、既定は claude。どちらも `uvx --from git+https://github.com/github/spec-kit.git@v1.2.1 specify integration upgrade <claude|copilot>` で更新する（手で片方だけを直さない）。
- Claude Code は、CLAUDE.md がないときにこの AGENTS.md を読む。リポジトリに CLAUDE.md を作らない（作る場合は `@AGENTS.md` を取り込む）。`work/` と `data/` の読み取りは `.claude/settings.json` で拒否している。
- 設計判断は `docs/adr/` に ADR として書く（`NNNN-短い名前.md`、番号は連番）。書式は `docs/adr/0001-sqlite-driver.md` に合わせる。
- AGENTS.md は憲法と矛盾させない。
- コミットメッセージは Conventional Commits に従う。

## 参照

- 仕様: `specs/001-ledger-core/spec.md`
- 設計: `specs/001-ledger-core/plan.md`、`data-model.md`、`research.md`
- 手順: `specs/001-ledger-core/quickstart.md`
- 憲法: `.specify/memory/constitution.md`
- ADR: `docs/adr/`
