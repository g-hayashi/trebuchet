---

description: "Task list for 003-tax-return"
---

# Tasks: 決算処理と確定申告の支援（青色申告決算書の作成）

**Input**: Design documents from `specs/003-tax-return/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: 必須。Constitution V（テストファースト）により、各ユーザーストーリーでテストを先に書き、**失敗することを確認してから**実装する。不変条件 INV-18〜24（data-model §4）は fast-check のプロパティテストで検証する（`fc.assert(fc.property(...))` を直接呼ぶ）。

**Organization**: ユーザーストーリーごとにまとめる。「テスト → 実装」の対は同じタスクの中に置き、1体の部下にまとめて渡す。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列にしてよい（別ファイルで、未完了のタスクに依存しない）。並列に実行する指示ではない（部下は1体ずつ順番に動かす）
- **[Story]**: 対応するユーザーストーリー（US1〜US7）
- 参照: `R` は research.md、`INV` と `§` は data-model.md、`D:` は contracts/domain-module.md、`H:` は contracts/http-api.md

## 全タスク共通のルール

- 001・002 の tasks.md の「全タスク共通のルール」をすべて引き継ぐ（依存の向き、整数の金額、`IdGenerator`・`Clock`、テストの一時ファイルは `.tmp/` と `useTempDataDir`、Conventional Commits）
- 相対 import には `.ts` を付ける。enum・parameter properties・namespace は使わない。型だけの import は `import type`
- **実データ（`work/`、`data/`）をテスト・フィクスチャ・文書・コミットに含めない。実データの金額・取引先名・按分率を、コード・コメント・文書・tasks.md に書かない**。実データを読むのは `scripts/verify-tax-return.ts` と `scripts/verify-freee-import.ts` の実行だけ（メインが行う）
- 割合は万分率の整数（0〜10000）。事業分 = `Math.floor(amount * ratio / 10000)`（R5）。浮動小数点で金額を計算しない
- 科目は初期セットのコードで識別する（`packages/domain/src/seed/accounts.individual.ts`）: 現金 `1010`、普通預金 `1020`、売掛金 `1030`、前払金 `1040`、仮払金 `1050`、工具器具備品 `1060`、一括償却資産 `1070`、開業費 `1080`、事業主貸 `3090`、借入金 `2010`、未払金 `2020`、未払費用 `2030`、前受金 `2040`、預り金 `2050`、事業主借 `3010`、元入金 `3020`、売上高 `4010`（欄1）、雑収入 `4020`（欄1）、減価償却費 `5180`（欄18）、地代家賃 `5230`（欄23）、任意科目 `5250〜5290`（欄25〜29）、雑費 `5310`（欄31）
- 決算整理の仕訳は 001 の `createJournal(deps: JournalDeps, draft: JournalDraft): Result<CreatedJournal>`（`packages/domain/src/usecases/create-journal.ts:95`）で登録する。`journals.source` と `audit_log` の CHECK は変えない（R4, R12）
- web のテストは Testing Library ＋ jsdom（`apps/web/test/render-route.tsx`、`apps/web/test/mock-api.ts`、置き場所は `apps/web/test/routes/`）。ルートを足したら `pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成してから typecheck する
- マイグレーションは `drizzle-kit generate` の後に `0003_tax_return.sql` の `);` を `) STRICT;` に置き換え、投入とトリガーは `--custom` の SQL で足す（AGENTS.md）
- 依存（npm パッケージ）は追加しない
- エラーコード・警告のコード・共有の型を変えるタスクでは、**同じ値を参照するテストと実装を `grep -rn <値> packages apps scripts` で探し、担当外のプロジェクトも含めて直す**
- 部下は担当のプロジェクトのテストだけを実行する（`pnpm vitest run --project <name>`）。整形は触ったファイルだけに掛ける

---

## Phase 1: Setup（様式の確認、実データの規則、照合スクリプトの骨組み）

**Purpose**: 様式の値を原本で確かめ（R2 のゲート）、実データでの照合の入口を作る。**T002 が済むまで US1 以降に着手しない**（US1・US4・US5 が様式の値を使う）

- [X] T001 `packages/domain/src/blue-return/form.ts` に `BLUE_RETURN_FORMS` と `formForYear(year: number): BlueReturnForm` を定義する（R2、data-model §2 の `BlueReturnForm`）。1ページ: 欄1〜45 の番号と欄名（R2 の一覧）、`kind`（欄8〜24・31 は `account`、25〜30 は `optional`、32・33・43・44・45 は `computed`、2〜7・34〜42 は `unused`）。`salesPartnerRows` と4ページの空欄の行の数は仮の値を入れ `// 要確認: T002` を付ける。貸借対照表の行と科目コードの対応は R2 の「貸借対照表の行と初期セットの科目」のとおり（様式に行のない `1050`・`1070`・`1080`・`2030` は空欄の行に科目名つき）。`formForYear` は、その年度以前で最も新しい様式、なければ最も古い様式を返す（R2）。テスト `packages/domain/test/blue-return/form.test.ts`: 欄番号の重複なし、任意欄が 25〜30 の6欄、初期セットの全科目（`reportLine` のある PL の科目と、資産・負債・純資産の全科目）が様式のどこかに対応する、`formForYear(2024)` と `formForYear(2030)` が令和7年分を返す
- [X] T002 **（メイン・利用者）** T001 の値を国税庁の令和7年分の青色申告決算書（一般用）の原本（https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/10.pdf）と照らし、(1) 売上先の明細の行数、(2) 2ページの控除の計算欄の欄番号と意味、(3) 4ページの行と空欄の行の数、(4) 特殊事情の欄のページを確定する。直した値で `form.ts` の `要確認` を外す
- [X] T003 実データの照合の入口を作る（R12b, R15）: (1) `AGENTS.md` の「実データを読むのは `verify-freee-import.ts` だけ」を「`verify-freee-import.ts` と `verify-tax-return.ts` だけ」に直す。(2) `scripts/verify-freee-import.ts` の取込・期首残高の保存・`--keep`・`--continue`・対応表の処理を、引数の解析と `process.exit` を含まない関数として `scripts/lib/freee-import-runner.ts` に切り出し、`verify-freee-import.ts` はそれを呼ぶだけにする（引数と出力は変えない。切り出しの前後で `--help` と、フィクスチャ `packages/domain/test/fixtures/freee/` での実行の出力が同じことを確かめる）。(3) `scripts/verify-tax-return.ts` を作り、`freee-import-runner.ts` を使い、引数 `--closing <work/の JSON>` を受け取る。JSON の形（`homeUse: { accountCode, ratio, basis }[]`、`assets: { name, acquiredOn, cost, ratio, linkedJournalNo? }[]`、`deductionAnswers`、`expected: { page: number, no: number | string, amount: number }[]`）を先頭のコメントに書く（値は書かない）。この段階では JSON の読込と検証だけを実装し、決算書との照合は T036 で足す。`package.json` に `"verify:tax-return": "node scripts/verify-tax-return.ts"`。`pnpm typecheck` を通す

---

## Phase 2: Foundational（全ストーリーの前提）

**Purpose**: スキーマ、表、ポート、税制の値、テストのジェネレーター

- [X] T004 `packages/schema/src/blue-return.ts` に Zod スキーマを定義し `packages/schema/src/index.ts` から export する（H: の入出力、data-model §1・§2）: `BlueReturn`（`formYear` を含む）、`BlueReturnWarning`（コードは data-model §2 の14種）、`AdjustmentProposal`、`HomeUseAllocationInput`（`businessRatio` は「0〜10000 の整数」、`basis` は「空でない」）、`RentDetailInput`（`deductibleAmount` は「0 ≤ x ≤ annualRent」）、`FixedAssetInput`（`acquisitionCost` は「> 0」、`method` は `"small_asset_28_2"` のみ、`businessRatio` 0〜10000）、`DeductionAnswersInput`（5つの boolean）、`ClosingNoteKind`（`special_circumstances` / `opening_difference`）、`TaxReturnMemoInput`（`kind` は data-model §1.8 の11種、`other` のとき `label` 必須、`amount` は「≥ 0」、`filePath` は「`/` で始まる絶対パス」）、`FiledDocumentInput`（`kind` は `blue_return` / `tax_return` / `attachment` / `other`、`filePath` は「`/` で始まる絶対パス」）。`packages/schema/src/masters.ts` の `AccountPatch` に `reportLine: z.number().int().positive().nullable().optional()` を足し、refine の「変更する項目」に含める（R12a）。H: の新しいエラーコード12種を `packages/schema/src/errors.ts` の `ErrorCode` に足す。テスト `packages/schema/test/blue-return.test.ts` で境界値（割合 -1・10001、`deductibleAmount > annualRent`、`other` で `label` なし、相対パス `docs/a.pdf`）を拒否し、`packages/schema/test/entities-masters.test.ts` に `AccountPatch` の `reportLine` だけの変更が通ることを足す
- [X] T005 `packages/domain/src/types.ts` と `packages/domain/src/ports.ts` に型と `ClosingStore`・`ClosingUnitOfWork` を追加する（D: のポートの節をそのまま）。`packages/domain/test/fakes.ts` にメモリ上の `FakeClosingStore` と `FakeClosingUnitOfWork`（002 の `fake-import-unit-of-work` と同じ作り。例外で全部を戻す）を足し、`packages/domain/test/fake-closing-unit-of-work.test.ts` で「途中の例外で仕訳も参照も残らない」を確かめる
- [X] T006 `packages/domain/src/seed/tax-parameters.ts`（R3 の表の6行、出典 URL つき）と `packages/domain/src/blue-return/tax-parameters.ts` の `resolveTaxParameter(key, date, params): TaxParameter | undefined` を実装する（R3: 適用開始日が日付以前の最新の行を選ぶところは `packages/domain/src/tax-rates.ts:18` の `resolveTaxRate` と同じで、`resolveTaxRate` にない「`effectiveTo` が null または `date <= effectiveTo`」の条件を足す）。テスト `packages/domain/test/blue-return/tax-parameters.test.ts`: 2026-03-31 は 300,000、2026-04-01 は 400,000、2029-03-31 は 400,000、2029-04-01 は undefined、2006-03-31 は undefined、控除の3つの値
- [X] T007 `packages/db/src/schema/tenant.ts` に data-model §1.1〜1.10 の10表を追加し、`drizzle-kit generate` で `packages/db/drizzle/tenant/0003_tax_return.sql` を作って STRICT にする。CHECK は data-model の列挙と範囲をそのまま書く（`business_ratio` 0〜10000、`acquisition_cost > 0`、`kind`・`method`・`target_type`（`account_report_line` を含む）・`action` の列挙、`adjustment_journal_refs` の「`kind = home_use` なら `allocation_id` NOT NULL、`depreciation` なら `asset_id` NOT NULL」）。`home_use_allocations` の `sub_account_id IS NULL` の重複を防ぐ部分 UNIQUE インデックス。`--custom` の SQL で、`tax_parameters` に `seed/tax-parameters.ts` と同じ6行を投入し、`adjustment_journal_refs` の削除禁止、`closing_audit_log` の更新・削除禁止のトリガーを作る（`0001_integrity.sql` の書き方）。テスト `packages/db/test/closing-schema.test.ts`: 全表が STRICT、トリガーで削除・更新が失敗、投入値が `TAX_PARAMETERS` と一致、CHECK の違反が失敗
- [X] T008 `packages/db/src/closing-repository.ts` に `ClosingStore` と `ClosingUnitOfWork`（`journals`・`masters` の既存のリポジトリと同じ接続で1トランザクション。002 の `import-repository.ts` の `ImportUnitOfWork` と同じ作り）を実装し、`packages/db/src/index.ts` から export する。テスト `packages/db/test/closing-repository.test.ts`: 各メソッドの往復、`transaction` の中の例外で仕訳と `adjustment_journal_refs` が両方とも残らない
- [X] T009 [P] `packages/domain/test/blue-return-arbitraries.ts` に、001 の `packages/domain/test/arbitraries.ts`（`accountSetArb`、`amountArb`）を使って「個人の初期セットの科目、取引先、期首残高（貸借一致）、1年分の仕訳（売上・雑収入・経費・任意科目・事業主貸借を含む、取引先なしの売上を含む）」を作る `yearLedgerArb` と、按分の登録の `homeUseArb`（割合 0〜10000）を作る。`yearLedgerArb` は「事業用の口座を使う（普通預金で入出金）」と「使わない（事業主貸・事業主借で入出金）」の両方の形を生成する（FR-032）。`packages/domain/test/blue-return-arbitraries.test.ts` で、生成した仕訳がすべて `validateJournal` を通ること、両方の形が生成されることを確かめる

**Checkpoint**: `pnpm vitest run --project domain`、`--project db`、`--project schema` が通る

---

## Phase 3: User Story 1 - 損益計算書・控除・出力 (Priority: P1) 🎯 MVP

**Goal**: 決算書1ページと控除・所得金額を画面・CSV・印刷で示し、任意欄が足りないときに科目の欄を変えられる

**Independent Test**: 合成の年度で各欄、任意科目の科目名、経費計・差引金額・所得金額、控除額、CSV と画面の一致、回答前の空欄、欄の変更で警告が消えることを確かめる

- [X] T010 [US1] テスト先行で `packages/domain/src/blue-return/deduction.ts` を実装する（D: `blueDeductionCap`・`blueDeduction`、R9、INV-22）。テスト `packages/domain/test/blue-return/deduction.property.test.ts`: INV-22（`0 ≤ 控除額 ≤ 上限額`、`= min(上限額, max(0, 欄43))`）、回答の組み合わせ5ビットの全32通りで tier（正規の簿記・添付・期限内がすべて真で e-Tax か電子帳簿が真 → `max`、前の3つだけ → `standard`、それ以外 → `basic`）と `unmet`、回答なしは `undefined`
- [X] T011 [US1] テスト先行で `packages/domain/src/blue-return/build.ts` の `buildBlueReturn(input)` の1ページと控除の部分を実装する（D: `buildBlueReturn`、R1、INV-18）。001 の `buildProfitAndLoss`（`packages/domain/src/reports/profit-and-loss.ts:20`）で科目ごとの金額を求め、`formForYear` の欄に並べ、`formYear` を入れる。任意科目（`reportLine` 25〜30 の科目と、一般の欄に当たらない費用の科目）は欄25から科目名つきで詰め、6つを超えたら `OPTIONAL_LINES_OVERFLOW`。経費計・差引金額が PL の費用合計・利益と違えば `PL_MISMATCH`。控除の回答がなければ `DEDUCTION_ANSWERS_MISSING` で欄44・45 と `transfer` を `null`（spec US1 シナリオ9）。使わない欄は常に 0（空欄にするのは表示と CSV、R14）。テスト `packages/domain/test/blue-return/build-page1.test.ts`（固定の小さな帳簿で各欄、任意科目7つの警告、`unused` の欄は 0、回答なし）と `packages/domain/test/blue-return/build.property.test.ts`（`yearLedgerArb` で INV-18）
- [X] T012 [US1] テスト先行で `packages/domain/src/blue-return/csv.ts` の `blueReturnToCsv(blueReturn, { blankUnused })` を実装する（R14。001 の `encodeCsv`（`packages/domain/src/reports/csv.ts:37`）を使い、列は `ページ,欄番号,欄名,金額`）。テスト `packages/domain/test/blue-return/csv.test.ts`: CSV を `parseCsv`（`packages/domain/src/import/csv.ts`）で読み戻した金額が `blueReturn` と一致、`blankUnused` で `unused` の欄が空
- [X] T013 [US1] テスト先行で科目の欄番号の変更を実装する（R12a、FR-006）: `packages/domain/src/usecases/masters.ts` に `setAccountReportLine(deps, accountId, reportLine: number | null)`（`renameAccount`・`setAccountActive` と同じ形。費用の科目で、様式の費用の欄 8〜31 か `null` のときだけ許し、それ以外は `REPORT_LINE_INVALID`。変更は `ClosingStore.appendClosingAudit` に `account_report_line`・`update`・変更前後の欄番号）、`apps/server/src/routes/masters.ts:38` の `PATCH /accounts/:accountId` で `patch.reportLine !== undefined` のときに呼ぶ。`setAccountReportLine` の deps に `ClosingStore` を足すため、`apps/server/src/deps.ts` の組み立てを直す。テスト `packages/domain/test/masters-report-line.test.ts`（費用以外の科目・欄32 で拒否、履歴が残る）と `apps/server/test/masters.api.test.ts` に `reportLine` の変更を足す
- [X] T014 [US1] テスト先行で `packages/domain/src/usecases/blue-return.ts` に `getBlueReturn(deps, { fiscalYear })` と `saveDeductionAnswers(deps, { fiscalYear, answers })` を実装する（D: ユースケース）。法人なら `ENTITY_KIND_UNSUPPORTED`。年度がなければ 001 と同じ `NOT_FOUND`。回答の保存は `closing_audit_log` に `blue_deduction_answer` で残す。テスト `packages/domain/test/blue-return/usecase-page1.test.ts`（`FakeClosingStore` と 001 の fakes。T013 で欄を雑費に変えると `OPTIONAL_LINES_OVERFLOW` が消える: spec US1 シナリオ10）
- [X] T015 [US1] テスト先行で `apps/server/src/routes/blue-return.ts` に `GET /entities/:id/blue-return/:year`、`GET .../csv`（`?blankUnused=true`）、`GET/PUT .../deduction-answers` を実装し `apps/server/src/app.ts` に登録、`apps/server/src/deps.ts` に `ClosingStore` を組み立てる（H: 決算書、控除の回答）。テスト `apps/server/test/blue-return.api.test.ts`: 200 の形、CSV の `content-type` と `blankUnused`、法人で 422 `ENTITY_KIND_UNSUPPORTED`
- [X] T016 [US1] テスト先行で画面を作る: `apps/web/src/routes/e/$entityId/blue-return/index.tsx`（年度の一覧）、`apps/web/src/routes/e/$entityId/blue-return/$year/index.tsx`（先頭に第一表に転記する値（欄45・欄44）をほかの欄と区別して表示（FR-004）、1ページの表、使った様式の年分、「締め前（暫定）」、警告の一覧、「使わない欄を空欄で表示」の切り替え（保存しない。CSV のリンクにも `blankUnused` を渡す。FR-008）、CSV のダウンロード、「印刷」ボタン、回答前は欄44・45 に「要件の回答が必要」と回答の画面へのリンク、`OPTIONAL_LINES_OVERFLOW` から科目の画面へのリンク）、`apps/web/src/routes/e/$entityId/blue-return/$year/deduction.tsx`（要件の5つの質問、上限額と満たさない要件の表示）、`apps/web/src/features/blue-return/`（`FormPage1.tsx`、`WarningList.tsx`、`print.css`: A4 縦、ページごとの改ページ、ナビを隠す）。科目の画面（`apps/web/src/routes/e/$entityId/accounts.tsx`）の費用の科目に「決算書の欄」の選択（8〜31）を足す。ナビに「決算書」を足す。テスト `apps/web/test/routes/blue-return.test.tsx`（欄の表示、回答なしの表示、空欄の切り替え、警告、回答の保存）と `apps/web/test/routes/accounts.test.tsx` に欄の変更を足す

**Checkpoint**: 決算書の1ページと控除・所得金額が画面と CSV で出る（MVP）

---

## Phase 4: User Story 2 - 家事按分 (Priority: P1)

**Goal**: 按分の登録 → 振替の案 → 登録 → 決算書に反映、地代家賃の内訳

**Independent Test**: 合成の年度で按分の案の金額、登録後の欄23 と事業主貸、古い振替（多すぎ・足りない）の警告と案、内訳の不一致の警告を確かめる

- [X] T017 [US2] テスト先行で `packages/domain/src/blue-return/home-use.ts` の `computeHomeUse`・`validateHomeUseAllocation`・`proposeHomeUseAdjustment` を実装する（D:、R4〜R6、INV-20、INV-23）。帳簿の金額は対象の科目（補助科目）の年間の借方−貸方から、`adjustment_journal_refs` の `home_use` で結びついた有効な仕訳の行を除いた額。期待される家事分と登録済みの振替の合計の差額が正なら「事業主貸 `3090` / 対象の科目（差額）」、負なら逆向きの「対象の科目 / 事業主貸 `3090`（差額の絶対値）」の年度末日付の案（R6）。差額 0、帳簿の金額 ≤ 0（登録済みの振替もない）、割合 10000 は案なし（理由つき）。区分が費用でない科目は `HOME_USE_ACCOUNT_INVALID`、根拠が空なら `HOME_USE_BASIS_REQUIRED`、前の年度と割合が違い理由が空なら `HOME_USE_CHANGE_REASON_REQUIRED`。テスト `packages/domain/test/blue-return/home-use.property.test.ts`（INV-20: `0 ≤ 事業分 ≤ 金額`、`事業分 + 家事分 = 金額`、割合 0・10000 の端。INV-23: 案が `validateJournal` を通る。振替を登録した後に案を作り直すと差額 0）と `home-use.test.ts`（spec US2 の受け入れシナリオ1〜3・5 の数値: 1,200,000円 × 3000 → 事業分 360,000・家事分 840,000。費用の仕訳を取り消した後の逆向きの案）
- [X] T018 [US2] テスト先行で `buildBlueReturn` に按分の反映と地代家賃の内訳を足す（FR-016、FR-017）: 按分の登録ごとに `proposeHomeUseAdjustment` を呼び、案の差額が 0 でなければ `HOME_USE_ADJUSTMENT_STALE`（差額）を出す（差額の計算は T017 のものを使い、ここで二重に持たない）。2ページの `rentDetails`、必要経費算入額の合計 ≠ 欄23 なら `RENT_DETAILS_MISMATCH`。テスト `packages/domain/test/blue-return/build-home-use.test.ts`
- [X] T019 [US2] テスト先行で `packages/domain/src/usecases/blue-return.ts` に `saveHomeUseAllocation`、`saveRentDetails`、`getAdjustmentProposals`、`commitAdjustment` を実装する（D: ユースケース）。`commitAdjustment` は `ClosingUnitOfWork.transaction` の中で案を作り直し、`expected.amount` と違えば `ADJUSTMENT_CHANGED`（`details.proposal`）、案がなければ `ADJUSTMENT_NOT_NEEDED`、`createJournal` → `insertAdjustmentRef`。締め済みの年度は 001 の `PERIOD_CLOSED`。この関数は US3 の `depreciation` でも使うので、`kind` で案の作り方を切り替える形にする。テスト `packages/domain/test/blue-return/usecase-adjustment.test.ts`（締め済み、金額の変化、途中の失敗で何も残らない）と `packages/db/test/closing-adjustment.test.ts`（実 DB で仕訳と参照が1トランザクション）
- [X] T020 [US2] テスト先行で `apps/server/src/routes/blue-return.ts` に `GET/PUT .../home-use`、`GET/PUT .../rent-details`、`GET/POST .../adjustments` を足す（H: 案、按分・内訳）。テスト `apps/server/test/blue-return.home-use.api.test.ts`: 422 の3コード（`HOME_USE_ACCOUNT_INVALID`・`HOME_USE_BASIS_REQUIRED`・`HOME_USE_CHANGE_REASON_REQUIRED`）、409 `ADJUSTMENT_CHANGED`、`PERIOD_CLOSED`、201 の形
- [X] T021 [US2] テスト先行で `apps/web/src/routes/e/$entityId/blue-return/$year/home-use.tsx` と `apps/web/src/features/blue-return/`（`HomeUseForm.tsx`、`RentDetailsTable.tsx`、`AdjustmentPanel.tsx`: 帳簿の金額・割合・事業分・家事分・仕訳の案を見せ「仕訳を登録」）を作る。科目の選択は費用の科目だけ。割合は「%」で小数第2位まで入力し、万分率に変換する。割合 0% の保存の前に「全額が家事分になり、この科目は経費になりません」の確認のダイアログ（spec の Edge Cases）。決算書の画面から按分の画面へのリンク、古い振替の警告から案へのリンク。テスト `apps/web/test/routes/blue-return-home-use.test.tsx`（0% の確認、変換、案の登録）

**Checkpoint**: US1 と US2 で、自宅兼事務所の利用者の決算書の1・2ページが揃う

---

## Phase 5: User Story 3 - 少額減価償却資産 (Priority: P2)

**Goal**: 固定資産台帳、償却の案、3ページの表

**Independent Test**: 基準額・年間の上限の検査、償却の案、3ページの列、欄18との一致

- [X] T022 [US3] テスト先行で `packages/domain/src/blue-return/depreciation.ts` の `validateFixedAsset`、`depreciate`、`proposeDepreciationAdjustment` を実装する（D:、R7、INV-21、INV-23。方法は `small_asset_28_2` だけで、方法の表は作らない）。案は「減価償却費 `5180` / 資産の勘定（取得価額）」と、家事分があれば「事業主貸 `3090` / 減価償却費 `5180`（家事分）」。`linkedJournalId` があれば案なし。エラーは `ASSET_ACCOUNT_INVALID`（資産の勘定の区分が資産でない）、`SMALL_ASSET_OVER_THRESHOLD`（`details.threshold`、`effectiveFrom`）、`SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED`（`details.limit`、`total`）、`SMALL_ASSET_NOT_APPLICABLE`、`DEPRECIATION_METHOD_UNSUPPORTED`。テスト `packages/domain/test/blue-return/depreciation.property.test.ts`（INV-21、INV-23）と `depreciation.test.ts`（spec US3 のシナリオ1〜5、2026-03-31 取得の 350,000 は拒否・2026-04-01 取得は可）
- [X] T023 [US3] テスト先行で `buildBlueReturn` に3ページの減価償却費の計算を足す（FR-023）: その年度に取得した、または未償却残高のある、除却していない資産を並べ、必要経費算入額の合計 ≠ 欄18 なら `DEPRECIATION_MISMATCH`。`usecases/blue-return.ts` に `saveFixedAsset`・`disposeFixedAsset`（履歴 `fixed_asset`）と、`commitAdjustment` の `depreciation` の分岐を足す。テスト `packages/domain/test/blue-return/build-depreciation.test.ts`、`usecase-fixed-asset.test.ts`
- [X] T024 [US3] テスト先行で `apps/server/src/routes/fixed-assets.ts`（H: 固定資産台帳の4つ）を作り `app.ts` に登録する。テスト `apps/server/test/fixed-assets.api.test.ts`: 422 の5コード、除却、`?year=` の `depreciation`
- [X] T025 [US3] テスト先行で `apps/web/src/routes/e/$entityId/fixed-assets/index.tsx`（台帳の一覧、登録・編集・除却、償却の方法は「少額減価償却資産の特例（措置法28条の2）」だけ、資産の勘定は資産の科目だけ、既存の仕訳を結びつける選択）と決算書の3ページの表示（`FormPage3.tsx` の減価償却の部分）、償却の案を `AdjustmentPanel` に出す。ナビに「固定資産台帳」。テスト `apps/web/test/routes/fixed-assets.test.tsx`

---

## Phase 6: User Story 4 - 貸借対照表と元入金の繰越 (Priority: P2)

**Goal**: 4ページ、期首と前期末の食い違いの検知と説明、負の残高・繰延資産の知らせ

**Independent Test**: 合成の2年度で、正しい繰越と売掛金をずらした繰越の検査、貸借の一致、説明メモ、事業用口座あり・なしの両方の帳簿

- [X] T026 [US4] テスト先行で `packages/domain/src/blue-return/opening-check.ts` の `checkOpeningCarryForward(priorClosing, opening, accounts)` を実装する（D:、R8）。002 の `carryForward`（`packages/domain/src/carry-forward.ts:21`）で前の年度の期末から期首の値を求め、科目（補助科目）ごとに登録された期首と比べる。002 の `packages/domain/test/carry-forward.property.test.ts:24` の `balancedClosingArb` は export されていないので、`packages/domain/test/arbitraries.ts` に移して export し、両方のテストから使う。テスト `packages/domain/test/blue-return/opening-check.property.test.ts`: `carryForward` の結果をそのまま期首にすれば差は0件、1科目をずらすとその科目と元入金だけに差が出る
- [X] T027 [US4] テスト先行で `buildBlueReturn` に4ページを足す（FR-028〜032、INV-19、R8）: 期首（期首残高）と期末（`buildBalanceSheet`、`packages/domain/src/reports/balance-sheet.ts:28`）を `form.ts` の行にまとめる。控除前の所得は期首を空欄。事業主貸・事業主借は期首残高が 0 なら空欄、0 でなければ金額を表示して `OPENING_OWNER_ACCOUNTS`。期末の資本の部に欄43。期首・期末とも、表示した金額で資産合計 = 負債・資本合計を確かめる。前の年度があれば `checkOpeningCarryForward` で `OPENING_MISMATCH`（科目、期待値、実際、差額）、前の年度が締め前なら `PRIOR_PERIOD_OPEN`、`detectWarnings`（`packages/domain/src/reports/warnings.ts:19`）の `NEGATIVE_BALANCE`、開業費 `1080` の残高が期首 = 期末 ≠ 0 なら `DEFERRED_ASSET_NOT_AMORTIZED`、`opening_difference` のメモを警告に添える。`getBlueReturn` で前の年度の期末の残高を読む。`saveClosingNote` を足す（履歴 `closing_note`）。テスト `packages/domain/test/blue-return/build-page4.test.ts`（spec US4 のシナリオ1〜7、期首に事業主貸がある場合）と `build.property.test.ts` に INV-19 を足す（`yearLedgerArb` の事業用口座あり・なしの両方の形で: FR-032）
- [X] T028 [US4] テスト先行で `apps/server/src/routes/blue-return.ts` に `PUT .../notes/:kind` を足し、`apps/web/src/features/blue-return/FormPage4.tsx`（期首・期末の表、繰越の検査、差の説明の入力）を作る。テスト `apps/server/test/blue-return.notes.api.test.ts`、`apps/web/test/routes/blue-return-page4.test.tsx`

---

## Phase 7: User Story 5 - 月別売上と売上先 (Priority: P2)

**Goal**: 2ページの月別売上、3ページの売上先の明細、特殊事情のメモ

**Independent Test**: 合成の年度で月別の金額、上位と「上記以外」の集約、合計の一致の検査

- [X] T029 [US5] テスト先行で `packages/domain/src/blue-return/sales.ts` の `summarizeMonthlySales`・`summarizeSalesPartners` を実装し、`buildBlueReturn` の2・3ページと `SALES_TOTAL_MISMATCH`・`SALES_WITHOUT_PARTNER`・`DUPLICATE_PARTNER_NAME` を足す（D:、R10、INV-24）。売上高 `4010` と雑収入 `4020` を分けて月ごとに貸方−借方、売上先は `4010` の行を取引先ごとに降順（同額は名前の順）で `salesPartnerRows` 行まで、残り・取引先なし・雑収入を「上記以外の売上先の計」。特殊事情のメモ（`special_circumstances`）を T002 で確定したページに含める。テスト `packages/domain/test/blue-return/sales.property.test.ts`（INV-24）と `sales.test.ts`（spec US5 のシナリオ1〜4、借方の売上の差し引き）
- [X] T030 [US5] テスト先行で `apps/web/src/features/blue-return/FormPage2.tsx`（月別売上、地代家賃の内訳、控除の計算）と `FormPage3.tsx` の売上先の部分、特殊事情のメモの入力（`PUT .../notes/special_circumstances`）を作る。テスト `apps/web/test/routes/blue-return-page2-3.test.tsx`

---

## Phase 8: User Story 6 - 確定申告の控え (Priority: P3)

**Goal**: 事業所得以外の控えと提出書類の場所を年度ごとに記録

**Independent Test**: 登録・編集・削除・一覧、ファイルの有無の表示、決算書の値が変わらないこと

- [X] T031 [US6] テスト先行で `usecases/blue-return.ts` に `saveTaxReturnMemo`・`deleteTaxReturnMemo`・`saveFiledDocument`・`deleteFiledDocument` と一覧を足し（FR-033〜035）、`apps/server/src/routes/tax-return.ts`（H: 控え・書類の8つ。`fileExists` は `node:fs` の `existsSync`、R13）を作って `app.ts` に登録する。テスト `packages/domain/test/blue-return/usecase-tax-return.test.ts`（控えを足しても `getBlueReturn` の値が変わらない: FR-034）と `apps/server/test/tax-return.api.test.ts`（`useTempDataDir` の下に作ったファイルの絶対パスで `fileExists: true`、ないパスで `false`、相対パスで 400）
- [X] T032 [US6] テスト先行で `apps/web/src/routes/e/$entityId/tax-return/$year.tsx`（控えの表: 種類・金額・ファイルの場所・メモ・有無、書類の表: 種類・場所・提出日・メモ・有無）を作り、ナビに「申告の控え」を足す。テスト `apps/web/test/routes/tax-return.test.tsx`

---

## Phase 9: User Story 7 - 免税の期間の税区分の警告 (Priority: P3)

**Goal**: 取込のプレビューで免税の期間の `TAX_CATEGORY_SUSPICIOUS` を1件にまとめる

**Independent Test**: 免税・課税・年の途中で切り替わる事業体で、プレビューの警告の出方を比べる

- [X] T033 [US7] テスト先行で免税の期間の警告のまとめを、schema・domain・web を通して1つのタスクで実装する（R11、FR-037。コードを足すと `apps/web/src/features/imports/labels.ts:34` の `WARNING_LABELS: Record<ImportWarningCode, string>` が型エラーになるため、分けない）: (1) `packages/schema/src/import.ts` の `ImportWarningCode` に `TAX_CATEGORY_SUSPICIOUS_EXEMPT` を足す。(2) `packages/domain/src/import/freee/plan.ts` の `warningsOf`（:628、`TAX_CATEGORY_SUSPICIOUS` は :659〜672）で、仕訳の日付の消費税の設定（`resolveTaxSetting`、`packages/domain/src/tax-settings.ts:71`）が `exempt` のものを集め、`{ code: "TAX_CATEGORY_SUSPICIOUS_EXEMPT", details: { count, freeeJournalIds } }` の1件にまとめる。(3) `labels.ts` に「免税の期間のため税区分の警告を N 件まとめました」を足し、プレビューの警告の一覧で開くと freee の仕訳 ID の一覧が出るようにする。(4) `TAX_CATEGORY_SUSPICIOUS` を参照する既存のテストと期待値（`packages/schema/test/import.test.ts`、`packages/domain/test/import/freee-plan.test.ts`、`packages/domain/test/fixtures/freee/expected.ts`、`apps/web/test/routes/imports-new.test.tsx`）を、フィクスチャの事業体の消費税の設定に合わせて直す。テスト `packages/domain/test/import/plan-exempt.test.ts`（spec US7 のシナリオ1〜3）と `apps/web/test/routes/imports-new.test.tsx` にまとめた警告の表示を足す。schema・domain・web の3プロジェクトのテストを実行する

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T034 `scripts/bench-reports.ts` に、約500仕訳の帳簿での `getBlueReturn` の計測を足し、2秒以内を確かめる（SC-006）。結果の数値はコミットしない
- [X] T035 文書を更新する: `AGENTS.md`（決算書の置き場所 `packages/domain/src/blue-return/`、`verify:tax-return` のコマンド、税制の値の足し方: `seed/tax-parameters.ts` とマイグレーションの両方）、`README.md`（決算の手順）、`docs/adr/0005-closing-adjustments-as-journals.md`（按分・償却を決算整理の仕訳にする判断、R4。書式は `docs/adr/0001-sqlite-driver.md`）、`specs/001-ledger-core/spec.md` と `specs/002-freee-import/spec.md` の Assumptions の「認証とバックアップは 003」を「後の機能」に直す
- [X] T036 `scripts/verify-tax-return.ts` に照合を足す（R15、T003 の続き）: 取込の後、JSON の按分・資産（`linkedJournalNo` があれば結びつけ）・控除の回答を登録し、`getAdjustmentProposals` の案を登録し、`getBlueReturn` の各欄を `expected` と照合して「欄ごとの一致・不一致と件数」だけを出す。`--continue` で複数年度を取り込んだときは、**前の年度（2024年）の `getBlueReturn` も呼び**、各年度の警告のコード（`NEGATIVE_BALANCE`、`OPENING_MISMATCH`）と科目名だけを出す（金額は出さない）
- [ ] T037 **（メイン）** quickstart.md の §2 を `TREBUCHET_DATA_DIR=.tmp/quickstart-003` で手動確認し（implementer にブラウザの MCP の snapshot で行わせる）、画面の文言と件数・金額を quickstart.md に合わせる。手順2〜5（決算書を開く → 控除の回答 → 按分 → 資産 → 転記の値）にかかった時間を計り、30分以内であることを確かめる（SC-005）
- [ ] T038 **（メイン）** 実データで `pnpm verify:tax-return` を実行し、SC-001（2025年分の1〜4ページが R7 と一致）と SC-002（2024年 → 2025年の負の売掛金と期首の食い違いの検知）を確かめる。結果の数値はリポジトリに書かない。一致しなければ原因を調べて直す
- [ ] T039 **（メイン）** 全体の検証: `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @trebuchet/web build`、`pnpm --filter @trebuchet/web e2e`（既存の2本が壊れていないこと）

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup（T001〜T003）→ Foundational（T004〜T009）→ US1 → US2 → US3 → US4 → US5 → US6 → US7 → Polish
- **T002（様式の確認）は US1 の着手の前に済ませる**（US1 の1ページ、US4 の4ページ、US5 の売上先の行数が様式の値を使う）
- T003 は T036 の前提

### User Story Dependencies

- **US1**: Foundational の後。ほかのストーリーの前提（`buildBlueReturn`、画面）
- **US2**: US1 の後（`commitAdjustment` を US3 が使う）
- **US3**: US2 の後（`commitAdjustment`、`AdjustmentPanel`）
- **US4**: US1 の後。`build.ts` を US2・US3 と同じく触るので、順番に行う
- **US5**: US1 と T002 の後。`build.ts` を触るので順番に行う
- **US6**: Foundational の後。ほかと独立
- **US7**: 独立（002 の取込だけに触る）

### Within Each User Story

- テスト → ドメイン → ユースケース → リポジトリ → API → 画面
- テストが旧コードで落ちることを確かめてから実装する（部下が赤の確認を飛ばしたら、メインが `git stash` で確かめる）

### Parallel Opportunities

- T009 は T004〜T008 と別ファイル（[P]）。ただし実行は順番に行う

## Implementation Strategy

### MVP First（US1 だけ）

1. Setup と Foundational（T002 の様式の確認を含む）
2. US1（1ページ、控除、科目の欄の変更、CSV、印刷）
3. 合成の帳簿で欄45 を確かめる

### Incremental Delivery

1. US1 → US2（按分）で、自宅兼事務所の利用者の主な欄が揃う
2. US3（償却）・US4（貸借対照表）・US5（売上の明細）で4ページが揃う
3. US6・US7 は補助
4. フェーズの区切りごとにコミットし（メッセージにタスク ID）、`/usage` を控える

## Notes

- 部下への渡し方: 1体に「1つのユーザーストーリーのテストと実装」の関連するまとまりを渡す。割り当ては下の一覧に従う
- implementer-hard（Opus）に渡す: 誤ると帳簿が壊れる整合性の難所だけ
  - T017（按分の差額。登録済みの振替との逆向きの差額を含む。INV-20・23。符号と端数を誤ると事業分と家事分の合計が崩れる）
  - T019（仕訳の案の確定。1トランザクションでの再計算と照合、仕訳と参照の同時登録。片方だけ登録されると二重計上や欠落になる）
  - T026（期首と前期末の繰越の検査。繰越の食い違いを見逃すと期をまたいで残高が狂う）
  - T027（貸借対照表の貸借の一致 INV-19 と元入金。元入金の算出を誤ると貸借が合わなくなる）
- implementer に渡す: 上の4件と、メインが行う T002・T037・T038・T039 以外のすべて（T001、T003〜T016、T018、T020〜T025、T028〜T036）
- 迷ったら implementer に渡し、テストやレビューで落ちたときに implementer-hard に上げる
- 完了の [X] はメインがまとめて付ける
