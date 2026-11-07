---
description: "Task list for 013 源泉徴収"
---

# Tasks: 源泉徴収

**Input**: `specs/013-withholding-tax/`（spec、plan、research R1〜R9、data-model §1〜5、contracts/http-api.md §1〜4、quickstart）

**Tests**: テスト先行（Constitution V）。各タスクはテストを書いて赤を確かめてから実装する。テストと実装は同じタスクに入れてある（1 体の部下にまとめて渡す単位）

**Organization**: ストーリーごと。[P] は並列にしてよい印で、実行は順番に行う

## 全タスク共通のルール

- **[AGENTS.md](../../AGENTS.md) の「開発の進め方」「データと一時ファイル」に従う**（テスト先行、`TenantUnitOfWork`、`respond`、web の `features/invoicing/api.ts` と `invalidateLedger`、新しい API を呼ぶ画面は `mock-api.ts` に既定の応答を足す、ルートを足したら `pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成してから typecheck、`--custom` のマイグレーション、エラーコード・共有の型を変えるときの `grep -rn <値> packages apps scripts`、部下のテストの範囲）
- この機能に固有: **依存（npm）を足さない**。005 の発行の仕訳（売掛金／売上高を total で）と INV-30〜39 の意味は変えない（充当額に源泉徴収税額を含めるだけ）。源泉徴収の率・境目をロジックに直書きしない（`resolveTaxParameter`、R2）。金額は整数（R1）
- 「源泉徴収なし」の取引先の請求・入金は今と同じ結果になる（SC-005）。005 の既存のテストは期待値を変えずに通す（列が増えた応答の型の修正だけは可）
- マイグレーションは最新が `0019_keen_earthquake`。生成した順に番号が付く
- 実データ（`work/`・`data/`）は扱わない

## Phase 1: Foundational（全ストーリーの前提）

- [X] T001 税制の値と計算の関数（R1・R2・R3、data-model §1.1・§2、INV-73）。先に `packages/domain/test/invoicing/withholding.property.test.ts`（INV-73 の性質と quickstart の 3 例、base ≤ 0 は 0）と `withholdingBase` の具体例（`separate` で税率つきの内訳あり → `total − Σ tax`、それ以外は `total`）を書いて赤を確かめる。実装: `packages/domain/src/invoicing/withholding.ts` に `withholdingBase(amounts: {total, taxBreakdown}, taxDisplay)` と `withholdingTax(base, date, params): Result<number>`（値がなければ `WITHHOLDING_RATE_MISSING`、details `{ date }`）。`packages/domain/src/types.ts` の `TaxParameterKey` に `WITHHOLDING_THRESHOLD`・`WITHHOLDING_RATE_LOW`・`WITHHOLDING_RATE_HIGH`、`packages/domain/src/seed/tax-parameters.ts` に 3 行（2013-01-01〜2026-12-31 と 2027-01-01〜2047-12-31 の 2 期間、1000000・1021・2042。出典の国税庁の URL は WebFetch で開いて確かめてから書く）。`packages/domain/test/blue-return/tax-parameters.test.ts` の行数（14）を直す
- [X] T002 表の列とマイグレーション（data-model §1.1〜1.4、R4・R5）。先に `packages/db/test/invoicing-migration.test.ts` に「3 表の新しい列の既定値 0」「`withholding IN (0,1)`・`withholding_amount >= 0`・`0 ≤ withholding_tax ≤ withholding_base ≤ total` の CHECK 違反が拒まれる」「発行済みの `withholding_base`・`withholding_tax` の UPDATE をトリガーが拒む（INV-38）」を足し、`packages/db/test/closing-repository.test.ts` の `TAX_PARAMETERS` 一致で赤を確かめる。実装: `packages/db/src/schema/tenant.ts` に列。マイグレーションは `--custom` の `ALTER TABLE ... ADD COLUMN ... CHECK (...)` で足し、表を作り直さない（他の列を参照する CHECK は drizzle が出力しないため。ADD COLUMN で書けなければ表を作り直し、0006 のトリガーと外部キーを張り直す）。同じく `--custom` で `--custom` で `tax_parameters` の CHECK の作り直し（0014 の `__old_tax_parameters` の例）と 3 行の INSERT、`invoices_void_only` の作り直し（2 列を足す）

## Phase 2: User Story 1 - 源泉徴収のある取引先の請求書を出す（P1）🎯 MVP

**Goal**: 「源泉徴収あり」の取引先の請求書に源泉徴収税額と差引請求額を載せ、発行時に固定する

**Independent Test**: 合計 1,205,000 円（税込のみ）の請求書を発行し、源泉徴収税額 143,961 円・差引 1,061,039 円が写しに載り、仕訳が売掛金／売上高 1,205,000 円の 1 件であること

- [ ] T003 [US1] 請求の条件と発行（R4・R5、contracts §1・§2、FR-001〜007）。先に `packages/domain/test/invoicing/`（partner-profile、issue、draft の各テスト）と `packages/db/test/invoicing-issue.test.ts` に、`withholding` の保存と読み戻し、発行時の `withholdingBase`・`withholdingTax` の固定（「なし」は 0・0、設定を後で変えても写しは不変）、`WITHHOLDING_RATE_MISSING`（計算・案・発行のどれも）、発行の仕訳が変わらないこと、請求の条件の監査の記録の after に `withholding` が入ること（FR-015）を足して赤を確かめる。実装: `packages/schema/src/invoicing.ts` の `BillingTermsFields.withholding: z.boolean().default(false)` と応答の `withholdingBase`・`withholdingTax`・`netAmount`、`packages/domain/src/usecases/invoicing.ts` の `saveBillingTerms`・`previewInvoiceCalculation`・`draftInvoices`・`issueInvoice`（T001 の関数を使う）、db の請求のリポジトリの読み書き
- [ ] T004 [US1] server（contracts §1・§2）。先に `apps/server/test/invoicing.settings.api.test.ts`・`invoicing.calculation.api.test.ts`・`invoicing.issue.api.test.ts`・`partners-profile.api.test.ts`・`invoicing.list.api.test.ts` に `withholding` の往復、計算・案・発行・詳細の 3 項目、`WITHHOLDING_RATE_MISSING` の 422 を足して赤を確かめる。実装: `apps/server/src/routes/invoicing.ts` と `apps/server/src/errors.ts` の対応
- [ ] T005 [US1] web（R8、FR-005）。先に `apps/web/test/routes/partners.test.tsx`（「源泉徴収あり」のチェック）、`invoices-new.test.tsx`（案の源泉徴収税額・差引請求額）、`invoice-detail.test.tsx`・`invoice-print.test.tsx`（0 なら行を出さない、あれば合計の後に 2 行）を足して赤を確かめる。実装: `apps/web/src/features/invoicing/BillingTermsFields.tsx`、`InvoicePrint.tsx`、`InvoiceDetail.tsx`、案の画面、`apps/web/test/mock-api.ts`・`invoicing-fixtures.ts` の既定値

**Checkpoint**: US1 だけで請求書が正しく出せる

## Phase 3: User Story 2 - 源泉徴収された入金を消し込む（P1）

**Goal**: 消し込みで源泉徴収税額を事業主貸に計上し、売掛金を消す

**Independent Test**: US1 の請求書に 1,061,039 円を消し込み、普通預金 1,061,039・事業主貸 143,961 ／ 売掛金 1,205,000 の仕訳 1 件で「入金済み」になること

- [ ] T006 [US2] 消し込みの domain と db（R6、data-model §2・§3、INV-74、FR-008〜012）。先に `packages/domain/test/invoicing-payments.property.test.ts` を拡張して INV-74（任意の発行・消し込み（源泉徴収税額・差額つき）・取消の列で Σ 充当額 ≤ total、貸借一致、売掛金の貸方 = 充当額、事業主貸 3090 の借方 = withholdingAmount、INV-33・34 が成り立つ）を足し、`packages/domain/test/invoicing/payments.test.ts`（spec US2 の 1〜6、一部入金の 2 回目の残り）と `packages/db/test/invoicing-payments.test.ts`（列の保存、取消）、消し込みの監査の記録の after に `withholdingAmount` が入ること（FR-015）も足して赤を確かめる。実装: `PaymentInput.withholdingAmount`（省略は 0）、`invoicing/status.ts` の充当額、`recordPayment` の fee の式と `PAYMENT_EXCEEDS_BALANCE`、`invoicing/journal-drafts.ts` の `paymentJournalDraft`、詳細の `withholdingPaid`・`withholdingRemaining`、db のリポジトリ
- [ ] T007 [US2] server（contracts §3）。先に `apps/server/test/invoicing.payments.api.test.ts` に源泉徴収税額つきの消し込み・仕訳・残額超過（`details.applied` に源泉徴収税額を含む）・取消と、`GET /invoices/:invoiceId` の `withholdingPaid`・`withholdingRemaining`、事業主貸の行を含む入金の仕訳の訂正が `JOURNAL_LINKED`（409）で拒まれること（FR-012）を足して赤を確かめる。実装: `apps/server/src/routes/invoicing.ts`
- [ ] T008 [US2] web（R8、FR-008）。先に `apps/web/test/routes/invoices-payments.test.tsx` に「源泉徴収税額」の欄（既定は `withholdingRemaining`、直せる、送信の本文に入る、差額の扱いと併用）を足して赤を確かめる。実装: 入金の消し込みの入力（`apps/web/src/features/invoicing/` の該当コンポーネント）、`api.ts` の `postPayment` の型

**Checkpoint**: US1・US2 で請求から入金まで売掛金が 0 になる

## Phase 4: User Story 3 - 年間の源泉徴収税額を確かめる（P2）

**Goal**: 暦年ごと・取引先ごとの源泉徴収税額の一覧

**Independent Test**: 2026 年の入金 2 件と 2027 年 1 月の入金 1 件のうち、2026 年の一覧に 2 件だけが取引先ごとに集計され、合計が仕訳の事業主貸の合計と一致すること

- [ ] T009 [US3] 集計の domain と db（R7、contracts §4 の型、INV-75、FR-013・014）。先に `packages/domain/test/invoicing/withholding-summary.property.test.ts`（INV-75: 任意の消し込み・取消の列で、一覧の合計 = その暦年の取消でない `source = "payment"` の仕訳の事業主貸の借方の合計。年またぎ・取消・`withholdingAmount = 0` を除く）と `packages/db/test/invoicing-payments.test.ts` の集計の問い合わせを足して赤を確かめる。実装: `packages/schema/src/invoicing.ts` の `WithholdingSummary`、`packages/domain/src/usecases/invoicing.ts` の `withholdingSummary(deps, year)`、db のリポジトリの問い合わせ
- [ ] T010 [US3] server（contracts §4）。先に `apps/server/test/invoicing.withholding.api.test.ts`（新規。集計・空の年・4 桁でない年）と `apps/server/test/auth-coverage.test.ts`（INV-29）に足して赤を確かめる。実装: `GET /withholding/:year`（`validate("param", FiscalYearParam)`）
- [ ] T011 [US3] web（R8）。先に `apps/web/test/routes/invoices-withholding.test.tsx`（新規。年の選択、取引先ごとの行、行を開くと明細、合計）を足して赤を確かめる。実装: `apps/web/src/routes/e/$entityId/invoices/withholding.tsx`（`?year=`、既定は今年）、`features/invoicing/api.ts` の `withholdingSummaryQuery`、請求の画面からのリンク、`mock-api.ts`。`pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成

## Phase 5: Polish & Cross-Cutting

- [ ] T012 文書（R9）: `docs/adr/0015-withholding-at-payment.md`（入金の時点で事業主貸に計上、対象額の規則、法人は範囲外）、`docs/features/013-withholding-tax.md`（層の表と固有の規則）と AGENTS.md の「機能ごとの文書」の表に 1 行、`docs/requirements.md` の FR-05 の状態（済 013）と、「仮払税金の処理」の文言を「源泉徴収税額は入金の時点で事業主貸に計上」に直す、`specs/INVARIANTS.md` に INV-73〜75（data-model §4）
- [ ] T013 マニュアル（FR-016）: `apps/web/src/features/manual/content.ts` の `masters`・`invoices`・`payments` の記事に源泉徴収の設定・請求書の行・消し込みの欄・年間の一覧を足し、`pnpm manual:check` を通す（撮影は T015 で利用者の端末）
- [ ] T014 最終の検証（メイン）: `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @trebuchet/web build`、`pnpm manual:check`
- [ ] T015 利用者の端末での確認: quickstart の 1〜5 と、`pnpm manual:capture` → 画像の確認 → `pnpm manual:record`（docs/features/012-app-manual.md）

## Dependencies & Execution Order

- T001 → T002 → US1（T003 → T004 → T005）→ US2（T006 → T007 → T008）→ US3（T009 → T010 → T011）→ T012〜T015
- US2 は US1 の写しの `withholdingTax` を既定値に使う。US3 は US2 の `withholding_amount` を集計する
- [P] は付けていない（同じファイル `usecases/invoicing.ts`・`routes/invoicing.ts`・`schema/invoicing.ts` を順に触るため）

## Implementation Strategy

- MVP は Phase 1 + US1（請求書が正しく出る。入金は差額の扱いで手当てできる）
- 部下への渡し方: T001・T002 を 1 体、T003〜T005 を 1 体、T006〜T008 を 1 体（T006 は INV-74 の性質の設計を伴う。implementer で進め、整合性の判断が要ると報告されたら implementer-hard）、T009〜T011 を 1 体、T012・T013 を 1 体。区切りごとにメインがコミットする
