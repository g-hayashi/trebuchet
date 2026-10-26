---

description: "Task list for 007-generic-statement-import"
---

# Tasks: 汎用の明細取込

**Input**: Design documents from `specs/007-generic-statement-import/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/http-api.md](./contracts/http-api.md), [quickstart.md](./quickstart.md)

**Tests**: 必須。Constitution V により、各タスクでテストを先に書き、**失敗することを確認してから**実装する。INV-48〜50（data-model §5）は fast-check の性質テストで書く（`fc.assert(fc.property(...))` を直接呼ぶ）。

**Organization**: ユーザーストーリーごと。「テスト → 実装」の対は同じタスクに置き、1 体の部下にまとめて渡す。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列にしてよい（別ファイルで、未完了のタスクに依存しない）。並列に実行する指示ではない
- **[Story]**: US1〜US4
- 参照: `R` は research.md、`INV` と `§` は data-model.md、`H:§` は contracts/http-api.md、`FR`・`SC` は spec.md。006 の番号は `006/R3` の形

## 全タスク共通のルール

- **[AGENTS.md](../../AGENTS.md) の「開発の進め方」「データと一時ファイル」「明細の取込と AI 仕訳（006）」に従う**。以下はこの機能に固有の規則
- **実データを使わない**。明細は合成のフィクスチャ（`packages/domain/test/fixtures/statements/`）。実在の店名・口座名・口座番号・個人名を書かない
- **値（日付・金額・内容）の読み取りはプログラムだけ**（FR-006）。AI の出力から値を作らない。金額は整数、`amount` は符号つき（入金が正）
- **列の案の AI は端末内だけ**（FR-018、INV-48）。外部の endpoint・`createAiSuggester` を列の案の経路に渡さない。テストは偽の `ColumnSuggestionProvider`（domain）と偽の `fetch`（server）。`fm` を呼ばない
- **互換の別名を残さない**（R13）。`PastedRow`・`MfmePaste`・`parseMfmePaste`・`MFME_COLUMNS`・`mfme_fetch`・`STATEMENT_PASTE_UNREADABLE` を消すときは `grep -rn <名前> packages apps scripts` で全プロジェクトを直す
- マイグレーション: `pnpm --filter @trebuchet/db exec drizzle-kit generate --name statement_sources --config drizzle.tenant.config.ts`（新しい表の `);` を `) STRICT;` に）、トリガーは `--custom --name statement_sources_integrity`

---

## Phase 1: Setup

- [X] T001 [P] 合成のフィクスチャ（R14）: `packages/domain/test/fixtures/statements/` に、MF ME の形のタブ区切り（`mfme-paste.txt`）、出金・入金 2 列で前置き 3 行（口座番号・期間は架空）の銀行の CSV（UTF-8 の元 `bank-two-columns.utf8.csv` から `iconv` で CP932 の `bank-two-columns.csv`）、正が出金のカードの CSV（`card-outflow-positive.csv`、引用の中のカンマと返金の負の値を含む）、和暦の CSV（`bank-wareki.csv`）、見出しなしの CSV（`no-header.csv`）、独自の見出しの CSV（`custom-header.csv`、US4 用）。`README.md`（作り方・匿名化・検算）と `expected.ts`（形ごとの件数・入金と出金の合計・正しい対応）。全項目をクォートし LF で終える。旧 `fixtures/mfme/` は T007 で消す

---

## Phase 2: Foundational（全ストーリーの前提）

- [X] T002 [P] スキーマ（data-model §3、H:§1）: `packages/schema/src/statements.ts` に `StatementColumnRole`・`StatementDelimiter`（`"\t" | "," | ";"`）・`StatementAmountSign`・`StatementColumnMapping`（refine:「`date`・`content` が必須。`amount` か、`outflow` と `inflow` の両方の、どちらか一方だけ」「`amount` があれば `amountSign` が必須」「同じ列の番号を 2 つの役割に使わない」「列の番号は 0〜49」）・`StatementTableLayout`・`StatementSource`・`StatementAccountSuggestion`・`StatementEncoding`・取込の `options`（H:§2.1〜2.3、§4.1。どれも任意の `encoding`）。`STATEMENT_ORIGINS = ["paste", "file"]`、preview の `unmappedAccounts` を `{ name, suggestion }[]` に、`StatementBatch.sourceName`。`ai.ts` に `AiColumnSuggestion`（R10。`confidence` 0〜100、`reason` 200 字以内）。`errors.ts` と `apps/server/src/errors.ts` に H:§1 のコードと HTTP。テストは `packages/schema/test/statements.test.ts`
- [X] T003 [P] 区切りつきの分割（R3）: `packages/domain/src/import/csv.ts` に `parseDelimited(text, delimiter)` と行の番号つきの `parseDelimitedLines`。`parseCsv` は `parseDelimited(text, ",")`。タブ・セミコロンでの引用・`""`・引用の中の改行のテストを `packages/domain/test/import/csv.test.ts` に足す（002 の既存のテストが通ること）
- [X] T004 DB（data-model §1・§2）: `packages/db/src/schema/tenant.ts` に `statement_sources`（`name` NOT NULL UNIQUE 1〜100 字、`fixed_account_name` NULL 可、`header_signature` NULL 可、`mapping_json` NOT NULL、`last_used_at`・`created_at`・`updated_at` NOT NULL）、`statement_batches` の origin の CHECK を `IN ('paste', 'file')`・`source_name TEXT NULL`。`STATEMENT_AUDIT_TARGETS` に `statement_source`、`STATEMENT_AUDIT_ACTIONS` に `delete`。`0009`（STRICT。生成した SQL に `statement_batches`・`statement_audit_log` の作り直しが出ているかを確かめ、出なければ data-model §2 の手順で手で書く）と `0010`（0008 の両方の表のトリガーを同じ本文で作り直す）。`statement-repository.ts` に `listStatementSources`・`upsertStatementSource`・`deleteStatementSource`、`insertStatementBatch` に `sourceName`。`ports.ts` の `StatementStore` と domain の偽物（`test/fakes/`）も。db のテスト: STRICT、作り直し後のトリガー（`statement_batches` の更新・削除の拒否、`statement_audit_log` の追記のみ）、`PRAGMA foreign_key_check`、取込元の CRUD。依存: T002

**Checkpoint**: 型・表・分割がそろう

---

## Phase 3: User Story 1 - どの銀行・カードの明細でも読み取って取り込む (Priority: P1) 🎯 MVP

**Goal**: 貼り付け・CSV を、列を選んで読み取り、006 の確認・取込へ渡す

**Independent Test**: T001 の各形で、確認画面の件数・入金と出金の合計が `expected.ts` と一致する（SC-001）

- [ ] T005 [US1] 列の辞書と値の読み取り（R4・R5・R6、INV-49）: `packages/domain/src/statements/columns.ts`（`COLUMN_ROLE_NAMES`、`suggestColumns(header)`。NFKC・空白・括弧書きを除いた完全一致、同じ役割は左の列だけ）と `statements/table.ts` の `parseStatementAmount`・`parseStatementDate`（R5・R6 の書き方をすべて）・`readStatementTable(text, mapping, { year, fixedAccountName? })`（出金・入金の 2 列の規則、読めない行の理由）。`packages/domain/test/statement-table-arbitraries.ts` の生成器で INV-49 と INV-50 の後半（固定の口座）を性質テストで。テストは `packages/domain/test/statements/{columns,table}.test.ts`。依存: T002・T003
- [ ] T006 [US1] 区切り文字と見出しの行の判定（R2）: `statements/table.ts` に `detectTableLayout(text, override?)`（候補・採点・同点の順・見出しの 2 段の規則・前置き・見本 10 行・`needsYear`・`suggestedColumns`）。T001 の各形で区切り・見出しの行・案を当てる例のテストと、内容に日付・金額に見える値を入れない生成器での性質テスト。上限（R12: 20,000 行・50 列）で `STATEMENT_TABLE_TOO_LARGE`。依存: T005
- [ ] T007 [US1] 置き換えと名前の見直し（R13）: `statements/paste.ts` と `test/statements/paste.test.ts`・`fixtures/mfme/` を削除し、`PastedRow` → `StatementRow`、`MfmePaste` → `StatementTable`、`STATEMENT_PASTE_UNREADABLE` → `STATEMENT_TABLE_UNREADABLE` を domain・db・server のコードとテスト（`statements-arbitraries.ts` の `formatMfmePaste`・`MFME_HEADER`・`mfmeDate` は T005 の生成器に置き換える）で直す。`grep -rn "mfme\|Mfme\|MFME" packages apps scripts` でコメントの機能名（`006-mfme-ai-journal`）以外が 0 件になること。domain・db のテストを通す。依存: T006
- [ ] T008 [US1] ユースケース（H:§2.1〜2.3）: `usecases/statements.ts` に `detectStatementLayout(deps, text, override?)`、`previewStatementImport`・`commitStatementImport` の入力を `{ text, origin, year, mapping, fixedAccountName?, sha256 }` に（mapping の列の番号が列数を超えれば `STATEMENT_MAPPING_INVALID`、INV-50 の前半: `accountName` の役割がなければ `fixedAccountName` が必須）。取込の回の `origin` は入力の値。domain のテスト（`test/statements/import*.test.ts` を直す）。依存: T007
- [ ] T009 [US1] server（R1・R11・R12、H:§2）: `apps/server/src/routes/statements.ts` の layout・preview・commit を multipart（`readUpload`、`file` と `options` の JSON）にし、`decodeText` で文字列に（`options.encoding` があればその文字コード。R1）、`inputSha256` は R11 の正規の JSON。`apps/server/test/statements*.test.ts` を直し、CP932 の CSV・`encoding` の指定・5 MB 超・壊れた `options` のテストを足す。web（T010）の列の画面に文字コードの選び直しを置く。`auth-coverage.test.ts` が新しいルートを検査すること。依存: T008
- [ ] T010 [US1] web（spec US1）: `features/statements/api.ts` を multipart に（002 の `features/imports/upload.ts` を使う）、`StatementInput.tsx`（`PasteImport.tsx` を置き換え。貼り付け・ファイル）、`ColumnMappingEditor.tsx`（見本の表、列ごとの役割、金額 1 列 / 2 列、符号の向き、区切り・見出しの行の選び直し、年は `needsYear` のときだけ、口座名の列がなければ口座を選ぶか名前を入れる）、`ImportWorkspace.tsx`（入力 → 列 → 確認 → 確定）。`labels.ts`（出所の表示）・`routes/e/$entityId/statements/{import,index}.tsx`・`lib/api-errors.ts` から MF ME の文言を消す。`apps/web/test/mock-api.ts` と `apps/web/test/routes/` のテスト。依存: T009
- [ ] T011 [US1] 性能と E2E: `scripts/bench-statements.ts` を 500 件の CSV の multipart（layout → preview → commit）に直す（SC-006: 5 秒以内）。`apps/web/e2e/statements.spec.ts` を T001 の銀行の CSV のファイルの取込に直す（ロールのロケーターは `exact: true`）。bench はサンドボックスで実行して結果を報告、E2E は書くだけ（実行は利用者の端末）。依存: T010

**Checkpoint**: 列を選べば、どの形の明細も 006 の流れで取り込める（MVP）

---

## Phase 4: User Story 2 - 列の対応を覚えて、2 回目から自動で当てはめる (Priority: P1)

**Goal**: 取込元ごとの対応の保存と自動の当てはめ

**Independent Test**: 一度取り込んだ形の翌月分で列の選択を経ずに確認画面、列を入れ替えた形で選び直し（SC-003）

- [ ] T012 [US2] domain（R7・R8、INV-50、INV-47 の拡張）: `statements/sources.ts`（`headerSignature`・`matchStatementSources`（0 件 / 1 件 / 2 件以上、`last_used_at` の新しい順）・`diffHeader`（足された列・なくなった列、名前の同じ列の役割の引き継ぎ）。当てはめでは見出しの行に今回の判定の行を使い、保存した `headerRow` を使わない（R8）。前置きの行数が違う翌月分でも当てはまるテスト）、`usecases/statement-sources.ts`（一覧・名前の変更（重複は `STATEMENT_SOURCE_NAME_TAKEN`）・削除。`auditEntry` で記録）。`detectStatementLayout` に `match` と `sourceId` の `headerDiff`、`commitStatementImport` に `saveSource`（同じ UnitOfWork で取込元を保存し `last_used_at` を更新、取込の回に `source_name`。取込が失敗すれば取込元も残らない性質テスト）。テストは `packages/domain/test/statements/sources.test.ts` ほか。依存: T008
- [ ] T013 [US2] server と web（H:§2.1・§2.3・§3）: `routes/statements.ts` に `GET/PATCH/DELETE /statement-sources`、layout の `sourceId`、commit の `saveSource`。web は `SourcePicker.tsx`（当てはまった取込元の表示、2 件以上から選ぶ、新しい取込元の名前（1 つの口座なら口座の名前が既定））、1 件が当てはまれば列の画面を飛ばす（確認画面から列を直せる）、見出しの違いの表示、`routes/e/$entityId/statements/settings.tsx` に取込元の一覧（名前の変更・削除）。server と web のテスト。E2E に「同じ形の 2 回目は列の画面が出ない」を足す。依存: T011・T012

**Checkpoint**: 2 回目からの取込は列の操作 0 回

---

## Phase 5: User Story 3 - 口座の対応を自動で推定する (Priority: P2)

**Goal**: 新しい口座に種類・科目（と手がかりのあるときの用途）の案を入れ、確定で保存する

**Independent Test**: 合成の口座名の一覧で、手がかりのある口座に案が入り、ない口座だけが未選択で残る（SC-004）

- [ ] T014 [US3] domain（R9）: `statements/account-inference.ts` に `ACCOUNT_CUES` と `inferStatementAccount(name, categoryMajors, accounts, subAccounts)`（コード 2020・1020・1010 の科目が有効なときだけ、2 つ以上の種類が当たれば推定しない、補助科目は名前の包含が 1 つだけのとき、用途の語）。preview の `unmappedAccounts` に `suggestion`、commit の入力に `accounts`（同じ UnitOfWork で `saveStatementAccount` と同じ検査をして保存し監査に残す。`accounts` にない未対応の口座は `STATEMENT_ACCOUNT_UNMAPPED`）。テストは `packages/domain/test/statements/account-inference.test.ts`（合成の口座名 20 件以上の一覧で、手がかりの語のある口座の 9 割以上に種類・科目の案が入ること。SC-004）と import のテスト（口座の保存と取込が全部か無か）。依存: T012
- [ ] T015 [US3] server と web: preview・commit の形のテスト（server）。web の `AccountMappingForm.tsx` を案の受け取りに（推定であることと手がかりの語を表示、用途の未選択は確定できない）、`ImportWorkspace.tsx` は口座ごとの PUT をやめ、commit の `accounts` で送る。web のテスト。E2E の口座の対応の手順を直す。依存: T013・T014

**Checkpoint**: 新しい口座は、多くの場合に用途を選ぶだけで取り込める

---

## Phase 6: User Story 4 - 端末内の AI が列の対応の案を出す (Priority: P3)

**Goal**: 見出しで決まらない表だけ、端末内の AI が列の案を出す

**Independent Test**: 独自の見出しの CSV で偽の AI の案が画面に入り、AI への入力は見出しと 5 行だけ、外部へは何も送られない（SC-005）

- [ ] T016 [US4] domain（R10、INV-48）: `statements/column-prompt.ts` に `COLUMN_PROMPT_ROWS = 5`・`buildColumnPrompt(layout)`・`parseColumnSuggestion(raw, columnCount)`（形・列の範囲・役割の重複・必須の役割を検査し、外れれば案なし）、`ports.ts` に `ColumnSuggestionProvider`、`usecases/statement-columns.ts` に `suggestStatementColumns`（辞書の案で必須がそろうか、保存した対応が当てはまれば呼ばない。使えない・時間切れ・形の誤りを `unavailable` の理由に）。INV-48 の性質テスト（前置きと 6 行目以降の値がプロンプトに現れない）。依存: T012
- [ ] T017 [US4] server と web（H:§4.1）: `apps/server/src/lib/ai-client.ts` の Chat Completions の呼び出しを `chatCompletion` に切り出し（006 の `createOpenAiProvider` のテストが通ること）、`createColumnProvider` は `ai-runtime` の端末内の endpoint だけを受け取る（20 秒、`COLUMN_TIMEOUT_MS`）。`POST /statements/imports/column-suggestion`。server のテスト: 外部の AI の設定とキーがあっても外部の URL へ要求が行かない、端末内が無効なら `disabled`。web: `ColumnMappingEditor.tsx` で必須がそろわないときだけ要求し、「AI の案」と表示（待たずに操作できる）。web のテスト。依存: T013・T016
- [ ] T018 [US4] 列の案の評価（R15、Constitution IV）: `packages/domain/test/fixtures/statements/column-evals.ts`（合成の見出しと先頭の行と正しい対応の組を 20 件以上。T001 の各形・独自の見出し・英語の見出し・見出しなし）、`usecases/statement-columns.ts` に `evaluateColumnSuggestions(cases, provider)`（必須の役割がすべて正しい割合・役割ごとの一致率・案なしの割合）と偽の provider での集計のテスト。`scripts/eval-column-suggestions.ts` と ルートの `package.json` の `eval:columns`（端末内の AI で実行し、件数と割合だけを `.tmp/eval-columns/` に日時つきの JSON で残し、前回と比べて表示）。CI では AI を呼ばない。依存: T017

**Checkpoint**: 全ストーリーがそろう

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T019 文書: `AGENTS.md` に「汎用の明細取込（007）」の節（層と場所の表、値の読み取りはプログラムだけ、列の案は端末内だけ、辞書・語の表の足し方、フィクスチャ、プロンプトなどを変えるときは `pnpm eval:columns` の前後を比べる）とコマンドの表に `pnpm eval:columns`と、006 の節の `paste.ts` の記述を直す。ADR `docs/adr/0010-generic-statement-import.md`（列の対応の保存と当てはめ、AI を列の案だけに使う理由）。`docs/requirements.md` の該当の要件の状態。006 の `spec.md` の FR-001（ファイルは対象外）に 007 で置き換えた注記
- [ ] T020 最終の全体検証（メイン）: `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @trebuchet/web build`、`pnpm bench:statements`。結果はファイルに書き出し、終了コードで確かめる
- [ ] T021 利用者の端末での確認（quickstart §2）: E2E（`pnpm --filter @trebuchet/web e2e`）と手順 1〜5。実データでの確認は件数と一致・不一致だけを記録し、値・口座名・摘要を書かない

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup（T001）と Foundational（T002〜T004）が先。T002・T003 は独立、T004 は T002 の後
- US1（T005〜T011）→ US2（T012・T013）→ US3（T014・T015）・US4（T016〜T018）→ Polish

### User Story Dependencies

- US2 は US1 の読み取りとユースケースの上に作る
- US3・US4 は US2 の後（commit の入力と layout の応答を同じ順に広げるため）。US3 と US4 は互いに依存しない

### Within Each User Story

- domain → server → web の順。各タスクはテストを先に書き、赤を確かめてから実装する

### Parallel Opportunities

- T001・T002・T003（別ファイル）。US3 の T014 と US4 の T016（どちらも T012 の後）。部下は 1 体ずつ順に動かす

---

## Implementation Strategy

### MVP First（Foundational ＋ US1）

1. T001〜T004 → 2. T005〜T011 → 3. 利用者の端末で T001 の CSV を取り込んで確かめる

### Incremental Delivery

- US1（どの明細も読める）→ US2（2 回目から自動）→ US3（口座の案）→ US4（AI の案）。ストーリーの区切りでコミットし、`/usage` を控える

## Notes

- 006 の T031（利用者の端末での確認）と T035（端末内の AI の速さ）は 006 の tasks.md に残っている。T017 の端末内の AI の実機の確認は T035 の結果に左右される
