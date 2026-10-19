---

description: "Task list for 003-tax-return"
---

# Tasks: 決算処理と確定申告の支援（青色申告決算書の作成）

**Input**: Design documents from `specs/003-tax-return/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: 必須。Constitution V（テストファースト）により、各ユーザーストーリーでテストを先に書き、**失敗することを確認してから**実装する。不変条件 INV-18〜24（data-model §4）は fast-check のプロパティテストで検証する（`fc.assert(fc.property(...))` を直接呼ぶ）。

**Organization**: ユーザーストーリーごとにまとめる。「テスト → 実装」の対は同じタスクの中か、隣り合うタスクに置き、1体の部下にまとめて渡す。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列にしてよい（別ファイルで、未完了のタスクに依存しない）。並列に実行する指示ではない
- **[Story]**: 対応するユーザーストーリー（US1〜US7）
- 参照: `R` は research.md、`INV` と `§` は data-model.md、`D:` は contracts/domain-module.md、`H:` は contracts/http-api.md

## 全タスク共通のルール

- 001・002 の tasks.md の「全タスク共通のルール」をすべて引き継ぐ（依存の向き、整数の金額、`IdGenerator`・`Clock`、テストの一時ファイルは `.tmp/` と `useTempDataDir`、Conventional Commits）
- 相対 import には `.ts` を付ける。enum・parameter properties・namespace は使わない。型だけの import は `import type`
- **実データ（`work/`、`data/`）をテスト・フィクスチャ・文書・コミットに含めない。実データの金額・取引先名・按分率を、コード・コメント・文書・tasks.md に書かない**。実データを読むのは `scripts/verify-tax-return.ts` と `scripts/verify-freee-import.ts` の実行だけ（メインが行う）
- 割合は万分率の整数（0〜10000）。事業分 = `Math.floor(amount * ratio / 10000)`（R5）。浮動小数点で金額を計算しない
- 科目は初期セットのコードで識別する: 売上高 `4010`（欄1）、雑収入 `4020`（欄1）、地代家賃 `5230`（欄23）、減価償却費 `5180`（欄18）、任意科目 `5250〜5290`（欄25〜29）、雑費 `5310`（欄31）、事業主貸 `3090`、事業主借 `3010`、元入金 `3020`、開業費 `1080`、工具器具備品 `1060`（`packages/domain/src/seed/accounts.individual.ts`、`carry-forward.ts` の定数）
- 決算整理の仕訳は 001 の `createJournal(deps: JournalDeps, draft: JournalDraft): Result<CreatedJournal>`（`packages/domain/src/usecases/create-journal.ts:95`）で登録する。`journals.source` と `audit_log` の CHECK は変えない（R4, R12）
- web のテストは Testing Library ＋ jsdom（`apps/web/test/render-route.tsx`、`apps/web/test/mock-api.ts`）。ルートを足したら `pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成してから typecheck する
- マイグレーションは `drizzle-kit generate` の後に `0003_tax_return.sql` の `);` を `) STRICT;` に置き換え、投入とトリガーは `--custom` の SQL で足す（AGENTS.md）
- 依存（npm パッケージ）は追加しない
- 部下は担当のプロジェクトのテストだけを実行する（`pnpm vitest run --project <name>`）。整形は触ったファイルだけに掛ける

---

## Phase 1: Setup（様式の確認と照合スクリプトの骨組み）

**Purpose**: 様式の値を原本で確かめ（R2 のゲート）、実データでの照合の入口を作る

- [ ] T001 `packages/domain/src/blue-return/form.ts` に `BLUE_RETURN_FORMS` と `formForYear(year: number): BlueReturnForm` を定義する（R2、data-model §2 の `BlueReturnForm`）。1ページ: 欄1〜45 の番号と欄名（R2 の一覧）、`kind`（欄8〜24・31 は `account`、25〜30 は `optional`、32・33・43・44・45 は `computed`、2〜7・34〜42 は `unused`）。`salesPartnerRows` は仮の値を入れ `// 要確認: T002` を付ける。貸借対照表の行（R2 の4ページの一覧）と、初期セットの科目コードの対応（`1010`→現金、`1020`→その他の預金、`1030` 等の預金→その他の預金、売掛金、`1060`→工具器具備品、`1080`→繰延資産（開業費。様式の空欄の行に科目名で出す）、`3090`→事業主貸、未払金、`3010`→事業主借、`3020`→元入金）。テスト `packages/domain/test/blue-return/form.test.ts`: 欄番号の重複なし、任意欄が 25〜30 の6欄、初期セットの全科目（`reportLine` のある PL の科目と、BS の科目）が様式のどこかに対応する
- [ ] T002 **（メイン・利用者）** T001 の値を国税庁の令和7年分の青色申告決算書（一般用）の原本（https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/10.pdf）と照らし、売上先の明細の行数、2ページの控除の計算欄の欄番号、4ページの行を確定する。直した値で `form.ts` の `要確認` を外す
- [ ] T003 `scripts/verify-tax-return.ts` の骨組みを作る（R15）: `scripts/verify-freee-import.ts` の取込・`--keep`・`--continue`・`--mapping` の処理を関数として再利用し（必要なら同ファイルから export する）、引数 `--closing <work/の JSON>` を受け取る。JSON の形（`homeUse: { accountCode, ratio, basis }[]`、`assets: { name, acquiredOn, cost, ratio, linkedJournalNo? }[]`、`deductionAnswers`、`expected: { page: number, no: number | string, amount: number }[]`）を先頭のコメントに書く（値は書かない）。この段階では JSON の読込と検証だけを実装し、決算書との照合は T035 で足す。`package.json` に `"verify:tax-return": "node scripts/verify-tax-return.ts"`。`pnpm typecheck` を通す

---

## Phase 2: Foundational（全ストーリーの前提）

**Purpose**: スキーマ、表、ポート、税制の値、テストのジェネレーター、決算書の骨組み

- [ ] T004 `packages/schema/src/blue-return.ts` に Zod スキーマを定義し `packages/schema/src/index.ts` から export する（H: の入出力、data-model §1・§2）: `BlueReturn`、`BlueReturnWarning`（コードは data-model §2 の13種）、`AdjustmentProposal`、`HomeUseAllocationInput`（`businessRatio` は「0〜10000 の整数」、`basis` は「空でない」）、`RentDetailInput`（`deductibleAmount` は「0 ≤ x ≤ annualRent」）、`FixedAssetInput`（`acquisitionCost` は「> 0」、`method` は `"small_asset_28_2"` のみ、`businessRatio` 0〜10000）、`DeductionAnswersInput`（5つの boolean）、`ClosingNoteKind`（`special_circumstances` / `opening_difference`）、`TaxReturnMemoInput`（`kind` は data-model §1.8 の11種、`other` のとき `label` 必須、`amount` は「≥ 0」）、`FiledDocumentInput`（`kind` は `blue_return` / `tax_return` / `attachment` / `other`、`filePath` は空でない）。H: の新しいエラーコード9種を `packages/schema/src/errors.ts` の `ErrorCode` に足す。テスト `packages/schema/test/blue-return.test.ts` で境界値（割合 -1・10001、`deductibleAmount > annualRent`、`other` で `label` なし）を拒否することを確かめる
- [ ] T005 `packages/domain/src/types.ts` と `packages/domain/src/ports.ts` に型と `ClosingStore`・`ClosingUnitOfWork` を追加する（D: のポートの節をそのまま）。`packages/domain/test/fakes.ts` にメモリ上の `FakeClosingStore` と `FakeClosingUnitOfWork`（002 の `fake-import-unit-of-work` と同じ作り。例外で全部を戻す）を足し、`packages/domain/test/fake-closing-unit-of-work.test.ts` で「途中の例外で仕訳も参照も残らない」を確かめる
- [ ] T006 `packages/domain/src/seed/tax-parameters.ts`（R3 の表の6行、出典 URL つき）と `packages/domain/src/blue-return/tax-parameters.ts` の `resolveTaxParameter(key, date, params): TaxParameter | undefined`（`effectiveFrom <= date` の最新で、`effectiveTo` が null または `date <= effectiveTo`。`packages/domain/src/tax-rates.ts:18` の `resolveTaxRate` と同じ書き方）。テスト `packages/domain/test/blue-return/tax-parameters.test.ts`: 2026-03-31 は 300,000、2026-04-01 は 400,000、2029-04-01 は undefined、控除の3つの値
- [ ] T007 `packages/db/src/schema/tenant.ts` に data-model §1.1〜1.10 の10表を追加し、`drizzle-kit generate` で `packages/db/drizzle/tenant/0003_tax_return.sql` を作って STRICT にする。CHECK は data-model の列挙と範囲をそのまま書く（`business_ratio` 0〜10000、`acquisition_cost > 0`、`kind`・`method`・`target_type`・`action` の列挙、`adjustment_journal_refs` の「`kind = home_use` なら `allocation_id` NOT NULL、`depreciation` なら `asset_id` NOT NULL」）。`home_use_allocations` の `sub_account_id IS NULL` の重複を防ぐ部分 UNIQUE インデックス。`--custom` の SQL で、`tax_parameters` に `seed/tax-parameters.ts` と同じ6行を投入し、`adjustment_journal_refs` の削除禁止、`closing_audit_log` の更新・削除禁止のトリガーを作る（`0001_integrity.sql` の書き方）。テスト `packages/db/test/closing-schema.test.ts`: 全表が STRICT、トリガーで削除・更新が失敗、投入値が `TAX_PARAMETERS` と一致、CHECK の違反が失敗
- [ ] T008 `packages/db/src/closing-repository.ts` に `ClosingStore` と `ClosingUnitOfWork`（`journals`・`masters` の既存のリポジトリと同じ接続で1トランザクション。002 の `import-repository.ts` の `ImportUnitOfWork` と同じ作り）を実装し、`packages/db/src/index.ts` から export する。テスト `packages/db/test/closing-repository.test.ts`: 各メソッドの往復、`transaction` の中の例外で仕訳と `adjustment_journal_refs` が両方とも残らない
- [ ] T009 [P] `packages/domain/test/blue-return-arbitraries.ts` に、001 の `packages/domain/test/arbitraries.ts`（`accountSetArb`、`amountArb`）を使って「個人の初期セットの科目、取引先、期首残高（貸借一致）、1年分の仕訳（売上・雑収入・経費・任意科目・事業主貸借を含む、取引先なしの売上を含む）」を作る `yearLedgerArb` と、按分の登録の `homeUseArb`（割合 0〜10000）を作る。`packages/domain/test/blue-return-arbitraries.test.ts` で、生成した仕訳がすべて `validateJournal` を通ることを確かめる

**Checkpoint**: `pnpm vitest run --project domain`、`--project db`、`--project schema` が通る

---

## Phase 3: User Story 1 - 損益計算書・控除・出力 (Priority: P1) 🎯 MVP

**Goal**: 決算書1ページと控除・所得金額を画面・CSV・印刷で示す

**Independent Test**: 合成の年度で各欄、任意科目の科目名、経費計・差引金額・所得金額、控除額、CSV と画面の一致を確かめる

- [ ] T010 [US1] テスト先行で `packages/domain/src/blue-return/deduction.ts` を実装する（D: `blueDeductionCap`・`blueDeduction`、R9、INV-22）。テスト `packages/domain/test/blue-return/deduction.property.test.ts`: INV-22（`0 ≤ 控除額 ≤ 上限額`、`= min(上限額, max(0, 欄43))`）、回答の組み合わせ5ビットの全32通りで tier（正規の簿記・添付・期限内がすべて真で e-Tax か電子帳簿が真 → `max`、前の3つだけ → `standard`、それ以外 → `basic`）と `unmet`、回答なしは `undefined`
- [ ] T011 [US1] テスト先行で `packages/domain/src/blue-return/build.ts` の `buildBlueReturn(input)` の1ページと控除の部分を実装する（D: `buildBlueReturn`、R1、INV-18）。001 の `buildProfitAndLoss`（`packages/domain/src/reports/profit-and-loss.ts:20`）で科目ごとの金額を求め、`formForYear` の欄に並べる。任意科目（`reportLine` 25〜30 の科目と、一般の欄に当たらない費用の科目）は欄25から科目名つきで詰め、6つを超えたら `OPTIONAL_LINES_OVERFLOW`。経費計・差引金額が PL の費用合計・利益と違えば `PL_MISMATCH`。控除の回答がなければ `DEDUCTION_ANSWERS_MISSING` で欄44・45 を `null`。`transfer`（欄45・欄44）、`status`。テスト `packages/domain/test/blue-return/build-page1.test.ts`（固定の小さな帳簿で各欄、任意科目7つの警告、`unused` の欄は 0）と `packages/domain/test/blue-return/build.property.test.ts`（`yearLedgerArb` で INV-18）
- [ ] T012 [US1] テスト先行で `packages/domain/src/blue-return/csv.ts` の `blueReturnToCsv(blueReturn, { blankUnused })` を実装する（R14。001 の `encodeCsv`（`packages/domain/src/reports/csv.ts:37`）を使い、列は `ページ,欄番号,欄名,金額`）。テスト `packages/domain/test/blue-return/csv.test.ts`: CSV を `parseCsv` で読み戻した金額が `blueReturn` と一致、`blankUnused` で `unused` の欄が空
- [ ] T013 [US1] テスト先行で `packages/domain/src/usecases/blue-return.ts` に `getBlueReturn(deps, { fiscalYear })` と `saveDeductionAnswers(deps, { fiscalYear, answers })` を実装する（D: ユースケース）。法人なら `ENTITY_KIND_UNSUPPORTED`。年度がなければ 001 と同じ `NOT_FOUND`。回答の保存は `closing_audit_log` に `blue_deduction_answer` で残す。テスト `packages/domain/test/blue-return/usecase-page1.test.ts`（`FakeClosingStore` と 001 の fakes）
- [ ] T014 [US1] テスト先行で `apps/server/src/routes/blue-return.ts` に `GET /entities/:id/blue-return/:year`、`GET .../csv`、`GET/PUT .../deduction-answers` を実装し `apps/server/src/app.ts` に登録、`apps/server/src/deps.ts` に `ClosingStore` を組み立てる（H: 決算書、控除の回答）。テスト `apps/server/test/blue-return.api.test.ts`: 200 の形、CSV の `content-type`、法人で 422 `ENTITY_KIND_UNSUPPORTED`、`blankUnused`
- [ ] T015 [US1] テスト先行で画面を作る: `apps/web/src/routes/e/$entityId/blue-return/index.tsx`（年度の一覧）、`apps/web/src/routes/e/$entityId/blue-return/$year/index.tsx`（1ページの表、「締め前（暫定）」、第一表に転記する値の強調、警告の一覧、CSV のダウンロード、「印刷」ボタン）、`apps/web/src/routes/e/$entityId/blue-return/$year/deduction.tsx`（要件の5つの質問、上限額と満たさない要件の表示）、`apps/web/src/features/blue-return/`（`FormPage1.tsx`、`WarningList.tsx`、`print.css`: A4 縦、ページごとの改ページ、ナビを隠す）。ナビに「決算書」を足す。テスト `apps/web/test/routes/blue-return.test.tsx`: 欄の表示、回答なしの表示、警告、回答の保存

**Checkpoint**: 決算書の1ページと控除・所得金額が画面と CSV で出る（MVP）

---

## Phase 4: User Story 2 - 家事按分 (Priority: P1)

**Goal**: 按分の登録 → 振替の案 → 登録 → 決算書に反映、地代家賃の内訳

**Independent Test**: 合成の年度で按分の案の金額、登録後の欄23 と事業主貸、古い振替の警告、内訳の不一致の警告を確かめる

- [ ] T016 [US2] テスト先行で `packages/domain/src/blue-return/home-use.ts` の `computeHomeUse`・`validateHomeUseAllocation`・`proposeHomeUseAdjustment` を実装する（D:、R4〜R6、INV-20、INV-23）。帳簿の金額は対象の科目（補助科目）の年間の借方−貸方から、`adjustment_journal_refs` の `home_use` で結びついた有効な仕訳の行を除いた額。案の仕訳は年度末日付の「事業主貸 `3090` / 対象の科目（家事分）」。登録済みの振替があれば差額だけの案にし、差があることを示す。帳簿の金額 ≤ 0、割合 10000 は案なし（理由つき）。根拠が空なら `HOME_USE_BASIS_REQUIRED`、前の年度と割合が違い理由が空なら `HOME_USE_CHANGE_REASON_REQUIRED`。テスト `packages/domain/test/blue-return/home-use.property.test.ts`（INV-20: `0 ≤ 事業分 ≤ 金額`、`事業分 + 家事分 = 金額`、割合 0・10000 の端。INV-23: 案が `validateJournal` を通る）と `home-use.test.ts`（spec US2 の受け入れシナリオ1〜3・5 の数値: 1,200,000円 × 3000 → 事業分 360,000・家事分 840,000）
- [ ] T017 [US2] テスト先行で `buildBlueReturn` に按分の反映と地代家賃の内訳を足す（FR-016、FR-017）: 按分の登録ごとに `HOME_USE_ADJUSTMENT_STALE`（差額）、2ページの `rentDetails`、必要経費算入額の合計 ≠ 欄23 なら `RENT_DETAILS_MISMATCH`。テスト `packages/domain/test/blue-return/build-home-use.test.ts`
- [ ] T018 [US2] テスト先行で `packages/domain/src/usecases/blue-return.ts` に `saveHomeUseAllocation`、`saveRentDetails`、`getAdjustmentProposals`、`commitAdjustment` を実装する（D: ユースケース）。`commitAdjustment` は `ClosingUnitOfWork.transaction` の中で案を作り直し、`expected.amount` と違えば `ADJUSTMENT_CHANGED`（`details.proposal`）、案がなければ `ADJUSTMENT_NOT_NEEDED`、`createJournal` → `insertAdjustmentRef`。締め済みの年度は 001 の `PERIOD_CLOSED`。この関数は US3 の `depreciation` でも使うので、`kind` で案の作り方を切り替える形にする。テスト `packages/domain/test/blue-return/usecase-adjustment.test.ts`（締め済み、金額の変化、途中の失敗で何も残らない）と `packages/db/test/closing-adjustment.test.ts`（実 DB で仕訳と参照が1トランザクション）
- [ ] T019 [US2] テスト先行で `apps/server/src/routes/blue-return.ts` に `GET/PUT .../home-use`、`GET/PUT .../rent-details`、`GET/POST .../adjustments` を足す（H: 案、按分・内訳）。テスト `apps/server/test/blue-return.home-use.api.test.ts`: 422 の2コード、409 `ADJUSTMENT_CHANGED`、`PERIOD_CLOSED`、201 の形
- [ ] T020 [US2] テスト先行で `apps/web/src/routes/e/$entityId/blue-return/$year/home-use.tsx` と `apps/web/src/features/blue-return/`（`HomeUseForm.tsx`、`RentDetailsTable.tsx`、`AdjustmentPanel.tsx`: 帳簿の金額・割合・事業分・家事分・仕訳の案を見せ「仕訳を登録」）を作る。割合は「%」で小数第2位まで入力し、万分率に変換する。決算書の画面から按分の画面へのリンク、古い振替の警告から案へのリンク。テスト `apps/web/test/routes/blue-return-home-use.test.tsx`

**Checkpoint**: US1 と US2 で、自宅兼事務所の利用者の決算書の1・2ページが揃う

---

## Phase 5: User Story 3 - 少額減価償却資産 (Priority: P2)

**Goal**: 固定資産台帳、償却の案、3ページの表

**Independent Test**: 基準額・年間の上限の検査、償却の案、3ページの列、欄18との一致

- [ ] T021 [US3] テスト先行で `packages/domain/src/blue-return/depreciation.ts` の `DEPRECIATION_METHODS`、`validateFixedAsset`、`depreciate`、`proposeDepreciationAdjustment` を実装する（D:、R7、INV-21、INV-23）。案は「減価償却費 `5180` / 資産の勘定（取得価額）」と、家事分があれば「事業主貸 `3090` / 減価償却費 `5180`（家事分）」。`linkedJournalId` があれば案なし。エラーは `SMALL_ASSET_OVER_THRESHOLD`（`details.threshold`、`effectiveFrom`）、`SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED`（`details.limit`、`total`）、`SMALL_ASSET_NOT_APPLICABLE`、`DEPRECIATION_METHOD_UNSUPPORTED`。テスト `packages/domain/test/blue-return/depreciation.property.test.ts`（INV-21、INV-23）と `depreciation.test.ts`（spec US3 のシナリオ1〜5、2026-03-31 取得の 350,000 は拒否・2026-04-01 取得は可）
- [ ] T022 [US3] テスト先行で `buildBlueReturn` に3ページの減価償却費の計算を足す（FR-023）: その年度に取得した、または未償却残高のある、除却していない資産を並べ、必要経費算入額の合計 ≠ 欄18 なら `DEPRECIATION_MISMATCH`。`usecases/blue-return.ts` に `saveFixedAsset`・`disposeFixedAsset`（履歴 `fixed_asset`）と、`commitAdjustment` の `depreciation` の分岐を足す。テスト `packages/domain/test/blue-return/build-depreciation.test.ts`、`usecase-fixed-asset.test.ts`
- [ ] T023 [US3] テスト先行で `apps/server/src/routes/fixed-assets.ts`（H: 固定資産台帳の4つ）を作り `app.ts` に登録する。テスト `apps/server/test/fixed-assets.api.test.ts`: 422 の4コード、除却、`?year=` の `depreciation`
- [ ] T024 [US3] テスト先行で `apps/web/src/routes/e/$entityId/fixed-assets/index.tsx`（台帳の一覧、登録・編集・除却、償却の方法は「少額減価償却資産の特例（措置法28条の2）」だけ、既存の仕訳を結びつける選択）と決算書の3ページの表示（`FormPage3.tsx` の減価償却の部分）、償却の案を `AdjustmentPanel` に出す。ナビに「固定資産台帳」。テスト `apps/web/test/routes/fixed-assets.test.tsx`

---

## Phase 6: User Story 4 - 貸借対照表と元入金の繰越 (Priority: P2)

**Goal**: 4ページ、期首と前期末の食い違いの検知と説明、負の残高・繰延資産の知らせ

**Independent Test**: 合成の2年度で、正しい繰越と売掛金をずらした繰越の検査、貸借の一致、説明メモ

- [ ] T025 [US4] テスト先行で `packages/domain/src/blue-return/opening-check.ts` の `checkOpeningCarryForward(priorClosing, opening, accounts)` を実装する（D:、R8）。002 の `carryForward`（`packages/domain/src/carry-forward.ts:21`）で前の年度の期末から期首の値を求め、科目（補助科目）ごとに登録された期首と比べる。テスト `packages/domain/test/blue-return/opening-check.property.test.ts`: `carryForward` の結果をそのまま期首にすれば差は0件、1科目をずらすとその科目と元入金だけに差が出る（002 の `packages/domain/test/carry-forward.property.test.ts` のジェネレーターを使う）
- [ ] T026 [US4] テスト先行で `buildBlueReturn` に4ページを足す（FR-028〜032、INV-19）: 期首（期首残高）と期末（`buildBalanceSheet`、`packages/domain/src/reports/balance-sheet.ts:28`）を `form.ts` の行にまとめる。事業主貸・事業主借・控除前の所得は期首を空欄。期末の資本の部に欄43。資産合計 = 負債・資本合計を確かめる。前の年度があれば `checkOpeningCarryForward` で `OPENING_MISMATCH`（科目、期待値、実際、差額）、前の年度が締め前なら `PRIOR_PERIOD_OPEN`、`detectWarnings`（`packages/domain/src/reports/warnings.ts:19`）の `NEGATIVE_BALANCE`、開業費 `1080` の残高が期首 = 期末 ≠ 0 なら `DEFERRED_ASSET_NOT_AMORTIZED`、`opening_difference` のメモを警告に添える。`getBlueReturn` で前の年度の期末の残高を読む。`saveClosingNote` を足す（履歴 `closing_note`）。テスト `packages/domain/test/blue-return/build-page4.test.ts`（spec US4 のシナリオ1〜7）と `build.property.test.ts` に INV-19 を足す
- [ ] T027 [US4] テスト先行で `apps/server/src/routes/blue-return.ts` に `PUT .../notes/:kind` を足し、`apps/web/src/features/blue-return/FormPage4.tsx`（期首・期末の表、繰越の検査、差の説明の入力）を作る。テスト `apps/server/test/blue-return.notes.api.test.ts`、`apps/web/test/routes/blue-return-page4.test.tsx`

---

## Phase 7: User Story 5 - 月別売上と売上先 (Priority: P2)

**Goal**: 2ページの月別売上、3ページの売上先の明細、特殊事情のメモ

**Independent Test**: 合成の年度で月別の金額、上位と「上記以外」の集約、合計の一致の検査

- [ ] T028 [US5] テスト先行で `packages/domain/src/blue-return/sales.ts` の `summarizeMonthlySales`・`summarizeSalesPartners` を実装し、`buildBlueReturn` の2・3ページと `SALES_TOTAL_MISMATCH`・`SALES_WITHOUT_PARTNER`・`DUPLICATE_PARTNER_NAME` を足す（D:、R10、INV-24）。売上高 `4010` と雑収入 `4020` を分けて月ごとに貸方−借方、売上先は `4010` の行を取引先ごとに降順（同額は名前の順）で `salesPartnerRows` 行まで、残り・取引先なし・雑収入を「上記以外の売上先の計」。特殊事情のメモ（`special_circumstances`）を3ページに含める。テスト `packages/domain/test/blue-return/sales.property.test.ts`（INV-24）と `sales.test.ts`（spec US5 のシナリオ1〜4、借方の売上の差し引き）
- [ ] T029 [US5] テスト先行で `apps/web/src/features/blue-return/FormPage2.tsx`（月別売上、地代家賃の内訳、控除の計算）と `FormPage3.tsx` の売上先の部分、特殊事情のメモの入力（`PUT .../notes/special_circumstances`）を作る。テスト `apps/web/test/routes/blue-return-page2-3.test.tsx`

---

## Phase 8: User Story 6 - 確定申告の控え (Priority: P3)

**Goal**: 事業所得以外の控えと提出書類の場所を年度ごとに記録

**Independent Test**: 登録・編集・削除・一覧、ファイルの有無の表示、決算書の値が変わらないこと

- [ ] T030 [US6] テスト先行で `usecases/blue-return.ts` に `saveTaxReturnMemo`・`deleteTaxReturnMemo`・`saveFiledDocument`・`deleteFiledDocument` と一覧を足し（FR-033〜035）、`apps/server/src/routes/tax-return.ts`（H: 控え・書類の8つ。`fileExists` は `node:fs` の `existsSync`、R13）を作って `app.ts` に登録する。テスト `packages/domain/test/blue-return/usecase-tax-return.test.ts`（控えを足しても `getBlueReturn` の値が変わらない: FR-034）と `apps/server/test/tax-return.api.test.ts`（`useTempDataDir` の下に作ったファイルで `fileExists: true`、ないパスで `false`）
- [ ] T031 [US6] テスト先行で `apps/web/src/routes/e/$entityId/tax-return/$year.tsx`（控えの表: 種類・金額・ファイルの場所・メモ・有無、書類の表: 種類・場所・提出日・メモ・有無）を作り、ナビに「申告の控え」を足す。テスト `apps/web/test/routes/tax-return.test.tsx`

---

## Phase 9: User Story 7 - 免税の期間の税区分の警告 (Priority: P3)

**Goal**: 取込のプレビューで免税の期間の `TAX_CATEGORY_SUSPICIOUS` を1件にまとめる

**Independent Test**: 免税・課税・年の途中で切り替わる事業体で、プレビューの警告の出方を比べる

- [ ] T032 [US7] テスト先行で `packages/schema/src/import.ts` の `ImportWarningCode` に `TAX_CATEGORY_SUSPICIOUS_EXEMPT` を足し、`packages/domain/src/import/freee/plan.ts` の `warningsOf`（:628、`TAX_CATEGORY_SUSPICIOUS` は :659〜672）で、仕訳の日付の消費税の設定（`resolveTaxSetting`、`packages/domain/src/tax-settings.ts:71`）が `exempt` のものを集め、`{ code: "TAX_CATEGORY_SUSPICIOUS_EXEMPT", details: { count, freeeJournalIds } }` の1件にまとめる（R11、FR-037）。**`TAX_CATEGORY_SUSPICIOUS` を参照するテストを `grep -rn TAX_CATEGORY_SUSPICIOUS packages apps` で探し、domain・server・web のすべてで直す**。テスト `packages/domain/test/import/plan-exempt.test.ts`（spec US7 のシナリオ1〜3）
- [ ] T033 [US7] テスト先行で `apps/web/src/features/imports/` のプレビューの警告の一覧で、`TAX_CATEGORY_SUSPICIOUS_EXEMPT` を「免税の期間のため税区分の警告を N 件まとめました」の1行と、開くと freee の仕訳 ID の一覧が出る形で表示する。テスト `apps/web/test/features/imports/` の既存のプレビューのテストに足す

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T034 `scripts/bench-reports.ts` に、2,000仕訳の帳簿での `getBlueReturn` の計測を足し、約500仕訳で2秒以内を確かめる（SC-006）。結果の数値はコミットしない
- [ ] T035 `scripts/verify-tax-return.ts` に照合を足す（R15、T003 の続き）: 取込の後、JSON の按分・資産（`linkedJournalNo` があれば結びつけ）・控除の回答を登録し、`getAdjustmentProposals` の案を登録し、`getBlueReturn` の各欄を `expected` と照合して「欄ごとの一致・不一致と件数」だけを出す。`--continue` の年度では、警告のコード（`NEGATIVE_BALANCE`、`OPENING_MISMATCH`）と科目名だけを出す（金額は出さない）
- [ ] T036 文書を更新する: `AGENTS.md`（決算書の置き場所 `packages/domain/src/blue-return/`、`verify:tax-return` のコマンド、税制の値の足し方: `seed/tax-parameters.ts` とマイグレーションの両方）、`README.md`（決算の手順）、`docs/adr/0005-closing-adjustments-as-journals.md`（按分・償却を決算整理の仕訳にする判断、R4。書式は `docs/adr/0001-sqlite-driver.md`）、`specs/001-ledger-core/spec.md` と `specs/002-freee-import/spec.md` の Assumptions の「認証とバックアップは 003」を「後の機能」に直す
- [ ] T037 **（メイン）** quickstart.md の §2 を `TREBUCHET_DATA_DIR=.tmp/quickstart-003` で手動確認し（implementer にブラウザの MCP の snapshot で行わせる）、画面の文言と件数・金額を quickstart.md に合わせる
- [ ] T038 **（メイン）** 実データで `pnpm verify:tax-return` を実行し、SC-001（2025年分の1〜4ページが R7 と一致）と SC-002（2024年 → 2025年の負の売掛金と期首の食い違いの検知）を確かめる。結果の数値はリポジトリに書かない。一致しなければ原因を調べて直す
- [ ] T039 **（メイン）** 全体の検証: `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @trebuchet/web build`、`pnpm --filter @trebuchet/web e2e`（既存の2本が壊れていないこと）

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup（T001〜T003）→ Foundational（T004〜T009）→ US1 → US2 → US3〜US7 → Polish
- T002（様式の確認）は T001 の後、US5（売上先の行数）より前に済ませる
- T003 は T035 の前提

### User Story Dependencies

- **US1**: Foundational の後。ほかのストーリーの前提（`buildBlueReturn` の骨組み、画面）
- **US2**: US1 の後（`commitAdjustment` を US3 が使う）
- **US3**: US2 の後（`commitAdjustment`、`AdjustmentPanel`）
- **US4**: US1 の後。US2・US3 と独立
- **US5**: US1 と T002 の後
- **US6**: Foundational の後。ほかと独立
- **US7**: 独立（002 の取込だけに触る）

### Within Each User Story

- テスト → ドメイン → ユースケース → リポジトリ → API → 画面
- テストが旧コードで落ちることを確かめてから実装する（部下が赤の確認を飛ばしたら、メインが `git stash` で確かめる）

### Parallel Opportunities

- T009 は T004〜T008 と別ファイル
- US4・US6・US7 は US1 の後なら互いに独立

## Parallel Example: User Story 4（US2 と並行にしてよい）

```text
T025 opening-check.ts（domain）
T026 build.ts の4ページ（T025 の後）
T027 server と web（T026 の後）
```

## Implementation Strategy

### MVP First（US1 だけ）

1. Setup と Foundational
2. US1（1ページ、控除、CSV、印刷）
3. 合成の帳簿で欄45 を確かめる

### Incremental Delivery

1. US1 → US2（按分）で、自宅兼事務所の利用者の主な欄が揃う
2. US3（償却）・US4（貸借対照表）・US5（売上の明細）で4ページが揃う
3. US6・US7 は補助
4. 区切りごとにコミットし、`/usage` を控える

## Notes

- 部下への渡し方: 1体に「1つのユーザーストーリーのテストと実装」をまとめて渡す（US1 は T010〜T013 を implementer-hard、T014〜T015 を implementer など、ドメインの計算と整合性は implementer-hard、API と画面は implementer）
- implementer-hard に渡す: T005（UoW）、T008、T011、T016〜T018、T021〜T022、T025〜T026、T028、T032
- 完了の [X] はメインがまとめて付ける
