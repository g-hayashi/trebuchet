---

description: "Task list for 002-freee-import"
---

# Tasks: freee からのデータ取込

**Input**: Design documents from `specs/002-freee-import/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: 必須。Constitution V（テストファースト）により、各ユーザーストーリーでテストを先に書き、**失敗することを確認してから**実装する。不変条件 INV-11〜17（data-model §4）はプロパティテストまたは統合テストで検証する。取込は匿名化したフィクスチャで元帳との突合までテストする。

**Organization**: ユーザーストーリーごとにまとめ、ストーリー単位で実装・検証できるようにする。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列に実行できる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US5）

## 全タスク共通のルール

- 001 の tasks.md の「全タスク共通のルール」をすべて引き継ぐ（パッケージ名、依存の向き、整数の金額、`IdGenerator`、テストの一時ファイルは `.tmp/`、Conventional Commits と Co-authored-by）
- 相対 import には `.ts` を付ける（web は bundler の書き方）。enum・parameter properties・namespace は使わない。任意プロパティは `?: T | undefined`
- **実データ（`work/`、`data/`）をテスト・フィクスチャ・文書・コミットに含めない。実データの金額・取引先・摘要を、コード・コメント・文書に書かない**。実データを読むのは `scripts/verify-freee-import.ts` の実行だけで、その出力もコミットしない
- 取込のロジックは `packages/domain/src/import/` の純関数に置く。`TextDecoder` は使ってよい。`node:crypto` によるハッシュはサーバーで計算する
- web のテストは Testing Library ＋ jsdom（`apps/web/test/render-route.tsx`、`apps/web/test/mock-api.ts`）。テストのためだけに node 用のロジックを切り出さない（利用者の指示）
- drizzle のマイグレーションは生成後に `sed -i '' 's/^);$/) STRICT;/'` で STRICT にする。`pnpm --filter @trebuchet/web build` で routeTree.gen.ts を再生成してから typecheck する
- 依存（npm パッケージ）は追加しない（plan の Technical Context）

---

## Phase 1: Setup（列名の確認とフィクスチャ）

**Purpose**: freee の書き出しの列名を実ファイルで確かめ（research R3 のゲート）、匿名化したフィクスチャを作る

- [X] T001 [P] CSV と文字コードのテストを `packages/domain/test/import/csv.property.test.ts` に書く: (1) INV-17 `parseCsv(toCsv(rows))` が `rows` と一致（001 の `packages/domain/src/reports/csv.ts` の `toCsv` を使い、BOM を除いて比べる。fast-check で `"`・`,`・`\n`・`\r\n`・全角文字を含むセル）、(2) LF と CRLF の両方の行末、(3) 引用内の改行、(4) `decodeText`: BOM 付き UTF-8 → `encoding: "utf-8"` で BOM を除く、UTF-8 として不正なバイト列 → `encoding: "shift_jis"`、(5) 2バイト目が `0x85` の CP932 の文字（バイト列 `0x83 0x85` など）を含む行が、改行で分割されない
- [X] T002 `packages/domain/src/import/csv.ts` に `decodeText(bytes: Uint8Array): { text: string; encoding: "utf-8" | "shift_jis" }`（`new TextDecoder("utf-8", { fatal: true })` を試し、例外なら `new TextDecoder("shift_jis")`）と `parseCsv(text: string): string[][]`（RFC 4180。末尾の空行は捨てる）を実装し、T001 を通す（research R1, R2）
- [X] T003 `packages/domain/src/import/freee/columns.ts` に、research R3 の「使う列」を定数で定義する: `JOURNAL_COLUMNS`（取引日、仕訳ID、仕訳番号、仕訳行番号、仕訳行数、決算整理仕訳、登録した方法、取引内容、借方／貸方の 勘定科目・補助科目名・金額・税区分・税金額・取引先名・メモ・備考）と `LEDGER_COLUMNS`（勘定科目、取引日、決算整理仕訳、相手勘定科目、仕訳番号、借方金額、貸方金額、残高）。列名は分析メモの表記を仮に使い、T005 で確定する。借方・貸方の列名は `{ debit: {...}, credit: {...} }` の形で持つ
- [X] T004 `scripts/verify-freee-import.ts` を作り、まず `--headers-only` モードを実装する: 引数 `--journal <path>`・`--ledger <path>` のファイルを `node:fs` で読み、`decodeText`・`parseCsv` でヘッダの行（先頭5行から探す）を見つけ、(1) 判定した文字コード、(2) `columns.ts` の列のうち見つからないもの、(3) メモの列の値に含まれる「英数字・かな・漢字以外の文字」の種類（区切り文字の候補。値そのものは出さない）を標準出力に出す。`scripts/tsconfig.json` の対象に含め、`pnpm typecheck` を通す
- [X] T005 T004 を `work/` の 2025年分の仕訳帳と総勘定元帳に対して実行し（出力はコミットしない）、見つからない列名を `columns.ts` で正しい表記に直す。わかったこと（列名の表記、メモタグの区切り文字）を `specs/002-freee-import/research.md` の R3・R4 に追記する（**列名と区切り文字だけ。値・金額は書かない**）。ヘッダの完全な一覧は T006 のフィクスチャで使うため、`.tmp/freee-headers.txt` に保存する（コミットしない）
- [X] T006 匿名化した合成のフィクスチャを `packages/domain/test/fixtures/freee/` に作る: `journal-2025.csv`（UTF-8、全項目クォート、LF、T005 で確認したヘッダの全列。使わない列は空）、`ledger-2025.utf8.csv`（元帳の元。1行目にタイトル、2行目にヘッダ）、`ledger-2025.csv`（`iconv -f UTF-8 -t CP932` で変換）、`journal-2025-v2.csv`（US5 用: v1 に2仕訳を追加、1仕訳の金額を変更、1仕訳を削除）、`README.md`（作り方、`iconv` の手順、匿名化の方針「実在の取引先・口座番号・金額を使わない」）。内容は次をすべて含み、仕訳帳と元帳が互いに整合するように作る: 2025-01-01 付の前年分の決算振替（事業主借→元入金、損益→元入金、元入金→事業主貸。`決算整理仕訳 = 1`、`登録した方法 = 決算`）、売掛金の入金で普通預金・支払手数料（源泉所得税）に分かれる3行以上の複合仕訳、カード（「〇〇カード」の勘定科目）での経費、片側が空の行を含む複合仕訳、全角の英数字・空白を含む科目名と摘要、費用の科目に「課税売上10%」が付いた仕訳、「事務用品費」と「消耗品費」の両方、「交際費」、2025-12-31 付の減価償却（`決算整理仕訳 = 1`）、元帳の売掛金のマイナスの開始残高。フィクスチャの期待値（件数、科目ごとの期首・借方・貸方・期末）を `packages/domain/test/fixtures/freee/expected.ts` に書く
- [X] T007 [P] ルートの `package.json` に `"bench:import": "node scripts/bench-import.ts"` と `"verify:freee": "node scripts/verify-freee-import.ts"` を追加する（スクリプトの本体は T069, T070）

**Checkpoint**: 列名が実ファイルと一致し、フィクスチャがそろった

---

## Phase 2: Foundational（すべてのストーリーの前提）

**Purpose**: スキーマ、ファイルの判別、DB のテーブル、ポート、アップロードの基盤

**⚠️ CRITICAL**: この Phase が終わるまで、ユーザーストーリーに着手しない

- [X] T008 [P] `packages/schema/src/import.ts` に Zod スキーマを定義し `packages/schema/src/index.ts` から export する: `ImportOptions`（`fiscalYears?: number[]`、`include?: string[]`、`exclude?: string[]`）、`ImportExpected`（`fileSha256`: 小文字16進64文字、`countNew`: 正の整数）、`AccountMapping`（`sourceName`、`accountId`、`subAccountId?`、`subAccountName?`。「`sub_account_id` と `sub_account_name` の両方が入ることはない」を refine で検証）、`TaxMapping`、`MappingRow`（`sourceName`、`status: "saved" | "proposed" | "unmapped"`、対応先）、`ImportPlanItem`、`ImportPreview`（contracts/http-api.md の要約どおり）、`ImportBatch`、`OpeningProposal`、`ReconciliationRow`、`VoidImportInput`（`reason`、`confirmCorrected?: boolean`）。判定と警告のコード（data-model §3）を `z.enum` で定義する。`packages/schema/src/errors.ts` に contracts/http-api.md の追加のエラーコード（`IMPORT_UNKNOWN_FORMAT`、`IMPORT_WRONG_KIND`、`IMPORT_FILE_CHANGED`、`IMPORT_PLAN_CHANGED`、`IMPORT_NOT_READY`、`IMPORT_BATCH_VOIDED`、`CORRECTED_JOURNALS`、`IMPORT_BATCH_NOT_FOUND`、`FILE_TOO_LARGE`）を加える
- [X] T009 [P] `packages/domain/test/import/freee-read.test.ts` に `readFreeeFile` のテストを書く: フィクスチャの仕訳帳 → `kind: "journal"`・`encoding: "utf-8"`、元帳（CP932、タイトル行あり）→ `kind: "ledger"`・`encoding: "shift_jis"`、ヘッダの列の順を入れ替えても同じ結果、必須の列がない CSV → `IMPORT_UNKNOWN_FORMAT` と `missingColumns`、空のファイル → `IMPORT_UNKNOWN_FORMAT`。`normalizeName` は NFKC と前後の空白の除去（`"ＪＡＬカード "` → `"JALカード"`）
- [X] T010 `packages/domain/src/import/freee/read.ts` に `readFreeeFile(bytes)` と `normalizeName(s)` を実装し、T009 を通す（research R1, R3）。行は `Record<string, string>`（列名 → 値）にする
- [X] T011 [P] `packages/domain/test/freee-arbitraries.ts` を作る: 001 の `packages/domain/test/arbitraries.ts` の考え方で、(1) 科目の集合（freee の名前と帳簿の科目の対応つき。カード・その他口座・損益を含む）、(2) 期首残高（振替前の前期繰越と、年初付の決算振替の3行。research R5 の関係を満たす）、(3) 貸借一致の仕訳の列（複合仕訳、片側が空の行を含む）を生成し、`toFreeeJournalCsv(model): Uint8Array`（UTF-8）と `toFreeeLedgerCsv(model): Uint8Array`（UTF-8。CP932 の分岐は T009 のフィクスチャで検証する）を返す。元帳の各科目の残高は生成した仕訳から計算する
- [X] T012 `packages/db/src/schema/tenant.ts` に data-model.md §2 の4テーブルを追加し、`journals.source` の列挙を `["manual", "import_freee"]` にする。制約は data-model のとおり: `import_batches.source` は「`freee_journal`」、`file_sha256` は「小文字16進64文字」、`count_new` は「>= 1」、`status` は「`active` \| `voided`」、「`voided` のとき `void_reason` は NOT NULL（CHECK）」、`import_journal_refs.journal_id` は「PK、FK → journals」、`snapshot_json`・`freee_date`・`freee_journal_id` は NOT NULL、部分一意インデックス「`UNIQUE (freee_journal_id) WHERE revoked_at IS NULL`」、`import_account_mappings` は「`sub_account_id` と `sub_account_name` の両方が入ることはない（CHECK）」、`import_tax_mappings.tax_category` は tax_categories.code への FK。`pnpm --filter @trebuchet/db exec drizzle-kit generate --name import` で `packages/db/drizzle/tenant/0002_import.sql` を生成し、STRICT に置き換える。同じファイルの末尾に手書きで、`import_batches` と `import_journal_refs` の `BEFORE DELETE` トリガー（`RAISE(ABORT, ...)`）と、`import_journal_refs` の `revoked_at` 以外の列の更新を拒否する `BEFORE UPDATE` トリガーを加える（001 の `0001_integrity.sql` と同じ書き方）
- [X] T013 [P] `packages/db/test/import-integrity.test.ts` を書く: 取込の回・参照の削除がトリガーで拒否される、参照の `revoked_at` 以外の更新が拒否される、取り消されていない参照で同じ `freee_journal_id` は2件入らないが、`revoked_at` を設定した後なら入る（INV-12）、`status = voided` で `void_reason` が NULL なら拒否、対応表で補助科目の ID と名前の両方は拒否、既存の 0000・0001 のマイグレーション済みの DB に 0002 が当たる
- [X] T014 `packages/domain/src/ports.ts` に contracts/domain-module.md の `ImportStore` と `ImportUnitOfWork` を追加し、`packages/domain/test/fakes.ts` にメモリ上の実装（`FakeImportUnitOfWork`。001 の fake のリポジトリを組み合わせ、例外で全体を元に戻す）を加える
- [X] T015 `packages/db/src/import-repository.ts` に `DrizzleImportStore` と `DrizzleImportUnitOfWork`（同じ接続の上に `DrizzleLedgerRepository`・`DrizzleMasterRepository`・`DrizzleImportStore` を作り、1つの `db.transaction` で渡す。research R10）を実装し、`packages/db/src/index.ts` から export する。`ImportStore` のメソッドはすべて実装する。統合テスト `packages/db/test/import-repository.test.ts`: トランザクションの中で補助科目・仕訳・参照を作ってから例外を投げると、どれも残らない。`activeRefsByFreeeIds`・`activeRefsInRange` は `revoked_at` のある参照を返さない
- [X] T016 `apps/server/src/routes/imports.ts` の土台を作り `apps/server/src/app.ts` の tenant のルートに加える: multipart の `file` を読み（`c.req.parseBody()`）、5 MB を超えたら 413 `FILE_TOO_LARGE`（`hono/body-limit`）、`node:crypto` の `createHash("sha256")` でハッシュを計算するヘルパーを `apps/server/src/lib/upload.ts` に置く。テスト `apps/server/test/imports.upload.api.test.ts`: 5 MB 超 → 413、`file` がない → 400 `VALIDATION`、freee 以外の CSV → 422 `IMPORT_UNKNOWN_FORMAT`（この時点ではプレビューのルートは `readFreeeFile` までを呼ぶ）
- [X] T017 [P] web の土台: 事業体のメニュー（`apps/web/src/routes/e/$entityId/route.tsx`）に「取込」（`/e/$entityId/imports`）を加え、`apps/web/src/features/imports/FilePicker.tsx`（ファイルの選択、選んだファイル名の表示）と、hc の `form` でファイルを送るヘルパー `apps/web/src/features/imports/upload.ts` を作る。`apps/web/test/mock-api.ts` を multipart の要求を受けられるように拡張する

**Checkpoint**: ファイルの判別、テーブル、ポート、アップロードの経路がそろった

---

## Phase 3: User Story 1 - freee の仕訳帳を取り込む (Priority: P1) 🎯 MVP

**Goal**: 仕訳帳を選んでプレビューを見て、対応表を確定し、すべての仕訳を1回の操作で登録する

**Independent Test**: フィクスチャの仕訳帳を取り込み、仕訳帳と試算表の件数・金額が `expected.ts` と一致し、同じファイルの2回目は0件になる

### Tests for User Story 1 ⚠️

> **NOTE: テストを先に書き、失敗することを確認してから実装する**

- [X] T018 [P] [US1] `packages/domain/test/import/freee-group.test.ts`: `groupFreeeJournals` がフィクスチャを `仕訳ID` でまとめ、`仕訳行番号` の順に並べ、各行の借方 → 貸方の順に仕訳行を作る。勘定科目が空の側は行にしない。行数が `仕訳行数` と違う → `LINE_COUNT_MISMATCH`。金額が空・小数・マイナス → `INVALID_AMOUNT`。摘要（取引内容）は元の文字のまま、科目名などの名前は NFKC 済み。備考は重複を除いて改行でつなぎ `memo` に入れる。メモタグは T005 で確認した区切り文字で分ける
- [X] T019 [P] [US1] `packages/domain/test/import/freee-closing.test.ts`: `isPriorYearClosing` は「`決算整理仕訳 = 1` かつ 日付が会計期間の開始日」のときだけ true（12-31 付の減価償却は false、開始日付でも `決算整理仕訳 = 0` なら false）
- [X] T020 [P] [US1] `packages/domain/test/import/freee-mapping.test.ts`: `proposeMappings` の優先順位: 保存済み > 帳簿の科目と同名 > 言い換え（交際費 → 5140、その他口座 → 1020、事務用品費 → 5170）> 「カード」で終わる名前 → 2020 ＋同名の補助科目（既存ならその ID、なければ `subAccountName`）> 未定。「損益」は常に未定で、対応づけの候補を出さない。使用停止の科目は案に出さない。税区分の初期案は research R13 の5つ（全角・半角の違いは NFKC で吸収）、それ以外は未定。freee の補助科目名が科目名と違うときは、対応先の科目の同名の補助科目に対応させる
- [X] T021 [P] [US1] `packages/domain/test/import/freee-plan.property.test.ts`（T011 の arbitraries を使う）: (1) INV-13 `new` の仕訳はすべて 001 の `validateJournal` を通る、(2) `new + already + excluded + rejected` = ファイルの仕訳の数、(3) `totals.debit = totals.credit`、(4) 既存の参照（取り消されていない）がある仕訳はすべて `already`、(5) `fiscalYears` で選ばなかった年度の仕訳はすべて `YEAR_NOT_SELECTED`、(6) `planImport` は入力を変えない（純関数）
- [X] T022 [P] [US1] `packages/domain/test/import/freee-plan.test.ts`: 取込不可のコード（`UNBALANCED`、`INVALID_AMOUNT`、`MISSING_FIELD`、`LINE_COUNT_MISMATCH`、`OUT_OF_PERIOD`（最初の会計期間より前と、最後より後で案内が違う, research R19）、`PERIOD_CLOSED`、`UNMAPPED`、`ACCOUNT_INACTIVE`）、取込対象外（`PRIOR_YEAR_CLOSING` が既定、`include` で対象に戻すと損益のため `UNMAPPED`、`USER_EXCLUDED`）、警告（`TAX_AMOUNT_MISMATCH`：freee の税金額と INV-10 の計算が違う、`TAX_CATEGORY_SUSPICIOUS`：費用に売上の税区分・収益に仕入の税区分、`POSSIBLE_DUPLICATE`：同じ日付で行の組が同じ手入力の有効な仕訳がある）、保存する税額は INV-10 で計算し直した値、`toCreate` に新しい補助科目・取引先・タグが重複なく並ぶ、未定の対応があるか `new` が0件なら `ready = false`。`canonicalSnapshot` は行の順・キーの順が決まった JSON で、同じ内容なら同じ文字列
- [X] T023 [P] [US1] `packages/domain/test/import/import-freee.commit.test.ts`（`FakeImportUnitOfWork`）: `previewFreeeImport` は何も書かない。`commitFreeeImport` は、ハッシュの不一致 → `IMPORT_FILE_CHANGED`、作り直した `countNew` の不一致 → `IMPORT_PLAN_CHANGED`（`details.preview` つき）、`ready = false` → `IMPORT_NOT_READY`。成功時: 補助科目・取引先・タグを作ってから仕訳を登録し、仕訳番号は既存の最大の次から「日付 → freee の仕訳番号 → 仕訳ID」の順（research R15）、仕訳の `source = "import_freee"`、仕訳ごとに監査ログ `action = create`（`after_json` に `source`・`importBatchId`・`freeeJournalId`）、参照に `snapshot_json`、取込の回に件数・ハッシュ・ファイル名・期間・年度
- [X] T024 [P] [US1] `packages/db/test/import-commit.test.ts`（テンポラリの SQLite、`packages/db/src/testing.ts` の作り方）: (1) INV-11 仕訳の登録の N 件目で例外を注入すると、仕訳・行・補助科目・取引先・タグ・取込の回・参照・監査ログの件数が取込の前と同じ（SC-006）、(2) INV-12 / SC-005 フィクスチャを2回取り込むと、2回目は `new = 0` で、仕訳の件数と試算表が1回目と同じ、(3) フィクスチャの取込後の試算表が `expected.ts` と一致
- [X] T025 [P] [US1] `apps/server/test/imports.api.test.ts`: `POST /imports/freee/preview`（200、帳簿は変わらない、`options` の JSON の不正 → 400）、`POST /imports/freee/commit`（201 `{ batch, preview }`、409 `IMPORT_FILE_CHANGED`、409 `IMPORT_PLAN_CHANGED`、422 `IMPORT_NOT_READY` と `details.unmapped`）、`GET /imports`（新しい順）、`GET /imports/:batchId`（404 `IMPORT_BATCH_NOT_FOUND`）、`GET/PUT /import-mappings`（使用停止の科目・他の科目の補助科目 → 422 `VALIDATION`、指定した行だけを追加・更新）、仕訳帳の代わりに元帳 → 422 `IMPORT_WRONG_KIND`
- [X] T026 [P] [US1] `apps/web/test/routes/imports-new.test.tsx`: ファイルを選ぶとプレビュー（件数・期間・借方と貸方の合計・年度ごとの件数）が表示される、未定の対応があると「取り込む」が押せず未定の行が目立つ、対応を選んで「対応表を保存」するとプレビューを作り直す、新しい科目を作るダイアログ（名称・区分・決算書の欄）で科目を作って選べる、年度のチェックを外すと件数が変わる、取込対象外の仕訳を個別に含められる、「取り込む」→「N件の仕訳を取り込みました」と取込の詳細へのリンク、すべて取込済みなら「取り込む」が押せない。`apps/web/test/routes/imports-index.test.tsx`: 取込の履歴（日時・ファイル名・件数・状態）

### Implementation for User Story 1

- [X] T027 [P] [US1] `packages/domain/src/import/freee/closing.ts` に `isPriorYearClosing(journal, periods)` を実装し T019 を通す（research R5）
- [X] T028 [US1] `packages/domain/src/import/freee/read.ts` に `groupFreeeJournals(file)` と型 `FreeeJournal` を実装し T018 を通す（research R4）
- [X] T029 [P] [US1] `packages/domain/src/seed/freee-aliases.ts`（科目の言い換え、カードの規則、税区分の初期案。科目は seed のコードで指す）と `packages/domain/src/import/freee/mapping.ts` の `proposeMappings` を実装し T020 を通す（research R13）
- [X] T030 [US1] `packages/domain/src/import/freee/plan.ts` に `planImport(input)` と `canonicalSnapshot(journal)` を実装し T021・T022 を通す。新しく作る補助科目・取引先・タグは仮の ID で `JournalDraft` を組み立て、001 の `validateJournal` で検証する。税額は `computeInclusiveTax`・`resolveTaxRate` で計算し直す。US5 の `FREEE_CHANGED`・`FREEE_DELETED` はこのタスクでは作らない
- [X] T031 [US1] `packages/domain/src/usecases/import-freee.ts` に `previewFreeeImport`・`commitFreeeImport`・`saveImportMappings` を実装し T023 を通す。`commitFreeeImport` は `ImportUnitOfWork.transaction` の中でプレビューを作り直してから書く。仮の ID を本当の ID（`IdGenerator`）に置き換える。`packages/domain/src/index.ts` から export する
- [X] T032 [US1] T015 の `DrizzleImportStore` で T024 が通ることを確かめ、足りない問い合わせ（`manualJournalSignatures` など）を `packages/db/src/import-repository.ts` に加える
- [X] T033 [US1] `apps/server/src/routes/imports.ts` に preview・commit・`GET /imports`・`GET /imports/:batchId`・`GET/PUT /import-mappings` を実装し T025 を通す。ルートはユースケースを呼ぶだけ（ロジックを書かない）。`ImportUnitOfWork` は tenant ミドルウェアが開いた DB から作る
- [X] T034 [US1] web の画面を実装し T026 を通す: `apps/web/src/routes/e/$entityId/imports/index.tsx`（履歴）、`apps/web/src/routes/e/$entityId/imports/new.tsx`（ファイルの選択 → プレビュー → 確定）、`apps/web/src/features/imports/PreviewSummary.tsx`、`PlanItemsTable.tsx`（TanStack Table。判定で絞り込み、理由のコードを日本語で表示、対象外の個別の含める・外す）、`MappingEditor.tsx`（科目・補助科目・税区分の選択、新しい科目のダイアログは 001 の `POST /accounts` を使う）、`YearSelector.tsx`。`apps/web/src/routes/e/$entityId/imports/$batchId.tsx` は、この時点では取込の詳細（仕訳の一覧と仕訳へのリンク）だけ

**Checkpoint**: 仕訳帳の取込が単独で動く（MVP）

---

## Phase 4: User Story 2 - 期首残高を freee から移す (Priority: P1)

**Goal**: 総勘定元帳から期首残高の案を作り、001 の期首残高として保存する

**Independent Test**: フィクスチャの元帳の案が `expected.ts` の期首（決算振替を繰り込んだ値）と一致し、保存後の期首の貸借対照表に反映される

### Tests for User Story 2 ⚠️

- [X] T035 [P] [US2] `packages/domain/test/import/freee-ledger.test.ts`: `parseFreeeLedger` がフィクスチャの元帳（CP932）を科目ごとにまとめ、開始行（相手勘定科目が「前期繰越」または「開始残高」）の残高を符号つきで読み、取引の行（日付、決算整理仕訳、相手科目、仕訳番号、借方、貸方、残高）を並べる。タイトル行を読み飛ばす
- [X] T036 [P] [US2] `packages/domain/test/carry-forward.property.test.ts`: `carryForward(balances, accounts)` について、(1) 貸借が一致する期末残高から作った期首は貸借が一致する、(2) 収益・費用・事業主貸（3090）・事業主借（3010）は 0、(3) 元入金（3020）= 元入金 ＋ 所得 ＋ 事業主借 − 事業主貸、(4) 資産・負債の科目と補助科目の残高は変わらない
- [X] T037 [P] [US2] `packages/domain/test/import/freee-opening.test.ts` と `freee-opening.property.test.ts`: research R5 の合成の例（元入金 1,000 ほか）で案が 元入金 1,400・事業主借 0・事業主貸 0 になる、「損益」の行を捨てる、マイナスの残高は反対側にして `NEGATIVE_OPENING`、対応が未定の科目は `unmapped` に入り案に含めない、カードの科目は未払金の補助科目ごとの行になる、登録済みの期首残高との差を科目ごとに返す（FR-020）、前年度の残高を渡すと `carryForward` と違う科目に `OPENING_DIFFERS_FROM_CARRY_FORWARD`（FR-020a）。プロパティ: INV-16 T011 の arbitraries から作った元帳の案は貸借が一致し、arbitraries の振替後の期首と一致する
- [X] T038 [P] [US2] `apps/server/test/imports.opening.api.test.ts`: `POST /fiscal-periods/:year/opening-balances/freee-proposal` → 200 `{ proposal }`、帳簿は変わらない、仕訳帳を送る → 422 `IMPORT_WRONG_KIND`、会計期間がない年度 → 422 `OUT_OF_PERIOD`。案の行を 001 の `PUT .../opening-balances` に渡すと保存できる
- [X] T039 [P] [US2] `apps/web/test/routes/opening-balances-freee.test.tsx`: 期首残高の画面の「freee の元帳から読み込む」でファイルを選ぶと、案が行に入り、警告（マイナス、前年度の繰越との差）と登録済みとの差が表示される。未定の科目があると「保存する」が押せない。「保存する」で 001 の `PUT` が呼ばれる

### Implementation for User Story 2

- [X] T040 [US2] `packages/domain/src/import/freee/read.ts` に `parseFreeeLedger(file)` と型 `FreeeLedgerAccount` を実装し T035 を通す
- [X] T041 [P] [US2] `packages/domain/src/carry-forward.ts` に `carryForward` を実装し T036 を通す（research R6。科目は seed のコードで特定）
- [X] T042 [US2] `packages/domain/src/import/freee/opening.ts` に `proposeOpeningBalances(input)` を実装し T037 を通す。振替の判定は T027 の `isPriorYearClosing` と同じ条件を元帳の行に当てる（期首日 かつ 決算整理仕訳 = 1）。検証は 001 の `validateOpeningBalances`
- [X] T043 [US2] `packages/domain/src/usecases/import-freee.ts` に `proposeFreeeOpening` を加える（前年度の会計期間があれば、001 の `computeBalances` で前年度の期末を求めて渡す）
- [X] T044 [US2] `apps/server/src/routes/imports.ts` に期首残高の案のルートを加え T038 を通す
- [X] T045 [US2] `apps/web/src/routes/e/$entityId/periods/$year/opening-balances.tsx` に「freee の元帳から読み込む」を加え、`apps/web/src/features/imports/OpeningProposalPanel.tsx`（案・差・警告の表示、案を入力欄に反映）を作って T039 を通す

**Checkpoint**: US1 と US2 で、仕訳と期首残高がそろう

---

## Phase 5: User Story 3 - 取込の結果を元帳と照合する (Priority: P2)

**Goal**: 帳簿の科目ごとの期首・借方・貸方・期末を、元帳の値と並べて一致・不一致を示す

**Independent Test**: フィクスチャを取り込み、すべての科目が一致する。1仕訳を外すと、その科目が不一致になり、差額と原因の候補が出る

### Tests for User Story 3 ⚠️

- [X] T046 [P] [US3] `packages/domain/test/import/freee-reconcile.property.test.ts`: INV-14 T011 の arbitraries で、仕訳と期首残高を取り込んだ後の帳簿の残高（001 の `computeBalances`）と元帳を `reconcile` に渡すと全行が一致する。任意の1仕訳を帳簿から除くと、その仕訳の科目の行だけが不一致になり、差額がその仕訳の金額と一致する
- [X] T047 [P] [US3] `packages/domain/test/import/freee-reconcile.test.ts`: 元帳の側の期首は「開始行 ＋ 期首日付の決算振替」、借方・貸方の合計は振替の行を除く、期末は最後の行の残高（research R7）。freee の2つの科目（事務用品費と消耗品費）を帳簿の1つの科目にまとめた場合は合計で比べる。「損益」は比べない。カードの科目は未払金にまとめる。対応が未定の科目は `unmapped`。不一致の行の原因の候補は、その科目の元帳の行のうち、freee の仕訳番号に取り消されていない参照がない行（取込対象外・取込不可・取り消した取込）の一覧
- [X] T048 [P] [US3] `apps/server/test/imports.reconcile.api.test.ts`: `POST /fiscal-periods/:year/reconcile/freee` → 200 `{ rows, allMatched, unmapped }`、元帳の取引日が会計期間の外 → 422 `VALIDATION`
- [X] T049 [P] [US3] `apps/web/test/routes/imports-reconcile.test.tsx`: 年度とファイルを選ぶと照合の表が出る、すべて一致なら「すべての科目が一致しました」、不一致の行が目立ち、開くと差額と原因の候補（仕訳番号・日付・金額）が出る

### Implementation for User Story 3

- [X] T050 [US3] `packages/domain/src/import/freee/reconcile.ts` に `reconcile(input)` を実装し T046・T047 を通す
- [X] T051 [US3] `packages/domain/src/usecases/import-freee.ts` に `reconcileFreee` を加える（帳簿の残高は 001 の `ReportRepository` と `computeBalances`、参照は `ImportStore`）
- [X] T052 [US3] `apps/server/src/routes/imports.ts` に照合のルートを加え T048 を通す
- [X] T053 [US3] `apps/web/src/routes/e/$entityId/imports/reconcile.tsx` と `apps/web/src/features/imports/ReconcileTable.tsx` を作り T049 を通す。取込の履歴の画面から「元帳と照合」へのリンクを置く

**Checkpoint**: 取込の正しさを元帳との突合で確かめられる

---

## Phase 6: User Story 4 - 取込を取り消す (Priority: P2)

**Goal**: 1回分の取込をまとめて取り消し、取り込み直せるようにする

**Independent Test**: 取り込んで取り消すと、帳票が取込の前と同じになり、監査ログに理由が残り、同じファイルを再び取り込める

### Tests for User Story 4 ⚠️

- [X] T054 [P] [US4] `packages/domain/test/import/import-freee.void.test.ts`（`FakeImportUnitOfWork`）: `voidImportBatch` は、理由が空 → 001 の `REASON_REQUIRED`、取消済みの取込 → `IMPORT_BATCH_VOIDED`、締め済みの年度の仕訳を含む → `PERIOD_CLOSED`（`details.fiscalYears`）、`version > 1` の仕訳があり `confirmCorrected` が true でない → `CORRECTED_JOURNALS`（`details.count`・`details.journalIds`）。成功時: 有効な仕訳をすべて `voided` にし（利用者が個別に取り消した仕訳は飛ばす）、仕訳ごとに監査ログ `action = void` と理由、参照の `revoked_at`、取込の回の `status = voided`・`voided_at`・`void_reason`。取込で作った補助科目・取引先・タグ・対応表は残る（FR-027）
- [X] T055 [P] [US4] `packages/db/test/import-void.property.test.ts`: INV-15 / SC-007 任意の手入力の仕訳と取込の操作の列で、取込 → 取消の後の試算表・PL・BS が取込の前と同じ。取り消した後に同じファイルを取り込むと、仕訳が改めて `new` になる
- [X] T056 [P] [US4] `apps/server/test/imports.void.api.test.ts`: `POST /imports/:batchId/void` → 200 `{ batch, voidedCount }`、409 `CORRECTED_JOURNALS`、409 `PERIOD_CLOSED`、409 `IMPORT_BATCH_VOIDED`、404 `IMPORT_BATCH_NOT_FOUND`、422 `REASON_REQUIRED`
- [X] T057 [P] [US4] `apps/web/test/routes/imports-batch.test.tsx`: 取込の詳細の「取込を取り消す」で理由の入力欄が出て、空なら確定できない。訂正済みの仕訳があると件数を表示して再確認を求める。締め済みなら締めの解除が必要と表示する。取消の後は状態が「取消済み」になり、ボタンが消える

### Implementation for User Story 4

- [X] T058 [US4] `packages/domain/src/usecases/import-freee.ts` に `voidImportBatch` を実装し T054 を通す（仕訳の取消は 001 の `voidJournal` と同じ規則・監査ログの形にする）
- [X] T059 [US4] `packages/db/src/import-repository.ts` の `voidBatch`・`journalsOfBatch` で T055 を通す
- [X] T060 [US4] `apps/server/src/routes/imports.ts` に取消のルートを加え T056 を通す
- [X] T061 [US4] `apps/web/src/routes/e/$entityId/imports/$batchId.tsx` に取消のダイアログ（`apps/web/src/features/imports/VoidBatchDialog.tsx`）を加え T057 を通す

**Checkpoint**: 取込の誤りを取り消して、やり直せる

---

## Phase 7: User Story 5 - 同じ年度を繰り返し取り込む（並行稼働） (Priority: P3)

**Goal**: 前回からの差分だけを登録し、freee 側の変更・削除を警告する（帳簿は自動では変えない）

**Independent Test**: `journal-2025.csv` の後に `journal-2025-v2.csv` を取り込むと、追加の2仕訳だけが新規になり、変更・削除は警告に出て、帳簿の仕訳は変わらない

### Tests for User Story 5 ⚠️

- [X] T062 [P] [US5] `packages/domain/test/import/freee-plan.changes.test.ts`: 参照の `snapshot_json` と新しいファイルの `canonicalSnapshot` が違う仕訳 → 判定は `already`、警告 `FREEE_CHANGED`（`details.before`・`details.after`）。参照の `freee_date` が新しいファイルの選んだ年度の最小日〜最大日に入り、ファイルにない仕訳 → `FREEE_DELETED`。範囲の外の参照は警告しない。帳簿で利用者が訂正した仕訳でも、freee の内容が同じなら警告しない（比べる相手は snapshot）
- [X] T063 [P] [US5] `packages/db/test/import-incremental.test.ts`: v1 → v2 の順に取り込むと、2回目の取込の回の `count_new = 2`、変更・削除された仕訳の帳簿の内容と状態は変わらない、警告の数が取込の回の `count_warnings` に入る
- [X] T064 [P] [US5] `apps/web/test/routes/imports-new.changes.test.tsx`: プレビューに「freee 側で変更あり」（変更前と変更後の行）と「freee 側で削除」の一覧が出て、それぞれ帳簿の仕訳へのリンクがある

### Implementation for User Story 5

- [X] T065 [US5] `packages/domain/src/import/freee/plan.ts` に変更・削除の検出を加え T062 を通す（`planImport` の入力に `activeRefsInRange` の結果を加える）
- [X] T066 [US5] `packages/domain/src/usecases/import-freee.ts` のプレビュー・確定で範囲の参照を渡し、T063 を通す
- [X] T067 [US5] `apps/web/src/features/imports/FreeeChangesPanel.tsx` を作り、`imports/new.tsx` のプレビューに置いて T064 を通す

**Checkpoint**: すべてのユーザーストーリーが動く

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T068 [P] E2E `apps/web/e2e/freee-import.spec.ts`: 開始年度 2025 の事業体を作る → フィクスチャの仕訳帳を選ぶ → 未定の対応を決める → 取り込む → 期首残高を元帳から読み込んで保存 → 照合ですべて一致 → 同じファイルで新規0件。001 の `ledger-flow.spec.ts` と同じく使い捨てのデータディレクトリを使う
- [X] T069 [P] `scripts/bench-import.ts`: T011 の考え方で500仕訳の仕訳帳を作り（テストのコードには依存しない、スクリプト内で生成）、`.tmp/` の事業体でプレビュー（5秒以内）と確定（10秒以内）の時間を計って出す（SC-002）。`pnpm bench:import` で実行できること
- [X] T070 `scripts/verify-freee-import.ts` に通常のモードを加える: `--journal`・`--ledger`・`--year` を受け、`.tmp/verify-freee/` に使い捨ての事業体（開始年度 = `--year`）を作り、対応表の初期案のまま未定が残れば一覧を出して止まる（`--mapping <json>` で対応を渡せる。JSON は `.tmp/` に置く）。取込 → 元帳の期首残高の保存 → 照合 → PL・BS の科目別の金額を標準出力に出す（research R18）
- [ ] T071 T070 を `work/` の 2025年分で実行し、照合がすべて一致すること（SC-003）と、PL・BS の各科目が 2025年分の青色申告決算書（R7）と一致すること（SC-004、001 の SC-008）を確かめる。決算書の値はセッションの分析メモ（`analysis-tax-return.md`）を使い、**結果の数値はリポジトリに書かない**。一致しなければ原因を調べて直す。続けて 2026年分（途中経過）でも取り込み、FR-020a の警告が出ないことを確かめる
- [ ] T072 [P] 文書を更新する: `AGENTS.md`（取込のモジュールの置き場所、実データを扱うのは verify スクリプトだけ、フィクスチャの作り方）、`README.md`（freee からの移行の手順）、`docs/adr/0004-freee-closing-entries.md`（年初付の決算振替を期首に繰り込む判断。research R5）、`specs/001-ledger-core/quickstart.md` §3（SC-008 は 002 の T071 で確認した旨と日付）
- [ ] T073 quickstart.md §2 の手順1〜8を手で確かめ、画面の文言と違うところを直す
- [ ] T074 `pnpm lint && pnpm --filter @trebuchet/web build && pnpm typecheck && pnpm test && pnpm --filter @trebuchet/web e2e` がすべて成功することを確かめる

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし。**T005（実ファイルでの列名の確認）がゲート**で、T006 のフィクスチャ以降はその結果に依存する
- **Foundational (Phase 2)**: Setup の完了後。すべてのユーザーストーリーをブロックする
- **US1 (Phase 3)**: Foundational の完了後
- **US2 (Phase 4)**: Foundational の完了後。ドメイン（T035〜T042）は US1 と並行できる。T037 の振替の判定は T027 を使う
- **US3 (Phase 5)**: US1 と US2 の完了後（取り込んだ仕訳と期首残高が必要）
- **US4 (Phase 6)**: US1 の完了後
- **US5 (Phase 7)**: US1 の完了後
- **Polish (Phase 8)**: すべてのストーリーの完了後。T071 は T070 の後

### User Story Dependencies

```text
Setup → Foundational → US1 ─┬────────────→ US3 ─┐
                       US2 ─┘                   ├→ Polish
                       US1 → US4 ───────────────┤
                       US1 → US5 ───────────────┘
```

### Within Each User Story

- テストを書き、**失敗することを確認**してから実装する
- 順序: schema → domain（純関数）→ usecase → db → server ルート → web 画面
- 各ストーリーの完了時にコミットする

### Parallel Opportunities

- Setup: T001・T003・T007 は並列。T002 → T004 → T005 → T006 は順番に
- Foundational: T008・T009・T011・T013・T017 は並列。T012 → T015、T014 → T015
- 各ストーリーのテスト（[P]）はすべて並列に書ける
- US1 の T027・T029 は並列。US2 の T041 は US1 と並列
- US1 の完了後、US4 と US5 は並行できる（`plan.ts` を触る T065 と、`usecases/import-freee.ts` を触る T058・T066 は同じファイルなので順番に）

---

## Parallel Example: User Story 1

```bash
# テストをまとめて書く
Task: "T018 freee-group.test.ts"
Task: "T019 freee-closing.test.ts"
Task: "T020 freee-mapping.test.ts"
Task: "T021 freee-plan.property.test.ts"
Task: "T022 freee-plan.test.ts"
Task: "T023 import-freee.commit.test.ts"
Task: "T024 import-commit.test.ts (db)"
Task: "T025 imports.api.test.ts"
Task: "T026 imports-new.test.tsx, imports-index.test.tsx"

# 純関数を並列に実装する
Task: "T027 closing.ts"
Task: "T029 freee-aliases.ts, mapping.ts"
```

## Parallel Example: User Story 2（US1 と並行）

```bash
Task: "T035 freee-ledger.test.ts"
Task: "T036 carry-forward.property.test.ts"
Task: "T037 freee-opening.test.ts, freee-opening.property.test.ts"
Task: "T041 carry-forward.ts"
```

---

## Implementation Strategy

### MVP First（US1 だけ）

1. Setup（列名の確認とフィクスチャ）→ Foundational
2. US1 で仕訳帳の取込ができる
3. **止めて確認**: フィクスチャを取り込み、仕訳帳・試算表が `expected.ts` と一致し、2回目が0件になる

### Incremental Delivery

1. US1 → US2 で、仕訳と期首残高がそろい、R7 の期首 BS を作れる
2. US3 で元帳との突合ができ、実データでの照合（T071）の準備がそろう
3. US4（取消）→ US5（差分の取込）
4. Polish で、実データで SC-003・SC-004 を確かめる

### 学習のための進め方

- 解析（CSV・文字コード）は小さな純関数で、往復のプロパティテストの良い例になる（INV-17）
- 「プレビューは状態を持たず、確定のときに作り直して比べる」設計は、楽観ロックの考え方の応用
- 年初付の決算振替の扱い（research R5）は、会計の知識が設計を決める例。ADR に残す（T072）

## Notes

- [P] のタスクは別ファイルで、未完了のタスクに依存しない
- [Story] のラベルで、タスクとユーザーストーリーの対応を追える
- テストが失敗することを確かめてから実装する
- タスクまたは論理的なまとまりごとにコミットする
- 実データの数値を、どのファイルにも書かない
