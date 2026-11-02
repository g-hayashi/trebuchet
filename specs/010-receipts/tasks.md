---

description: "Task list for 010-receipts"
---

# Tasks: 証憑（領収書・レシート）の保存・読み取り・仕訳との紐づけ

**Input**: Design documents from `specs/010-receipts/`

**Prerequisites**: [plan.md](./plan.md)（Q1〜Q5 の答えは記録済み、2026-11-02）、[spec.md](./spec.md)（D1〜D7 を反映済み）、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)

**Tests**: 必須。Constitution V（テストファースト）により、各タスクでテストを先に書き、**失敗することを確かめてから**実装する。不変条件 INV-61〜68（data-model §4）は fast-check の性質テストか統合テストで検証する（`fc.assert(fc.property(...))` を直接呼ぶ）。

**Organization**: ユーザーストーリーごとにまとめる。「テスト → 実装」の対は同じタスクの中に置き、1 体の部下にまとめて渡す。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列にしてよい（別ファイルで、未完了のタスクに依存しない）。並列に実行する指示ではない（部下は 1 体ずつ順番に動かす）
- **[Story]**: US1 保存と検索、US2 スマホ、US3 仕訳との結びつき、US4 外部の AI の読み取り、US5 訂正・差し替え・削除と規程。**[BK]** はバックアップと復元（FR-021。どのストーリーにも属さない独立の段）
- 参照: `R` は research.md、`§` と `INV` は data-model.md、`D:` は contracts/domain-module.md（§1 定数、§2 関数、§3 ユースケース、§4 ポート）、`H:` は contracts/http-api.md（§1 エラーコード、§2 証憑、§3 結びつき、§4 仕訳の API、§5 読み取り、§6 AI の設定、§7 schema、§8 web）、`Q:` は quickstart.md

## 全タスク共通のルール

- **[AGENTS.md](../../AGENTS.md) の「開発の進め方」「データと一時ファイル」に従う**（テスト先行、`TenantUnitOfWork`〔`ReceiptUnitOfWork`〕、`auditEntry`、`dates.ts`、`respond`、web の `features/<機能>/api.ts` と `invalidateLedger`、`mock-api.ts`、マイグレーションの STRICT と `--custom`、エラーコードを変えるときの grep、部下のテストの範囲）
- この機能に固有: ファイルの暗号化は `TRC1`（R8、§1.8）、名前 = 平文の SHA-256。DK・`Kfile`・`Kname` をディスク・ログ・応答に出さない（INV-51・61）。**証憑の行・ファイル・履歴を物理削除しない**（トリガーで止める、R7）。平文の写しは `.tmp/receipt-convert-*` だけで `finally` で消す。応答は `Cache-Control: no-store`
- 紙を撮影した証憑（区分 `paper_scan`）は**紙の原本も保存する**運用（plan の Q1 = (A)）。入力期間・解像度・階調の警告は保存を拒まない目安（R1〜R3）。値の読み取りの AI は**外部の endpoint だけ**で、専用のポート `ReceiptReader` を通す（INV-45 の例外を 1 か所に閉じ込める。R13、INV-66）
- 税制の値（入力期間・画素数の目安）は `seed/tax-parameters.ts` とマイグレーションの**両方**に足す（AGENTS.md「決算書（003）」、R20）。domain は DB を読まず seed を `resolveTaxParameter` で引く
- 依存（npm パッケージ）は追加しない（`sips` と `node:crypto` で足りる。R12）。実データ（`work/`・`data/`）と実データの画像・取引先名は扱わない。フィクスチャは合成（R17）。`sips`・外部の AI・`fm` をテストから呼ばない（偽の `exec`・`fetch`・`ReceiptReader`・`ReceiptImageTool`）

---

## Phase 1: Setup

**Purpose**: テストが共通で使う合成のバイト列

- [ ] T001 テスト先行で `packages/domain/test/fixtures/receipts/sample-files.ts` と `README.md` を作る: 最小の合成バイト列（JPEG〔Exif の APP1 に Orientation と GPS、APP13、COM、画素数が違う 2 種〕、PNG、PDF、HEIC〔`ftyp` の major・compatible brands の組み合わせ〕、拡張子と違う中身、空・短いバイト列）を返す関数と、作り方・匿名化の方針（R17）。テスト `packages/domain/test/receipts/sample-files.test.ts`（先頭のマーカー・brands・セグメントの並びを確かめる）。実データの写真・文字列を入れない

---

## Phase 2: Foundational（全ストーリーの前提）

**Purpose**: 共有の型・契約、税制の値、検索と履歴の純関数、偽物、表とマイグレーション、暗号化のファイル、リポジトリ

- [ ] T002 テスト先行で schema を足す: 新規 `packages/schema/src/receipts.ts`（H: §7、§2.1 の型、`RECEIPT_MAX_BYTES`、`ReceiptQuery`〔§2.3〕、`ReceiptParam`・`ReceiptFileParam`）、`ai.ts` に `AiReceiptReading`（R14。`AiSettings` は T008）、`errors.ts` に 8 コード（H: §1）、`index.ts`。`apps/server/src/errors.ts` の `ERROR_STATUS` に H: §1 のステータスを足し、`grep -rn` で web の表示・既存テストも直す。テスト `packages/schema/test/receipts.test.ts`（金額 0・1e12、日付、取引先 100 文字、`sha256` の形、`AiReceiptReading` の項目ごとの null）
- [ ] T003 テスト先行で domain の型・ポート・日付・seed: `packages/domain/src/types.ts`（`TaxParameterKey` に 4 key〔§1.6〕、`Receipt*Row`、`ReceiptAuditEntry`）、`ports.ts`（`ReceiptStore`・`ReceiptUnitOfWork`・`ReceiptFileStore`・`ReceiptImageTool`・`ReceiptReader`・`ReceiptReadingRequest`、D: §4・§2）、`dates.ts` に `addMonthsToDate`・`addBusinessDays`（R2）、`seed/tax-parameters.ts` に 4 行（§1.6、適用開始 2024-01-01、出典の URL つき、R20）。テスト `packages/domain/test/dates.test.ts`（問23 の 4/21 → 6/20、月末の丸め、土日）と seed のテスト。`pnpm typecheck` が通るまで `TaxParameterKey` を使う箇所を直す
- [ ] T004 テスト先行で純関数 `packages/domain/src/receipts/search.ts`（`normalizeReceiptText`・`escapeLike`・`matchesReceiptQuery`、R4、§2.3）と `receipts/history.ts`（`linkStateOf`・`needsReason`・`replayReceiptHistory`・`RECEIPT_REASON_AUTO_VOIDED`、R5・R7、§2.2・§2.5）を実装する。テスト `packages/domain/test/receipts/search.test.ts`・`search.property.test.ts`（INV-65: 全角・半角・大文字小文字・空白の違いだけで同じ結果、`%`・`_`・`\` の扱い）、`history.test.ts`（`needsReason` の境界: 未入力を埋める・メモだけは不要）。`replayReceiptHistory` の性質テストは T027
- [ ] T005 テスト先行で偽物とジェネレーター: `packages/domain/test/fakes/receipts.ts`（`FakeReceiptStore`〔`search` は `matchesReceiptQuery`〕・`FakeReceiptFileStore`・`FakeImageTool`・`FakeReceiptReader`、D: §4）を `fakes.ts` から再エクスポートし、`FakeUnitOfWork` に `receipts` を足す。`packages/domain/test/receipt-arbitraries.ts`（証憑・操作の列・JPEG のセグメント・応答の文字列。§1 の制約を満たす。T001 の合成バイト列を使う）。テスト `receipt-arbitraries.test.ts`（生成値が制約を満たす）、`fakes-receipts.test.ts`（版の連番、`sha256` 一意、有効な結びつきは 1 件）
- [ ] T006 テスト先行で表を作る: `packages/db/test/receipt-schema.test.ts`・`tenant-store.test.ts` に、5 表が STRICT、§1.1〜1.5 の各 CHECK の違反が失敗、`tax_parameters` の key に 4 つが通るテストを先に書いて赤を確かめる。次に `packages/db/src/schema/tenant.ts` に 5 表と key を足し、`pnpm --filter @trebuchet/db exec drizzle-kit generate --name receipts --config drizzle.tenant.config.ts` で `packages/db/drizzle/tenant/0014_receipts.sql` を作り、新しい表の `);` を `) STRICT;` に直す。`tax_parameters` の作り直しは 009 の `0011_depreciation.sql` と同じ手順（§5、R20）
- [ ] T007 テスト先行で `packages/db/drizzle/tenant/0015_receipts_integrity.sql` を書く（§1・§5、R7）: 先に `packages/db/test/receipt-integrity.test.ts`（5 表の DELETE 禁止、`receipt_files`・`receipt_audit_log` の UPDATE 禁止、`receipts` の `received_at`・`channel`・`id` の不変と `deleted_at` の 1 回だけ、`receipt_links`・`receipt_readings` の NULL から値への 1 回だけの UPDATE）と `closing-repository.test.ts`（`listTaxParameters` が seed の 4 行と一致、§1.6）を書いて赤を確かめる。`--custom --name receipts_integrity` の SQL にトリガーと 4 行の `INSERT` を手で書く。作り直した `tax_parameters` の既存のトリガーがあれば作り直す
- [ ] T008 テスト先行で registry `packages/db/drizzle/registry/0002_ai_receipt_images.sql`（`drizzle.registry.config.ts` で生成。列と CHECK は §1.7・§5）と `schema/registry.ts`、`ai-settings-repository.ts`、`backup/restore.ts` の `readAiSettings`・`INSERT` の列を足す。schema `ai.ts` の `AiSettings`・`AiSettingsInput` に `receiptImagesEnabled`（H: §6）。`grep -rn AiSettings` で server・web の型と `mock-api.ts` の既定値（false）を直す（検査は T034）。テスト `packages/db/test/ai-settings-repository.test.ts` と復元の引き継ぎ
- [ ] T009 テスト先行で `packages/db/src/receipt-files.ts` を実装する（R8・R9、§1.8、INV-61）: `encryptReceipt`・`decryptReceipt`（`TRC1`、`Kfile`、AAD は §1.8 のとおり。復号の後に SHA-256 = 名前を確かめる）と `createReceiptFileStore(entityId)`（D: §4。`.partial` → 改名、鍵は `withDataKey` の中だけで作り `fill(0)`、`ReceiptFileUnreadableError`）。`tenant-store.ts` に `receiptFile(entityId, sha256)`・`receiptsDir(entityId)`（形の検査）。テスト `packages/db/test/receipt-files.test.ts`・`receipt-files.property.test.ts`（往復、1 バイトの変更・切り詰め・別の DK・別の事業体・別の名前で平文を返さない、施錠中 `VaultLockedError`）
- [ ] T010 テスト先行で `packages/db/src/receipt-repository.ts` に `ReceiptStore`（D: §4 の全メソッド）と `createReceiptUnitOfWork`（`drizzleUnitOfWork` に `receipts` を足し、`index.ts` で export）を実装する。`search` は R4・§2.3 の SQL（`ESCAPE '\'`、カーソル、結びつきと仕訳の状態を JOIN）、`countActiveLinksByJournal` は 1 回の GROUP BY。`internal.ts` の `TenantConn`・`rowidOf` を使う。テスト `packages/db/test/receipt-repository.test.ts`、`receipt-search.property.test.ts`（INV-65: 小さな集合で SQL と `matchesReceiptQuery` が一致、実行回数を絞る）、`version` 不一致、重複の UNIQUE

**Checkpoint**: `pnpm vitest run --project schema`、`--project domain`、`--project db` が通る。`pnpm typecheck` が通る

---

## Phase 3: User Story 1 - 保存し、取引年月日・金額・取引先で検索する (Priority: P1) 🎯 MVP

**Goal**: 画像・PDF を暗号化して保存し、区分・日付・金額・取引先を入れ、条件の組み合わせで検索し、その場で表示・取り出す。警告（未入力・入力期間・解像度・階調）を示す

**Independent Test**: spec US1 のシナリオ 1〜7（Q: §2 の手順 2〜7）

- [ ] T011 [US1] テスト先行で `packages/domain/src/receipts/format.ts` の `detectReceiptFormat`（R10 のマジックバイト、HEIC は `ftyp` の major・compatible brands、先頭だけ見る）と `receipts/warnings.ts` の `inputDeadline`・`receiptWarnings`（§2.2、R2・R3。削除済みは空、解決できない税制の値では警告を出さない）を実装する。テスト `packages/domain/test/receipts/format.test.ts`（4 形式、拡張子と違う中身、空・短い）、`warnings.test.ts`（問23 の例、月末、土日、`paper_scan` だけ、A4 の目安、カラー）、`warnings.property.test.ts`
- [ ] T012 [US1] テスト先行で `packages/domain/src/usecases/receipts.ts` に `addReceipt`・`listReceipts`・`getReceipt`・`readReceiptFile` を実装する（D: §3、R10 の同期の区間: 形式 → 大きさ → `digest` → 重複 `RECEIPT_DUPLICATE`〔`details.receiptId`・`deleted`〕→ `put` → `uow.run` → 失敗なら自分が `put` したファイルだけ `discard`、FR-001〜005・007）。`ReceiptDetail` の組み立てに `linkStateOf`・`receiptWarnings`。テスト `packages/domain/test/receipts/receipts.test.ts`、`receipts-add.property.test.ts`（INV-62: 同じ内容の繰り返し・DB の失敗で行もファイルも残さない、`sha256` 一意。INV-63 の `create` の履歴）
- [ ] T013 [P] [US1] テスト先行で `apps/server/src/lib/image-tool.ts` の `createImageTool({ exec })` を実装する（R12、D: §4）: `probe`（`sips -g pixelWidth …`、PDF は undefined）、`toDisplay`（HEIC だけ JPEG に、他は原本）、`toAiJpeg`（`-Z` 長辺、PDF は `sips` → `qlmanage` の順で、描けなければ `RECEIPT_READ_UNSUPPORTED`、Q5）。作業ファイルは `.tmp/receipt-convert-<乱数>/` で `finally` で消し、子プロセスの `TMPDIR` も `.tmp/`、時間切れ 20 秒。テスト `apps/server/test/image-tool.test.ts`（偽の `exec`。引数、成功・失敗・時間切れ、作業ディレクトリが残らない。`sips` は呼ばない）
- [ ] T014 [US1] テスト先行で `apps/server/src/lib/startup.ts` に起動時の `.tmp/receipt-convert-*` の掃除（004 の `removeStaleSnapshots` と同じ、R9）、`lib/vault.ts` の初回の設定で以前の `receipts/` も `discarded-<時刻>/` へ移す処理（R9、008 D4.1）を足す。テスト `apps/server/test/startup.test.ts`・`vault.test.ts` に追加
- [ ] T015 [US1] テスト先行で `apps/server/src/routes/receipts.ts` を作り `app.ts` に登録する（H: §2 の POST・GET 一覧・GET 詳細・GET ファイル）。`upload.ts` の `uploadLimitFor`・`readUpload`・`readJsonField`、経路は Host の `isLocalHost`（R10）、ファイルの応答のヘッダーは H: §2、`respond`・`validate("param", ReceiptParam)`、`createApp({ imageTool })` の差し替え口。テスト `apps/server/test/receipts.api.test.ts`（H: §1 のコードとステータス、20 MB + 1 バイトで 413、`localhost` で `local`・ts.net の Host で `remote`、施錠中 401 `LOCKED`、重複 409、変換の失敗 500）。`auth-coverage.test.ts`（INV-29）が通ることを確かめる
- [ ] T016 [US1] テスト先行で web の一覧と検索: `apps/web/src/features/receipts/api.ts`（query key、multipart の送り方は 007 の `features/statements/api.ts`、H: §8）、`ReceiptSearchForm.tsx`・`ReceiptList.tsx`（日付・金額の範囲、取引先、区分、未入力、結びつき、削除済み、警告と経路の表示）、`routes/e/$entityId/receipts/index.tsx`、`apps/web/test/mock-api.ts` の `/receipts` の既定の応答。テスト `apps/web/test/routes/receipts-list.test.tsx`。`pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成してから typecheck する
- [ ] T017 [US1] テスト先行で web の追加と詳細: `ReceiptUpload.tsx`（区分・日付・金額・取引先・メモ、20 MB 超は送信前に止める、警告の表示、409 `RECEIPT_DUPLICATE` は既存の証憑へ案内し削除済みなら示す）、`ReceiptViewer.tsx`（画像・PDF の表示と原本の取り出し）、`routes/e/$entityId/receipts/$receiptId.tsx`（受領日時・ハッシュ・元の名前・形式・大きさ・経路）。訂正・差し替え・削除は T029、読み取りは T035。テスト `receipts-upload.test.tsx`、`receipt-detail.test.tsx`。build で `routeTree.gen.ts` を再生成する

**Checkpoint**: 合成のファイルで、追加 → 検索 → 表示・取り出しが通り、`ls receipts/<事業体>/` が暗号化されたハッシュ名（MVP）

---

## Phase 4: User Story 2 - スマホで撮影してアップロードする (Priority: P1)

**Goal**: ts.net の PWA から、撮影またはファイルの選択で証憑を送り、失敗をはっきり示す

**Independent Test**: spec US2 のシナリオ 1〜4。画面のコンポーネントテストと、T015 の経路のテスト。実機は T045

- [ ] T018 [US2] テスト先行で `apps/web/src/features/receipts/CaptureForm.tsx` と `routes/e/$entityId/receipts/capture.tsx` を作る（R16、FR-006）: `<input type="file" accept="image/*" capture="environment">` と選択（`capture` なし、`accept` は JPEG・PNG・HEIC・PDF）、区分、任意の日付・金額・取引先、成功は 201 を受けてから表示、通信の切断・`LOCKED`・5xx は失敗とはっきり示す（保存されたと誤解させない）。`routes/index.tsx` の各事業体に「証憑を撮る」の入口。manifest・`apple-touch-icon` が 004 のままであることを確かめる（Service Worker は足さない）。テスト `apps/web/test/routes/receipts-capture.test.tsx`。build で `routeTree.gen.ts` を再生成する

---

## Phase 5: User Story 3 - 証憑と仕訳を結びつける (Priority: P1)

**Goal**: 証憑から仕訳を登録する、または既存の仕訳に結びつける。仕訳の一覧・詳細で証憑が分かる。訂正で引き継ぎ、取消で残る

**Independent Test**: spec US3 のシナリオ 1〜6（Q: §2 の手順 8）

- [ ] T019 [US3] テスト先行で `packages/domain/src/receipts/candidates.ts` の `rankJournalCandidates`・`RECEIPT_CANDIDATE_WINDOW_DAYS`（14）・`RECEIPT_CANDIDATE_LIMIT`（20）を実装する（§2.4、R6、FR-011）。並び: ①借方合計 = 金額 ②日付の差 ③金額の差 ④仕訳番号。テスト `packages/domain/test/receipts/candidates.test.ts`・`candidates.property.test.ts`（金額未入力は同順位、基準日は取引年月日〔なければ受領日〕、上位 20 件）
- [ ] T020 [US3] テスト先行で `packages/domain/src/usecases/receipt-links.ts` に `linkReceipt`・`unlinkReceipt`・`createJournalFromReceipt`・`listJournalCandidates`・`listJournalReceipts`・`countReceiptsByJournal` を実装する（D: §3、R5・R6、FR-010〜013）。仕訳の登録は 006 の `approveCandidate`（`statement-approval.ts`）と同じく 1 つの `uow.run` で `tx.ledger` から 001 の `createJournal` を呼ぶ。付け替えは `replace` と理由、`journal_voided` は自動で閉じる。`readingId` の比べは T033。テスト `packages/domain/test/receipts/receipt-links.test.ts`、`receipt-links.property.test.ts`（INV-64: 有効な結びつきは証憑ごとに高々 1 件、削除済みにはない、`RECEIPT_ALREADY_LINKED`、登録の失敗で全部戻る、帳簿を変えない）
- [ ] T021 [US3] テスト先行で `packages/db/test/receipt-links.integration.test.ts`（実際の `drizzleUnitOfWork`・`useTempDataDir`。INV-64）を書き、落ちたところだけ `receipt-repository.ts` を直す: 001 の `correctJournal` の後も同じ `journal_id` で `linked`、`voidJournal` の後は結びつきが残り `journal_voided`、別の仕訳へ結び直すと古い結びつきが閉じる、`createJournalFromReceipt` の途中の失敗で仕訳・結びつき・履歴が全部戻る、結びつきの操作の前後で仕訳帳・試算表が同じ
- [ ] T022 [US3] テスト先行で `routes/receipts.ts` に H: §3 の 4 つ（`journal-candidates`・`link`・`unlink`・`journal`）、`routes/journals.ts` に一覧の `receiptCount`・詳細の `receipts`（H: §4、R6。001 の `LedgerRepository`・`Journal`・`JournalOutput` は変えない）を足す。テスト `apps/server/test/receipts-links.api.test.ts`（H: §1 のコードとステータス、`JOURNAL_VOIDED`、`REASON_REQUIRED`、`journal` の `201 { journal, receipt }`）、`journals.api.test.ts`（`receiptCount`・`receipts` の合成）
- [ ] T023 [US3] テスト先行で web: `LinkJournalDialog.tsx`（候補、検索、付け替え・解除の理由）、証憑から仕訳を作る入口（取引年月日・金額・取引先を初期値にして 001 の仕訳入力を開く。登録の後は `invalidateLedger(queryClient, entityId)`）、`features/journals/` の一覧の証憑の印・詳細の証憑の欄、`mock-api.ts` の仕訳の既定の応答に `receiptCount: 0`・`receipts: []` と候補（H: §4・§8）。理由の要否は web で判断せず 422 `REASON_REQUIRED` を受けて求める。テスト `apps/web/test/routes/receipt-link.test.tsx`、journals の既存テスト。既存の web のテストが落ちないことを確かめる

**Checkpoint**: 証憑から仕訳を 1 件登録し、別の証憑を既存の仕訳に結びつけ、仕訳の詳細から両方が開ける

---

## Phase 6: バックアップと復元 [BK]（FR-021、SC-006）

**Goal**: 証憑のファイルを `.tbk` の外の置き場所に増分で写し、復元で全件を確かめる。**実際の証憑を貯め始める前に済ませる**

**Independent Test**: INV-68（Q: §2 の手順 11）。US1 の後ならいつでもよい

- [ ] T024 [BK] テスト先行で `packages/db/src/backup/receipts.ts` を実装する（R11、§1.8）: `receiptBackupName`（`HMAC-SHA256(Kname, sha256)`、`Kname` = HKDF(DK, 空, "trebuchet/backup/receipt-name/v1")）、`syncReceiptsToStore`（置き場所にないものだけ、データ場所と同じバイト列を `.partial` に書き、読み戻して `decryptReceipt` で検証してから改名）、`restoreReceiptsFromStore`。テスト `packages/db/test/backup-receipts.test.ts`（名前が平文のハッシュと違う、2 回目は写さない、中身が同じ、改ざん・欠けの検出、`.tmp/` の置き場所）
- [ ] T025 [BK] テスト先行で `packages/db/src/backup/restore.ts` に証憑の復元を足す（R11、INV-68）: 展開後に各事業体の `receipt_files` の全件を `--receipts-dir` から読み、バックアップの DK で `decryptReceipt` し `receipts/<entityId>/<sha256>.trc` に書く。1 件でも欠ける・壊れていれば改名の前に失敗する `RECEIPTS_MISSING`（`RestoreErrorCode`、件数つき）、`allowMissingReceipts` で帳簿だけ戻す。`scripts/lib/restore-cli.ts`・`scripts/restore-backup.ts` に `--receipts-dir`（既定は `.tbk` と同じフォルダの `trebuchet-receipts/`）・`--allow-missing-receipts`。テスト `backup-receipts.test.ts` に往復（名前と数が同じ、欠けで何も変えない、フラグで帳簿だけ、INV-54 のまま）と restore-cli のテスト
- [ ] T026 [BK] テスト先行で `apps/server/src/lib/backup-run.ts` の順序を変える（R11）: スナップショット → 写した各事業体の DB の `receipt_files.sha256` → `syncReceiptsToStore` → `.tbk`。`shouldSkipBackup` で書かないときも写しは確かめる。失敗は `failed`・`error_code` `RECEIPTS_SYNC_FAILED`（`FailureCode` と `packages/schema/src/backup.ts` のコメントに足す）で `.tbk` を書かない。世代の整理は `.tbk` だけ。テスト `apps/server/test/backup-run.test.ts`（INV-68: `.tbk` が参照する全証憑が置き場所にある、写しの失敗で `.tbk` を書かない、証憑 0 件でも今までどおり）

**Checkpoint**: バックアップ → 復元の往復で、全証憑のハッシュが一致する

---

## Phase 7: User Story 5 - 訂正・差し替え・削除を履歴に残し、規程を備える (Priority: P2)

**Goal**: 訂正・差し替え・削除が元の値・ファイルを残して履歴に載り、削除済みも表示できる。事務処理規程とシステム概要書を置く

**Independent Test**: spec US5 のシナリオ 1〜6（Q: §2 の手順 9・12）

- [ ] T027 [US5] テスト先行で `usecases/receipts.ts` に `updateReceipt`・`replaceReceiptFile`・`deleteReceipt`・`getReceiptHistory` を足す（D: §3、R7、FR-018・019。削除済み → `RECEIPT_DELETED`、`version` 不一致 → `VERSION_CONFLICT`、`needsReason` で理由なし → `REASON_REQUIRED`〔001 の `checkReason`〕、有効な結びつき → `RECEIPT_LINKED`）。`compareReadingWithSaved` は T033。テスト `receipts-update.test.ts`、`receipts-history.property.test.ts`（INV-63: 操作の列〔入力・訂正・差し替え・削除・結びつけ・解除〕の後に行数が減らず、版は連番で今の版は最大、`replayReceiptHistory` で任意の時点の値と原本が戻る〔SC-005〕。INV-62: 差し替えの重複・失敗）
- [ ] T028 [US5] テスト先行で `routes/receipts.ts` に H: §2 の PATCH・`POST …/files`・`POST …/delete`・`GET …/history` を足す。テスト `apps/server/test/receipts-edit.api.test.ts`（`REASON_REQUIRED`、`VERSION_CONFLICT`、`RECEIPT_DELETED`、`RECEIPT_LINKED`、差し替えの警告つき 201、削除済みの表示・取り出し・履歴はできる）
- [ ] T029 [US5] テスト先行で web: `ReceiptFieldsForm.tsx`（値の入力・訂正）、撮り直しの差し替え、削除（結びつきがあれば解除を促す）、`ReceiptHistory.tsx`（前後の値・理由・差し替え前の画像を開く）、一覧の「削除済みを含める」。理由は 422 `REASON_REQUIRED` を受けて求める（web に業務ルールを持たない）。`mock-api.ts` の詳細・履歴の既定の応答。テスト `apps/web/test/routes/receipt-edit.test.tsx`。既存の web のテストが落ちないことを確かめる
- [ ] T030 [P] [US5] `docs/receipts/processing-rules.md` と `docs/receipts/system-overview.md` を書く（R18、FR-020）。規程は国税庁の個人の例（R1 の URL）を元に、①対象 ②保存の場所と方法 ③訂正・削除の原則禁止とやむを得ない手順 ④保存の責任者 ⑤保存期間 7 年以上 ⑥紙を撮影した証憑は紙の原本も保存 ⑦入力の期限の目安（業務処理サイクル）。概要書は保存の仕組み（R7・R8・R11）、検索（R4）、表示と印刷、バックアップと復元の手順の要約。名前・日付は空欄。実データ・実名を書かない。書いた後 `grep` で ①〜⑦と概要書の 4 項目の見出しがそろうことを確かめる

---

## Phase 8: User Story 4 - 外部の AI で読み取る (Priority: P2)

**Goal**: 2 つの設定が有効なときだけ、証憑の画像を外部の AI に送り、項目ごとに検証した候補を入力欄の初期値として示す

**Independent Test**: spec US4 のシナリオ 1〜5（Q: §2 の手順 10。偽の AI）

- [ ] T031 [US4] テスト先行で `packages/domain/src/receipts/jpeg-metadata.ts` の `stripJpegMetadata`（APP1〔Exif・XMP〕・APP13・COM を除き、Orientation があれば Orientation だけの最小の APP1 を SOI の直後に置く。JPEG でなければ `err(VALIDATION)`、R12）と `receipts/reading-prompt.ts`（`RECEIPT_AI_MAX_PX`・`RECEIPT_READING_SYSTEM_PROMPT`・`buildReceiptReadingRequest`、R13、D: §1・§2）を実装する。テスト `jpeg-metadata.test.ts`、`reading-prompt.property.test.ts`（INV-66: 任意の科目・税区分・JPEG のセグメントで、出力は指示文・科目と税区分の一覧・画像 1 枚だけ。GPS・取引先・仕訳・口座・メモ・ファイル名を含まない）
- [ ] T032 [US4] テスト先行で `packages/domain/src/receipts/reading.ts` の `parseReceiptReading`（応答の文字列を項目ごとに `AiReceiptReading` の Zod で検証、科目・税区分は一覧にあるものだけ、JSON でなければ `invalid` で全部 null）・`compareReadingWithSaved`・`compareReadingWithJournal` を実装する（R14、D: §2、FR-016・017）。テスト `reading.test.ts`、`reading.property.test.ts`（INV-67: 任意の応答の文字列で候補は検証を通り、一覧にない科目は候補なし、取引先は `normalizeReceiptText` で比べる）
- [ ] T033 [US4] テスト先行で `usecases/receipt-reading.ts` の `readReceipt`（3 段、R13: ① `uow.run` で証憑・今の版・科目・税区分を読む。`reader` が undefined なら `AI_NOT_CONFIGURED` ② UnitOfWork の外で `files.read` → `toAiJpeg` → `stripJpegMetadata` → `buildReceiptReadingRequest` → `reader.read` → `parseReceiptReading` ③ `uow.run` で `receipt_readings` と `read` の履歴。変換・AI の失敗も ③ で記録して `ok`）を実装し、`updateReceipt` に `compareReadingWithSaved`（未比較の読み取りへ 1 回だけ）、`createJournalFromReceipt` の `readingId` に `compareReadingWithJournal` を足す。テスト `receipt-reading.test.ts`（INV-66: 無効なら 1 回も呼ばない、INV-67: 証憑の値は変わらない、`RECEIPT_DELETED`）
- [ ] T034 [US4] テスト先行で server: `lib/ai-client.ts` に `createReceiptReader`（外部の endpoint だけ。`ChatRequest` の `content` を文字列 | 部品の配列に広げる〔006・007 は文字列のまま〕、R13）、`lib/ai-runtime.ts`（2 つの設定が真で URL・モデル・キーがそろうときだけ reader）、`routes/ai-settings.ts`（H: §6、R15 の 422 `AI_NOT_CONFIGURED` と外部を偽にしたときの連動）、`routes/receipts.ts` に H: §5 の `POST …/readings`。テスト `apps/server/test/receipt-reading.api.test.ts`（偽の `fetch`: 要求の形〔`image_url`、`response_format`〕、取引先の一覧を含まない、422、時間切れは 201 で `timeout`）、`ai-settings.api.test.ts`
- [ ] T035 [US4] テスト先行で web: `features/ai-settings/` と `routes/settings/ai.tsx` に「証憑の画像を外部の AI に送る」の項目と、有効にする前の確認（画像はマスクできずそのまま外部に送られる。006 の送る情報の原則の例外、FR-015）、`ReceiptReadingNote.tsx`（読み取りの操作は設定が有効なときだけ、候補は AI の候補と示して入力欄の初期値にし、失敗は示して手入力で続けられる。追加の直後の自動の読み取りは web が `readings` を呼ぶだけ）、証憑から仕訳の入力に候補の科目・税区分と `readingId`。テスト `apps/web/test/routes/receipt-reading.test.tsx`、`ai-settings` の既存テスト
- [ ] T036 [P] [US4] テスト先行で `packages/domain/src/receipts/evals.ts`（項目ごとの一致率の集計。純関数）と `scripts/eval-receipts.ts`・`package.json` の `eval:receipts`（R17: `packages/domain/test/fixtures/receipts/` の合成の画像を R13 と同じ経路で外部の AI に送り、一致率を `.tmp/eval-receipts/` に件数と割合だけで残して前回と比べる。先頭のコメントに使い方・環境変数）を実装する。テスト `packages/domain/test/receipts/evals.test.ts`（偽の `ReceiptReader` で集計だけ）。画像がなければ明示のエラーで止まる。CI に含めない。画像の用意は T042

**Checkpoint**: 偽の AI で、候補が入力欄に入り、設定が無効なら呼ばれない

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T037 `scripts/bench-reports.ts` に「010 SC-002」を足す（R21）: 証憑 5,000 件（ファイルなし。リポジトリで行だけを入れる）の事業体で、日付の範囲 × 金額の範囲 × 取引先の部分一致の検索を 10 回、各 1 秒以内を確かめる。新しい bench のスクリプトは作らない。結果の数値はコミットしない
- [ ] T038 [P] `docs/adr/0014-receipt-storage.md` を書く（R19。書式は `0001-sqlite-driver.md`、状態は「採用」）: 暗号化と名前（R8）、`.tbk` と別置きの増分の写し（R11）、INV-45 の例外を 1 つのポートに閉じ込める（R13）、タイムスタンプを使わず紙の原本を残す（R1、Q1 = (A)）。関連に 0011・0007
- [ ] T039 文書を更新する: `AGENTS.md` に「証憑（010）」の節（場所の表、暗号化と名前、INV-45 の例外の経路、`sips` の作業ファイルと `.tmp/receipt-convert-*`、バックアップの写しと復元のフラグ、`eval:receipts` の規則、税制の値の 4 key、紙の原本を保存する運用）とコマンド表の `pnpm eval:receipts`・`bench:reports` の説明（SC-002）、`docs/requirements.md` の FR-08・NFR-04・NFR-09 の状態、`specs/INVARIANTS.md` は済み（INV-61〜68 と合うか確かめる）

---

## Phase 10: 利用者の端末での確認と最終の検証（メイン・利用者。実データ・実際の画像・取引先名・金額は書かない）

- [ ] T040 **（メイン・利用者）ゲート** 利用者の Mac で R12 のゲートを確かめ、結果（できた・できない、どの方法か）だけを research R12 に追記する: ① iPhone の HEIC（縦の撮影）→ 表示用の JPEG ② 1 ページの電子の PDF の 1 ページ目が長辺 2,048 で文字が読める（`sips`、だめなら `qlmanage`）③ AI 用の JPEG の向きが正しく、`sips -g all` に GPS の項目がない。②が両方でだめなら、PDF の読み取りは範囲外（手入力）にする（Q5。`image-tool.ts` の PDF の分岐を `RECEIPT_READ_UNSUPPORTED` だけにし、spec の Assumptions のとおり。依存は足さない）。結果が R12 の想定と違えば T013 を直す
- [ ] T041 **（メイン・利用者）** `pnpm --filter @trebuchet/web e2e`（既存の E2E が壊れていないこと。E2E は足さない）と、Q: §2 の手動確認（利用者が `TREBUCHET_DATA_DIR="$PWD/.tmp/quickstart-010" pnpm dev` を起動し、implementer がブラウザの MCP の snapshot で手順 1〜12 を確かめる）。画面の文言を quickstart に合わせ、終わったら `.tmp/quickstart-010*` を消す。手順 10 は偽の接続先
- [ ] T042 **（メイン・利用者）** 評価用の合成の証憑の画像 20 枚（レシート・領収書・電子の PDF を混ぜ、HEIC 2 枚・PDF 2 枚を含む）を `packages/domain/test/fixtures/receipts/` に置く（R17）。作り方はリポジトリに置かない使い捨てのスクリプトか、ブラウザで合成の文書を描いて保存。HEIC は利用者の Mac の `sips` で変換。`README.md`（作り方・匿名化・項目の正解）と `expected.ts`（正解）を書く。実データの写真・実在の店名・番号を入れない
- [ ] T043 **（メイン・利用者）** 外部の AI の確認（SC-003・004）: 利用者が選んだ画像入力に対応するモデルで、`pnpm eval:receipts` を実行し、取引年月日・金額の一致率（目標 ≥ 90%）を控える（割合だけ。指示文などを変えるときは前後で比べる）。証憑から仕訳の登録までの時間（AI の候補あり 1 分、手入力 2 分）を計る。実データの証憑で試すかは利用者が決め、結果は件数と一致・不一致だけを控える
- [ ] T044 **（メイン・利用者）** スマホの実機の確認（US2、SC-001、Q: §3。**004 の T022〔US4 の実機確認〕の後**）: `pnpm start` と `tailscale serve` の ts.net を iPhone の Safari で開き、ホーム画面に追加 → アプリの中でパスキーでサインイン → 撮影の画面で撮る（5 MB 前後で送信から保存の表示まで 10 秒以内、経路が「スマホ・リモート」）、機内モードの送信は失敗と示される、Mac が施錠中は 401 `LOCKED` の表示。実際の証憑を貯め始めた後、置き場所の `trebuchet-receipts/` の大きさと自動のバックアップの時間（値だけ）を控える
- [ ] T045 **（メイン）** 全体の検証: `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @trebuchet/web build`、`pnpm bench:reports`（SC-002）。落ちたら implementer に直させる。T040〜T044 で直した場合は再実行する

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup（T001）→ Foundational（T002〜T010）→ US1（T011〜T017）→ US2（T018）→ US3（T019〜T023）→ [BK]（T024〜T026）→ US5（T027〜T030）→ US4（T031〜T036）→ Polish（T037〜T039）→ 確認と検証（T040〜T045）
- Foundational の中: T002 → T003 → T004 → T005（型 → 純関数 → 偽物）。T006 → T007（表 → トリガー）→ T008。T009 は T003・T006 の後。T010 は T004・T006・T007・T009 の後
- US1 の中: T011 → T012。T013 は T003 の後ならいつでも（[P]）。T014 → T015（T012・T013 の後）→ T016 → T017
- T033 は T027（`updateReceipt`）・T020（`createJournalFromReceipt`）の後。T034 は T008・T033 の後。T036 の実行（T043）には T042 の画像が要る
- T044 は 004 の T022 の後。T040 の結果が R12 の想定と違えば T013・T034 を直す

### User Story Dependencies

- **US1**: Foundational の後。ほかのストーリーが使う（追加・一覧・詳細・ファイルの応答）
- **US2**: US1 の後（追加の API と経路）。004 の US4（ts.net・ペアリング・静的配信）は T016〜T018b まで完了。実機の確認だけ T022 の後
- **US3**: US1 の後。**US5**: US1・US3 の後（削除は結びつきを見る）。**US4**: US1・US5 の後（`updateReceipt` に比べを足す）
- **[BK]**: US1 の後ならいつでもよいが、本番で証憑を貯め始める前に済ませる（Phase 6 に置いた）

### Within Each User Story

- テスト → ドメインの純関数 → ユースケース → db → API → 画面
- テストが旧コードで落ちることを確かめてから実装する（部下が赤の確認を飛ばしたら、メインが `git stash` で確かめる）

### Parallel Opportunities

- T013・T030・T036・T038 は別ファイルで未完了のタスクに依存しない（[P]）。ただし実行は順番に行う

## Implementation Strategy

### MVP First（US1 だけ）

1. Setup と Foundational（T001〜T010）
2. US1（T011〜T017）: 合成のファイルで、追加 → 検索 → 表示・取り出し → 暗号化の確認
3. 本番で実際の証憑を貯め始める前に、[BK]（T024〜T026）と US5 の規程（T030）を済ませる

### Incremental Delivery

1. US1 → US2（スマホ）→ US3（仕訳）→ [BK] → US5（訂正・削除・規程）→ US4（AI）
2. フェーズの区切りごとにコミットし（メッセージにタスク ID）、`/usage` を控える

## Notes

- 部下への渡し方: 1 体に「関連するタスクのまとまり」を渡す。同じ層・隣り合うもの（T006+T007、T009+T010、T011+T012、T014+T015、T016+T017、T019+T020+T021、T024〜T026、T028+T029、T031+T032）はまとめてよい
- implementer-hard（Opus）に渡す: 誤ると証憑や履歴が壊れる整合性の難所だけ
  - T009（`TRC1` の暗号化の形式、INV-61）
  - T012（追加の全部か無か・重複、INV-62）
  - T027（履歴の完全性、INV-63、SC-005）
  - T024・T025（バックアップ → 復元の往復、INV-68）
- T020・T021（INV-64）は implementer から始め、整合性の判断が要ると報告されたときだけ implementer-hard に回す
- 迷ったら implementer に渡し、テストやレビューで落ちたときに implementer-hard に上げる
- implementer に渡す: 上の hard の候補と、メイン・利用者が行う T040〜T045 以外のすべて
- サンドボックスではローカルのポートを開けず `sips` も使えない。dev サーバー、E2E、`sips` のゲート、スマホ・ts.net の確認は利用者の端末で行う（T040〜T044）
- 完了の [X] はメインがまとめて付ける
