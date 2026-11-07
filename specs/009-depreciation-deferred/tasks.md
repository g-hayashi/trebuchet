---

description: "Task list for 009-depreciation-deferred"
---

# Tasks: 定額法・一括償却資産・開業費の償却

**Input**: Design documents from `specs/009-depreciation-deferred/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: 必須。Constitution V（テストファースト）により、各タスクでテストを先に書き、**失敗することを確かめてから**実装する。不変条件 INV-55〜60（data-model §4）は fast-check の性質テストで検証する（`fc.assert(fc.property(...))` を直接呼ぶ）。

**Organization**: ユーザーストーリーごとにまとめる。「テスト → 実装」の対は同じタスクの中に置き、1 体の部下にまとめて渡す。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列にしてよい（別ファイルで、未完了のタスクに依存しない）。並列に実行する指示ではない（部下は 1 体ずつ順番に動かす）
- **[Story]**: 対応するユーザーストーリー（US1 定額法、US2 一括償却資産、US3 開業費）
- 参照: `R` は research.md、`INV` と `§` は data-model.md、`D:` は contracts/domain-module.md（§1 定数、§2 関数、§3 ユースケース、§4 ポート）、`H:` は contracts/http-api.md（§1 エラーコード、§2 台帳、§3 開業費、§4 案、§5 決算書、§6 schema の変更点）
- **`R17/T0xx`** は research.md R17 の、そのタスクのテストの観点と細部（タスクの行は 500 字程度までにするため、細部はそちらに置く）

## 全タスク共通のルール

- **[AGENTS.md](../../AGENTS.md) の「開発の進め方」「決算書（003）」「データと一時ファイル」に従う**（テスト先行、UnitOfWork、`dates.ts`、マイグレーションの STRICT と `--custom`、税制の値の足し方、エラーコードを変えるときの grep、web のテスト、部下のテストの範囲）
- この機能に固有: 償却率は千分率の整数（0.250 = 250）、割合は万分率の整数。償却費は `Math.ceil(cost * ratePermille * months / 12000)`（R3）、必要経費算入額は 003 の `computeHomeUse`（`Math.floor(amount * ratio / 10000)`）。浮動小数点で金額を計算しない
- 定額法・一括償却の各年度の額は資産の属性と税制の値から計算し、保存しない。登録済みかどうかは `adjustment_journal_refs` と仕訳の状態で判定する（R6、ADR 0012）。開業費だけは年度の決定を保存する（R5）
- 科目はコードで引く: 工具器具備品 `1060`、一括償却資産 `1070`、開業費 `1080`、事業主貸 `3090`、減価償却費 `5180`（欄 18）、固定資産除却損 `5300`（新規、`reportLine` 30。R9）
- 決算整理の仕訳の登録は 003 の `commitAdjustment`（`packages/domain/src/usecases/blue-return.ts`）を共有し、新しい確定の経路を作らない（R5・R7）
- 依存（npm パッケージ）は追加しない。実データ（`work/`・`data/`）は読まない（T028 のメインの実行だけ）

---

## Phase 1: Setup（税制の値の確認）

**Purpose**: 投入する税制の値が 2026 年分に効くことを確かめる。**T001 が済むまで T004・T006 に着手しない**

- [X] T001 **（メイン。researcher に調べさせてよい）** research R13 の「要確認」を確かめる: 2026 年分で一括償却資産の範囲・年数と開業費の 60 か月が変わっていないこと（点と出典は R17/T001）。変わっていれば R13 の表に適用終了日と新しい行を足し（既存の行は書き換えない）、T004・T006 の値を合わせる。結果と出典 URL を R13 に書き、「要確認」を外す

---

## Phase 2: Foundational（全ストーリーの前提）

**Purpose**: 共有の型・契約、税制の値、表とマイグレーション、ポートと実装、テストのジェネレーター

- [X] T002 `packages/schema/src/blue-return.ts` と `errors.ts` を H: §6（data-model §2.1）のとおりに変える。あわせて `apps/server/src/errors.ts` の `ERROR_STATUS` と `FormPage3.tsx` の `METHOD_LABELS` に新しい値を足し（型エラー防止だけ）、`DepreciationMethod`・`"straight_line"`・`DEPRECIATION_METHOD_UNSUPPORTED` などの参照を探して担当外のプロジェクトも直す。既存テストが不正な値として使う `"straight_line"` は列挙外の値（`"declining_balance"`）に差し替える（探し方と対象は R17/T002）。テスト `packages/schema/test/blue-return.test.ts`（観点は R17/T002）。domain 側の型エラーは T003 で直す
- [X] T003 `packages/domain/src/types.ts` と `ports.ts` に data-model §2.1 の型、`TaxParameterKey` の 4 key（§1.2）、`ClosingStore` の 6 メソッド（D: §4）を足し、`packages/domain/test/fakes/closing.ts` の `FakeClosingStore` にも同じメソッドを足す。`FixedAsset`・`AdjustmentRef` を作る箇所（テスト・db・server）に新しい項目（既定は null / 0）を足す。T002 の schema の変更で通らなくなった `build.ts`・`depreciation.ts`（`AdjustmentProposal`）とその呼び出し元は、少額の特例の既定値（`source: "fixed_asset"` など現行の意味の値）で型が通るところまで直し、`pnpm typecheck` を通す（値・探し方は R17/T003。動きの変更は T010〜T013）
- [X] T004 テスト先行で税制の値と科目の seed を足す（R2、R9、R13、D: §1・§2）: 新規 `seed/depreciation-rates.ts` の `STRAIGHT_LINE_RATES`（R2 の 49 行）、`seed/tax-parameters.ts` に R13 の 4 行（T001 の結果に合わせる）、`seed/accounts.individual.ts` に 5300 固定資産除却損（R9）、`blue-return/tax-parameters.ts` に `resolveStraightLineRate`。テスト `packages/domain/test/blue-return/tax-parameters.test.ts`。科目数・並びに依存するテストも直す（値・観点・探し方は R17/T004）
- [X] T005 テスト先行で表と CHECK を作る: `packages/db/test/closing-schema.test.ts`・`tenant-store.test.ts` に、新しい表と作り直す表が STRICT、data-model §1 の各 CHECK の違反が失敗するテストを先に書いて赤を確かめる（観点は R17/T005）。次に `packages/db/src/schema/tenant.ts` を data-model §1.1〜1.7 に合わせて変え（新規 3 表、`fixed_assets`・`adjustment_journal_refs` の列と CHECK、`tax_parameters` の key、`closing_audit_log` の `target_type`）、`drizzle-kit generate` で `packages/db/drizzle/tenant/0011_depreciation.sql` を作って手で直す（R14。手順は R17/T005）
- [X] T006 テスト先行で `packages/db/drizzle/tenant/0012_depreciation_integrity.sql` を書く（R14）: 先に `closing-schema.test.ts`・`tenant-store.test.ts` に、トリガーで更新・削除が失敗する、表の行が seed（`STRAIGHT_LINE_RATES`・`TAX_PARAMETERS`）と一致するテストを書いて赤を確かめる。次に `drizzle-kit generate --custom` で SQL を作り、償却率と税制の値の `INSERT`、消えたトリガーの作り直し、削除禁止を手で書く（コマンドと観点は R17/T006）
- [X] T007 テスト先行で `packages/db/src/closing-repository.ts` に D: §4 の 6 メソッドを実装し、既存の `listFixedAssets`・`upsertFixedAsset`・`listAdjustmentRefs`・`insertAdjustmentRef` を新しい列に合わせる。テスト `packages/db/test/closing-repository.test.ts`（観点は R17/T007）
- [X] T008 [P] `packages/domain/test/blue-return-arbitraries.ts` にジェネレーター `straightLineAssetArb`・`lumpSumAssetArb`・`deferredAssetArb`・`deferredDecisionsArb` を足す（R15。範囲は R17/T008。data-model §1.3〜1.5 の制約を満たす）。`packages/domain/test/blue-return-arbitraries.test.ts` で、生成した値が制約を満たすことを確かめる

**Checkpoint**: `pnpm vitest run --project schema`、`--project domain`、`--project db` が通る。`pnpm typecheck` が通る

---

## Phase 3: User Story 1 - 定額法 (Priority: P1) 🎯 MVP

**Goal**: 定額法の資産を登録し、年度ごとの償却（供用月からの月割り、最終年度の 1 円、前年までの累計、除却・売却）の案を登録し、3 ページと欄 18 に載せ、期首の帳簿残高と台帳を照合する

**Independent Test**: spec US1 のシナリオ 1〜7 と国税庁 No.2106 の例が 1 円も違わず、案を登録した年度で `DEPRECIATION_MISMATCH`・`ASSET_REGISTER_MISMATCH` が出ない

- [X] T009 [US1] テスト先行で新規 `packages/domain/src/blue-return/straight-line.ts` の `assetStartYear(asset)`、`serviceMonths(asset, fiscalYear)`、`straightLineYear(asset, fiscalYear, ratePermille)` を実装する（D: §2、R3、R8、data-model §2.2）。月の計算は `packages/domain/src/dates.ts` を使う。テスト `packages/domain/test/blue-return/straight-line.test.ts` と `straight-line.property.test.ts`（INV-55。観点は R17/T009）
- [X] T010 [US1] テスト先行で `packages/domain/src/blue-return/depreciation.ts` を方法で分ける（D: §2、R1、R11）: `validateFixedAsset`・`depreciate`・`isDepreciationRow` が `{ rates, taxParameters }` を受けて定額法を扱う。引数が変わるので呼び出し元（`build.ts`、`usecases/blue-return.ts`）を型が通るだけ直す（動きの変更は T013・T014。探し方は R17/T010）。テスト `packages/domain/test/blue-return/depreciation.test.ts`（観点は R17/T010）
- [X] T011 [US1] テスト先行で `proposeDepreciationAdjustment(asset, fiscalYear, accounts, params)` を定額法に広げる（D: §2、R8、data-model §2.3、INV-57）。`DISPOSAL_LOSS_ACCOUNT_CODE = "5300"`、除却の年度は廃棄・売却とも §2.3 の形の 1 つの案（摘要と `breakdown` は R17/T011）。除却損の科目がなければ `ACCOUNT_NOT_FOUND`（`details.code: "5300"`）。テスト `depreciation.test.ts`、`depreciation.property.test.ts`（観点は R17/T011）
- [X] T012 [US1] テスト先行で新規 `packages/domain/src/blue-return/asset-register.ts` の `checkAssetRegister` を、固定資産（定額法・一括償却・少額の特例）について実装する（D: §2、R10、data-model §2.2 の「台帳の期首」）。開業費の分は T019 で足す（引数は今は省略可にしておく）。テスト `packages/domain/test/blue-return/asset-register.test.ts`（観点は R17/T012）
- [X] T013 [US1] テスト先行で `buildBlueReturn`（`build.ts`）と `blueReturnToCsv`（`csv.ts`）を変える（D: §2、R10、R11）: 3 ページに定額法の行、計算できない資産は行に載せず `DEPRECIATION_PARAMETER_MISSING`、`checkAssetRegister` の警告、CSV に償却率・本年中の償却期間。欄 18 との照合は今のまま。テスト `packages/domain/test/blue-return/build-depreciation.test.ts`、`csv.test.ts`、`build.property.test.ts`（入力・列・観点は R17/T013）
- [X] T014 [US1] テスト先行で `packages/domain/src/usecases/blue-return.ts` を変える（D: §3、R12、INV-59、INV-60）: `inClosingTx` が `tx.ledger` も渡し（`ClosingTxDeps` の `ledger: Pick<LedgerRepository, "getJournal">`）、`listFixedAssets`・`saveFixedAsset`・`disposeFixedAsset`・`getAdjustmentProposals`・`getBlueReturn` を D: §3 のとおりに変える（締め済みの年度は案なし、FR-021）。あわせて `assessDepreciation`・`ProposalSources`（率・税制の値を足す）・`rebuildProposal`・`commitAdjustment` の償却の経路を、年度ごとの案と INV-60 の `ADJUSTMENT_NOT_NEEDED` に合わせる（内容とテストは R17/T014）
- [X] T015 [US1] テスト先行で `apps/server/src/routes/fixed-assets.ts` を H: §2 に合わせる（入力の新しい項目、`dispose` の `disposalKind`、409 の応答）。テスト `apps/server/test/fixed-assets.api.test.ts` と `blue-return.api.test.ts`（観点は R17/T015）
- [X] T016 [US1] テスト先行で画面を変える（ルートは足さない）: `apps/web/src/features/fixed-assets/` の `FixedAssetForm.tsx`・`DisposeDialog.tsx`・台帳の一覧、`features/blue-return/` の `FormPage3.tsx`・`AdjustmentPanel.tsx`・`WarningList.tsx`（内容は R17/T016）。呼び出しは `fixed-assets/api.ts`。資産の保存・除却・案の登録の後は、案・決算書の query を読み直す（`invalidateLedger`。確かめ方は R17/T016）。テスト `apps/web/test/routes/fixed-assets.test.tsx`、`blue-return-page2-3.test.tsx`。既存の web のテストが落ちないことを確かめる

**Checkpoint**: 定額法の資産で、登録 → 案 → 登録 → 3 ページ・欄 18・照合が通る（MVP）

---

## Phase 4: User Story 2 - 一括償却資産 (Priority: P2)

**Goal**: 10 万円以上 20 万円未満の資産を供用の年から 3 年度で均等に償却し、少額の特例の年間の上限から外す

**Independent Test**: spec US2 のシナリオ 1〜5（150,000 円の 3 年度、100,000 円の端数、250,000 円の拒否、除却後も継続、上限の集計から外れる）

- [X] T017 [US2] テスト先行で新規 `packages/domain/src/blue-return/lump-sum.ts` の `lumpSumYear` を実装し、`depreciation.ts` の `validateFixedAsset`・`depreciate`・`isDepreciationRow`・`proposeDepreciationAdjustment` に一括償却の分岐を足す（D: §2、R4、data-model §2.2。除却・売却でも除却損・振替を出さない）。テスト `packages/domain/test/blue-return/lump-sum.test.ts`、`lump-sum.property.test.ts`（INV-56）、`depreciation.test.ts`。あわせて API・画面・台帳と帳簿の一致（INV-59・60）のテストを足し、落ちたところだけ直す（観点は R17/T017）

**Checkpoint**: 定額法と一括償却の資産が混ざった年度で、欄 18 と照合の警告が出ない

---

## Phase 5: User Story 3 - 開業費 (Priority: P2)

**Goal**: 開業費を登録し、年度ごとに上限と目安を示し、利用者が決めた額（0 円を含む）で案を作って登録する

**Independent Test**: spec US3 のシナリオ 1〜5（目安 60,000・上限 255,000、全額で残高 0、上限超えの拒否、0 円の記録と知らせの抑止、照合の不一致）

- [X] T018 [US3] テスト先行で新規 `packages/domain/src/blue-return/deferred-asset.ts` の `validateDeferredAsset`、`deferredAmortizationYear`、`validateDeferredDecision`、`proposeDeferredAmortization`、`deferredRows` を実装する（D: §2、R5、data-model §2.2・§2.3）。月数・月の計算は `packages/domain/src/dates.ts`（`monthIndex`、`addMonths`）を使い、書き直さない。テスト `packages/domain/test/blue-return/deferred-asset.test.ts`、`deferred-asset.property.test.ts`（INV-58。観点は R17/T018）
- [X] T019 [US3] テスト先行で決算書に開業費を足す（D: §2、R10、R11、FR-015、FR-019）: `buildBlueReturn` の入力と 3 ページの `deferredRows`、`checkAssetRegister` の開業費の分、`balance-sheet.ts` の `DEFERRED_ASSET_NOT_AMORTIZED` の抑止（`buildPage4` に決定を渡す）。テスト `build-depreciation.test.ts`、`build-page4.test.ts`、`asset-register.test.ts`（入力・観点は R17/T019）
- [X] T020 [US3] テスト先行で新規 `packages/domain/src/usecases/deferred-assets.ts` に `listDeferredAssets`・`saveDeferredAsset`・`decideDeferredAmortization` を実装し、`usecases/blue-return.ts` の `getAdjustmentProposals`・`rebuildProposal`・`commitAdjustment`・`getBlueReturn` を開業費に広げる（D: §3、R5、R12）。保存・決定は 1 つの `ClosingUnitOfWork` で、`closing_audit_log`（data-model §1.7）に記録する。決定の検査の順は D: §3。`saveDeferredAsset` の更新は R12 の制限（409 `DEPRECIATION_JOURNAL_EXISTS`）を掛ける。広げる内容とテストは R17/T020
- [X] T021 [US3] テスト先行で新規 `apps/server/src/routes/deferred-assets.ts`（H: §3 の 4 つ。`validate("param", DeferredAmortizationParam)`、`respond(c, result, …)`）を作り `app.ts` に登録し、`deps.ts` の依存を使う（`apps/server/src/` の下）。テスト新規 `apps/server/test/deferred-assets.api.test.ts`（観点は R17/T021）。`apps/server/test/auth-coverage.test.ts`（INV-29）が新しいルートでも通ることを確かめる
- [X] T022 [US3] テスト先行で開業費の画面を作る（固定資産台帳の画面に置き、ルートは足さない）: 新規 `features/deferred-assets/`、固定資産台帳のルートの開業費の欄、`AdjustmentPanel.tsx` の開業費の内訳、`mock-api.ts` の既定の応答（ファイルと内容は R17/T022）。開業費の保存・決定・案の登録の後は、案・決算書の query を読み直す（`invalidateLedger` または該当の query key。確かめ方は R17/T016 と同じ）。テスト `apps/web/test/routes/fixed-assets.test.tsx`。既存の web のテストが落ちないことを確かめる

**Checkpoint**: 定額法・一括償却・開業費のある年度で、quickstart §2 の手順7 の状態（警告なし、欄 18 = 257,500）を domain のテストで再現できる

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T023 `scripts/bench-reports.ts` に、資産 50 件（定額法・一括償却・少額の特例を混ぜ、数年分の年度）と開業費 1 件の事業体での、決算書の画面が使う API（`GET /blue-return/:year`、`/adjustments`、`/fixed-assets?year=`、`/deferred-assets?year=`）の計測を足し、2 秒以内を確かめる（SC-005。資産・年度の範囲は R15 のジェネレーターに合わせる）。結果の数値はコミットしない
- [X] T024 `scripts/verify-tax-return.ts` の `--closing` の JSON の形を広げる（形は R17/T024。先頭のコメントに形だけを書き、値は書かない）。登録・決定・案の登録の後、`ASSET_REGISTER_MISMATCH`・`DEPRECIATION_MISMATCH`・`DEPRECIATION_PARAMETER_MISSING` の件数と欄 18 の一致・不一致だけを出す（金額・資産名は出さない）。合成のフィクスチャで動くことを確かめる
- [X] T025 文書を更新する: `AGENTS.md` に「定額法・一括償却資産・開業費（009）」の節、「決算書（003）」の節の少額の特例だけの記述の修正、「開発の進め方」の不変条件の索引の記述（INV-1〜50）を INV-1〜60 に直す（内容は R17/T025）、`docs/requirements.md` の FR-10 の状態（決算の残り）、`docs/adr/0005-closing-adjustments-as-journals.md` の「関連」に ADR 0012
- [X] T026 **（メイン）** 全体の検証: `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @trebuchet/web build`。落ちたら implementer に直させる
- [X] T027 **（利用者の端末）** `pnpm --filter @trebuchet/web e2e`（既存の E2E が壊れていないこと）と、quickstart §2 の手動確認（利用者が `TREBUCHET_DATA_DIR="$PWD/.tmp/quickstart-009" pnpm dev` を起動し、implementer にブラウザの MCP の snapshot で手順 1〜11 を確かめさせる）。画面の文言と金額を quickstart.md に合わせ、手順2〜7 の所要時間を計る（SC-004: 資産 1 件の登録から仕訳の登録まで 3 分以内）
- [X] T028 **（保留: 2026-11-02 利用者の判断。P3、手の空いたときに行う）** **（メイン）** 実データで `pnpm verify:tax-return` を実行し（quickstart §3。`work/` の JSON は利用者が T024 の形で用意する）、`ASSET_REGISTER_MISMATCH` と欄 18 の不一致が 0 件であることを確かめる。結果の数値・資産名はリポジトリに書かない。一致しなければ原因を調べて直す。**取り下げ（2026-11-07 利用者の判断）**: closing の JSON を作らない（手間に見合わない）。計算は合成データの自動テストで確かめてある。スクリプトは残す

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup（T001）→ Foundational（T002〜T008）→ US1（T009〜T016）→ US2（T017）→ US3（T018〜T022）→ Polish（T023〜T028）
- **T001 は T004・T006 の前**（投入する税制の値を決める）
- T002 → T003 → T004 → T005 → T006 → T007（型 → seed → 表 → 投入 → 実装）。T008 は T003 の後ならいつでも
- T024 は T028 の前
- T005・T006 は、それぞれのテスト（赤）→ 表・マイグレーションの順で 1 つのタスクの中で行う

### User Story Dependencies

- **US1**: Foundational の後。`depreciate` の分岐、`checkAssetRegister`、`build.ts`、変更の制限、台帳の画面を作り、US2・US3 が使う
- **US2**: US1 の後（`depreciation.ts` の分岐と台帳の画面に足す）
- **US3**: US1 の後（`checkAssetRegister`・`build.ts`・`commitAdjustment` に足す）。US2 とは独立だが、`build.ts`・`depreciation-ledger.property.test.ts` を触るので順番に行う

### Within Each User Story

- テスト → ドメインの純関数 → ユースケース → API → 画面
- テストが旧コードで落ちることを確かめてから実装する（部下が赤の確認を飛ばしたら、メインが `git stash` で確かめる）

### Parallel Opportunities

- T008 は T004〜T007 と別ファイル（[P]）。ただし実行は順番に行う

## Implementation Strategy

### MVP First（US1 だけ）

1. Setup と Foundational（T001 の税制の値の確認を含む）
2. US1（定額法の計算・案・除却・3 ページ・照合・変更の制限・画面）
3. 合成の資産で spec US1 のシナリオ 1〜7 を確かめる

### Incremental Delivery

1. US1 → US2（一括償却）→ US3（開業費）
2. フェーズの区切りごとにコミットし（メッセージにタスク ID）、`/usage` を控える

## Notes

- 部下への渡し方: 1 体に「1 つのタスク（テストと実装の対）」を渡す。同じファイルを触る隣り合ったタスク（T009・T010、T018・T019）と、同じ層の対（T015+T016、T021+T022）は 1 体にまとめて渡してよい
- implementer-hard（Opus）に渡す: 誤ると帳簿が壊れる整合性の難所だけ
  - T011（除却・売却の案の形。資産の勘定の貸方と家事分の振替を誤ると残高が残るか二重に消える。INV-57）
  - T014（変更の制限と年度ごとの案、INV-59・60 の性質テストの設計。登録済みの判定を誤ると二重計上や欠落になる）
  - T020（開業費の決定と確定の 1 トランザクション、有効な額の判定、INV-59・60 の拡張）
- **T012 は implementer から始める**（帳簿と台帳の照合。対象の勘定と飛ばす条件の判断が要ると報告されたときだけ implementer-hard に回す）
- implementer に渡す: 上の 3 件と、メイン・利用者が行う T001・T026・T027・T028 以外のすべて（T002〜T010、T012、T013、T015〜T019、T021〜T025）
- 迷ったら implementer に渡し、テストやレビューで落ちたときに implementer-hard に上げる
- 完了の [X] はメインがまとめて付ける
