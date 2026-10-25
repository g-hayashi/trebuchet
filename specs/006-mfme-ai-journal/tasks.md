---

description: "Task list for 006-mfme-ai-journal"
---

# Tasks: 明細の取込と AI 仕訳

**Input**: Design documents from `specs/006-mfme-ai-journal/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/http-api.md](./contracts/http-api.md), [quickstart.md](./quickstart.md)

**Tests**: 必須。Constitution V（テストファースト）により、各タスクでテストを先に書き、**失敗することを確認してから**実装する。不変条件 INV-40〜47（data-model §5）は fast-check のプロパティテストで検証する（`fc.assert(fc.property(...))` を直接呼ぶ）。

**Organization**: ユーザーストーリーごとにまとめる。「テスト → 実装」の対は同じタスクの中に置き、1体の部下にまとめて渡す。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列にしてよい（別ファイルで、未完了のタスクに依存しない）。並列に実行する指示ではない（部下は1体ずつ順番に動かす）
- **[Story]**: 対応するユーザーストーリー（US1〜US5）
- 参照: `R` は research.md、`INV` と `§` は data-model.md、`H:§` は contracts/http-api.md の節、`FR`・`SC` は spec.md

## 全タスク共通のルール

- **[AGENTS.md](../../AGENTS.md) の「開発の進め方」「データと一時ファイル」に従う**（UnitOfWork、`auditEntry`、`dates.ts`、テストの共通部品、エラーコードを変えるときの grep、旧版との互換を考えない）。以下はこの機能に固有の規則
- **実データを使わない**。MF ME の貼り付け・HTML は合成のフィクスチャ（`packages/domain/test/fixtures/mfme/`、`apps/server/test/fixtures/mfme/`）。実在の店名・口座名・個人名を書かない
- **金額は整数**。明細の `amount` は符号つき（入金が正）。仕訳の金額は絶対値、税額は 001 の `computeInclusiveTax`
- **AI・ブラウザ・`fm` は CI で呼ばない**。domain は `SuggestionProvider` の偽物、server は `fetch`・`spawn`・取得器を差し替える。Playwright でブラウザを起動するテストは `describe.skipIf`（Chromium がないとき）
- **外部へ送る内容は `buildAiPayload`（R11）だけで作る**。ほかの場所で明細の項目を AI に渡さない。API キーをログ・応答・DB に出さない
- 型を変えるときの grep の対象に `JOURNAL_SOURCES`・`JournalSource` を含める。004 の `auth-coverage.test.ts`（INV-29）が新しいルートも検査する
- マイグレーションは `pnpm --filter @trebuchet/db exec drizzle-kit generate --name statements --config drizzle.tenant.config.ts`（STRICT に置き換え）、トリガーは `--custom --name statements_integrity`、registry は `--config drizzle.registry.config.ts --name ai_settings`

---

## Phase 1: Setup

- [X] T001 `playwright`（実行時）を `apps/server` の dependencies に足す（利用者が 2026-10-25 に承認。R13）。メインが `pnpm --filter @trebuchet/server add playwright` を実行し、`pnpm exec playwright install chromium` の手順を quickstart §3.4 の前置きに足す

---

## Phase 2: Foundational（全ストーリーの前提）

- [X] T002 [P] テスト先行で Zod スキーマとエラーコードを足す（契約 H:§1〜§7）。`packages/schema/src/statements.ts`（`StatementAccount`: usage は `business`・`mixed`・`private`、`private` は `accountId` なし・ほかは必須。`StatementImportPreview`・`StatementView`・`Candidate`・`InferenceRuleView`・`EvalRun`・各入力）、`ai.ts`（`AiSuggestion`: `{ accountCode, taxCategory, purpose: "business"|"private", confidence: 0〜100 の整数, reason: 200 字以内 }`、`AiSettings`）、`journals.ts` の `JOURNAL_SOURCES` に `statement`、`errors.ts` に13種と `apps/server/src/errors.ts` の `ERROR_STATUS`。テスト `packages/schema/test/statements.test.ts`
- [X] T003 テスト先行で表とマイグレーションを足す（data-model §1〜§3、R12・R16）。`packages/db/src/schema/tenant.ts` に10表（§1.1〜§1.10 の列・CHECK）、`0007_statements.sql`（STRICT）、`0008_statements_integrity.sql`（§3 の削除・更新の禁止、`statement_links` の部分 UNIQUE 2 つ、行と仕訳の一致の検査、`journals_source_*` を DROP して `statement` を含めて作り直す）、`registry.ts` に `ai_settings`（§2.1）と `0003_ai_settings.sql`、`backup/snapshot.ts` の `EXCLUDED_REGISTRY_TABLES` に `ai_settings`。テスト `packages/db/test/statement-schema.test.ts`（STRICT、各トリガー、部分 UNIQUE、`source = statement` を受け `bogus` を拒否）、バックアップのテストに `ai_settings` を含めないことを足す
- [X] T004 ポートと UnitOfWork（data-model §6、005/T004 と同じ形）。`packages/domain/src/ports.ts` に `StatementStore`（この時点のメソッドは `appendStatementAudit` だけ。ほかは各ストーリーで足す）、`StatementUnitOfWork`（`{ ledger, masters, statements }`）、`SuggestionProvider`（`available(): Promise<boolean>`、`suggest(payload, context): Promise<Result<unknown>>`）。`packages/db/src/statement-repository.ts` に `DrizzleStatementStore`・`DrizzleStatementUnitOfWork`、`packages/domain/test/fakes/statements.ts` に `FakeStatementUnitOfWork`・`FakeSuggestionProvider`（`fakes.ts` から再エクスポート）。テスト `packages/db/test/statement-uow.test.ts`（中で仕訳を作った後に例外 → 仕訳も残らない）
- [X] T005 [P] テスト先行で共通の純関数（R3・R9・R15）。`packages/domain/src/statements/normalize.ts` の `normalizeContent`（NFKC → 大文字 → 空白を除く → 3 桁以上の数字を `#`）、`keys.ts` の `stableKey(row, occurrence)`・`assignKeys(rows)`（キーは `口座名|日付|金額|正規化した内容|n` の文字列そのもの。ハッシュにしない。入力の sha256 は 002 と同じく server で計算して渡す）、`status.ts` の `statementStatus(statement, links, journals)`。あわせてテストの共通部品 `packages/domain/test/statements-arbitraries.ts`（貼り付けの行・明細・口座のジェネレーター。T008 以降も使う）を作る。テスト `packages/domain/test/statements/keys.property.test.ts`（行の順を入れ替えてもキーの集合が同じ）、`status.property.test.ts`（INV-44: 取消で `unprocessed`、`corrects` をたどって `registered`、除外で `excluded`）
- [X] T006 server の配線。`apps/server/src/routes/statements.ts` の `statementRoutes({ clock })` と `routes/ai-settings.ts` を空の Hono で作り `app.ts` に登録、`deps.ts` に `statementDeps(db)`（UnitOfWork、`ids`、`SuggestionProvider` を端末内・外部の2つ受ける口。実物は T025 で差す。それまでは「使えない」を返す既定）。`AppType` で web の `hc<AppType>` が型検査を通ることを確かめる

**Checkpoint**: `pnpm vitest run --project schema`、`--project domain`、`--project db`、`--project server` が通る

---

## Phase 3: User Story 1 - 明細を取り込む (Priority: P1) 🎯 MVP

**Goal**: 貼り付けで明細を取り込み、口座を対応づけ、重複なく未処理の一覧に加える

**Independent Test**: 合成の貼り付けを取り込み、件数・金額が元と一致し、同じ内容の再取込で新規 0 件

- [X] T007 [P] [US1] テスト先行で `packages/domain/src/statements/paste.ts` の `parseMfmePaste(text, year)` と列の対応表 `MFME_COLUMNS`、型 `PastedRow`（`{ accountName, date, content, amount, categoryMajor?, categoryMinor?, memo?, transferFlag, externalId? }`。`externalId` は自動取得だけが持つ）を実装する（R2）。見出しの名前で列を対応づけ、見出しがなければ既定の並び。`MM/DD(曜)` に年を補う。金額の `,`・`−`・`-` を読む。読めない行は `{ line, reason }`、必須の列が欠ければ `STATEMENT_PASTE_UNREADABLE`。合成のフィクスチャ `packages/domain/test/fixtures/mfme/paste-basic.txt`（入金・出金・返金・カードの引落・振替の印・合計の行・3 口座）、`paste-no-header.txt`、作り方の `README.md`。テスト `packages/domain/test/statements/paste.test.ts`
- [X] T008 [US1] テスト先行で `packages/domain/src/statements/plan.ts` の `planStatementImport(rows, existing, accounts)` を実装する（R3・R14、FR-004〜006）。行ごとに `new`・`existing`・`changed`（`external_id` が同じで内容が違う。変更前後 `{ before, after }` を持つ）、警告 `POSSIBLE_DUPLICATE`（口座・金額・内容が同じで日付 3 日以内、または口座・日付・内容が同じで金額が違う）、未対応の口座の名前、入出金の合計、期間、`countNew`。テスト `plan.test.ts`、`import.property.test.ts`（INV-40: 同じ入力の2回目は新規 0 件、行の順に依らない）
- [X] T009 [US1] テスト先行でユースケースと永続化（R4・R14・R18、§1.1〜§1.3、FR-002〜007）。`usecases/statements.ts` に `listStatementAccounts`・`saveStatementAccount`（変更を監査に。未処理の候補の作り直しは US2 の T014 で足す。`rebuilt` は 0）・`previewStatementImport`・`commitStatementImport`（入力の sha256 と `countNew` の照合で `STATEMENT_PLAN_CHANGED`、未対応で `STATEMENT_ACCOUNT_UNMAPPED`、回と明細を1つの UnitOfWork で。`changed` の行は `changed_json` を書き、`changed_ack_at` を NULL に戻す）・`listStatementBatches`。`StatementStore` と `DrizzleStatementStore`・偽物に読み書きを足す。テスト domain の `statements/import.test.ts`、`packages/db/test/statement-import.test.ts`（往復、障害の注入で回も明細も残らない＝INV-47 の取込の側）
- [X] T010 [US1] テスト先行で H:§2.1・§2.2・§3.1〜§3.3 のルートを `routes/statements.ts` に足す（`source.kind = "mfme_fetch"` は US4 まで `VALIDATION`）。テスト `apps/server/test/statements.import.api.test.ts`（プレビュー → 確定 → 再取込で 0 件、未対応の 422、プレビュー後に入力を変えた 409、読めない貼り付けの 422）
- [X] T011 [US1] web の画面。`apps/web/src/features/statements/`（`api.ts`、`PasteImport`（テキストと年）、`ImportPreview`（件数・期間・合計・読めない行・重複の疑い・変更ありの行の変更前後）、`AccountMappingForm`（用途・種類・科目・補助科目。`private` は科目を出さない））、`routes/e/$entityId/statements/import.tsx`、`mock-api.ts` に既定の応答、メニューに「明細」。テスト `apps/web/test/routes/statements-import.test.tsx`。`pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成

**Checkpoint**: quickstart §2.1 を合成の値で通せる

---

## Phase 4: User Story 2 - 仕訳の候補を確かめて登録する (Priority: P1)

**Goal**: 候補（既存の仕訳・振替）を示し、承認したものだけを登録・結びつけ、取消で未処理に戻す

**Independent Test**: 承認した明細だけが仕訳になり、除外・未承認の明細は帳票に現れない。仕訳の取消で未処理に戻る

- [X] T012 [P] [US2] テスト先行で `packages/domain/src/statements/journal-shape.ts` の `journalShape({ statement, account, purpose, counter, accounts })` と定数 `STATEMENT_ACCOUNT_CODES`（普通預金 `1020`・未払金 `2020`・事業主借 `3010`・事業主貸 `3090`。`findAccountByCode` で引く）を実装する（R5 の表の7行、返金、FR-016）。テスト `journal-shape.property.test.ts`（INV-42: 明細の口座の行の金額 = |amount|、向き、貸借一致、`private`・私用は `null`）
- [X] T013 [P] [US2] テスト先行で `transfer.ts` の `findTransferPair(statement, candidates)`（反対の口座・同額・逆向き・7 日以内。R6）と `match-existing.ts` の `matchExistingJournal(statement, account, journals, linkedLineIds)`（同じ科目・補助科目・向き・金額、日付の差 7 日以内、未結びの行、差で確信度を下げる。R7）を実装する。対のない引落（`transfer_flag` が立ち、対が見つからない）は、内容からカードの支払いらしいと推定する `inferUnpairedTransfer(statement)`（どのカードかはルールが決める（T019）。ルールがなければ `none`）。テスト `transfer.test.ts`（対のない引落の推定を含む）、`match-existing.test.ts`（定期仕訳の家賃、取消済みの仕訳は対象外、結びつき済みの行は対象外）
- [X] T014 [US2] テスト先行で候補の作成と設定（R8、§1.4・§1.8、FR-012・013・018・019・021a・027）。`usecases/statements.ts` に `buildCandidates(deps, statementIds?)`（match → transfer → `none`。ルールの段は T019 が足す。0 円は候補なし。`needsAi` を返す）と、`saveStatementAccount` での未処理の候補の作り直し（T009 の `rebuilt` を埋める）、`listStatements`（`StatementView`、状態は `statementStatus`、`changed: { before, after } | null`）、`getStatementSettings`・`saveStatementSettings`（`statement_settings`。0〜100 の整数、変更を監査に）。ストアに候補と設定の読み書き。テスト domain の `statements/candidates.test.ts`、`statements/settings.test.ts`、`packages/db/test/statement-candidates.test.ts`
- [X] T015 [US2] テスト先行で承認・除外・結びつきの取消（R5〜R7・R15・R16、§1.5、H:§4.4・§4.9、FR-014〜018・020・021・021a）。`approveCandidate`（検査 → **その明細の有効な結びつきの仕訳が取消済み（訂正されていない）なら先に結びつきを失効** → `createJournal(..., { source: "statement" })` または結びつけ先の検査 → `statement_links`（振替の対は2行に）→ 監査を1つの UnitOfWork。直した案の明細の口座の行の合計が違えば `STATEMENT_AMOUNT_MISMATCH`。税区分が候補にないときは 001 の `defaultTaxCategory`）、`approveBulk`（明細ごとに UnitOfWork、失敗は理由つきで残す）、`excludeStatement`・`unexcludeStatement`、`acknowledgeChange`（`changed_ack_at` を書く）、`unlinkStatement`（`matched` の結びつきだけを `reason` つきで外す。`created` は `VALIDATION`、仕訳の取消は 001）。テスト `statements/approve.test.ts`、`approve.property.test.ts`（INV-41: 承認以外の操作列で仕訳帳・試算表が不変、INV-43、INV-47 の承認の側、突合: 承認した明細の、明細の口座の行の動きの合計 = その明細の金額の合計、仕訳の取消 → 再承認でも有効な結びつきは高々1件で `registered`）、`packages/db/test/statement-approve.test.ts`（障害の注入、部分 UNIQUE で `JOURNAL_LINE_ALREADY_LINKED`）
- [X] T016 [US2] テスト先行で H:§4.1・§4.2・§4.4〜§4.9 と §6.3（`/statement-settings`）のルート、001 の `GET /journals/:journalId` に `statements: { statementId, kind }[]` を足す。テスト `apps/server/test/statements.approve.api.test.ts`（承認 → 仕訳帳に `source = statement`、締め済みの 409、除外・除外の取消、まとめて承認の `failed`、仕訳の取消後に `unprocessed` → 再承認、`matched` の結びつきの取消と `created` の `VALIDATION`、設定の往復と範囲外の `VALIDATION`）
- [X] T017 [US2] web の画面。`features/statements/` に `StatementList`（状態・口座で絞る、候補・判定・確信度・根拠・方法）、`CandidateEditor`（科目・税区分・取引先・摘要の修正、行の分割と合計の検査、「既存の仕訳と結びつける」）、`BulkApprove`、除外・取消・「確認した」・「結びつきを外す」（理由つき）、`StatementSettingsForm`（まとめて承認・外部へ送るしきい値）。`routes/e/$entityId/statements/index.tsx`、`routes/e/$entityId/statements/settings.tsx`、仕訳の詳細に元の明細へのリンク。承認の後は `invalidateLedger`。`mock-api.ts` に既定の応答、`pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成。テスト `apps/web/test/routes/statements.test.tsx`、`statements-settings.test.tsx`

**Checkpoint**: quickstart §2.2〜§2.4・§2.6 を合成の値で通せる（MVP）

---

## Phase 5: User Story 3 - 承認の結果から推定のルールを育てる (Priority: P2)

**Goal**: 承認からルールを作り直し、過去の仕訳から初期のルールを作り、候補に使う

**Independent Test**: 同じ内容の2件目がルールの候補になり、違う科目で承認するとルールが変わる

- [X] T018 [P] [US3] テスト先行で `packages/domain/src/statements/rules.ts` の `ruleFor(statement, rules)`（同じ口座のルールを優先、`paused` は使わない）、`ruleConfidence(rule)`（`min(95, 50 + 10×hits) − 20×overrides`、0 未満は 0）、`learnRule(rule | null, approval)`（新規・`hits` の加算・違う内容で `overrides` を加算して置き換え）、`seedRules(journals, accounts)`（R9 の条件: 2 件以上かつ 3/4 以上）を実装する。テスト `rules.test.ts`、`rules.property.test.ts`（確信度は 0〜95 の整数、学習の後のルールは承認の内容と一致）
- [X] T019 [US3] テスト先行でルールの組み込み（R9、§1.6・§1.7、FR-022〜024）。`buildCandidates` の transfer と `none` の間にルールの段（T013 の対のない引落は、ルールがあればどのカードかを決める）、`approveCandidate` に学習（同じ UnitOfWork で `inference_rules` と `inference_rule_history`。`learn: false` なら学ばない）、`seedRulesFromJournals`（`dryRun`）・`updateRule`・`pauseRule`・`resumeRule`・`listRules`・`ruleHistory`。ストアに読み書き。テスト domain の `statements/rules-usecase.test.ts`（INV-41 をルールの更新を含めて: 承認以外の操作列で帳簿が不変、INV-47: 承認とルールの更新が全部か無か）、`packages/db/test/statement-rules.test.ts`（UNIQUE、履歴の追記のみ、承認の途中の障害でルールも残らない）
- [X] T020 [US3] テスト先行で H:§5 のルートと web の `features/statements/RuleList`（一覧・編集・停止・再開・履歴・初期作成の案と実行）、`routes/e/$entityId/statements/rules.tsx`、`mock-api.ts` に既定の応答、`pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成。テスト `apps/server/test/statements.rules.api.test.ts`、`apps/web/test/routes/statements-rules.test.tsx`

---

## Phase 6: User Story 4 - MF ME から明細を取得する (Priority: P2)

**Goal**: server が開くブラウザで利用者が認証し、明細を読んで US1 のプレビューへ渡す

**Independent Test**: 合成の HTML から読んだ行が同じ件数・金額でプレビューに出る。失敗で何も加わらず、理由と貼り付けの案内が出る

- [X] T021 [US4] テスト先行でジョブと取得の入口（R13・R14、H:§3.4・§3.5）。`apps/server/src/lib/jobs.ts`（in-memory、同時に1つ、`waiting_login`・`running`・`done`・`failed`、2つ目は `JOB_RUNNING`）、取得器のインターフェース `MfmeFetcher`（`fetch(range, onStatus): Promise<PastedRow[]>`）、§3.4・§3.5 のルート、§3.1・§3.2 の `source.kind = "mfme_fetch"`（ジョブの行を使う。なければ `JOB_NOT_FOUND`）。テスト `apps/server/test/statements.fetch.api.test.ts`（偽の取得器: 成功 → プレビュー、失敗 → 明細 0 件と `failedAccounts`）
- [X] T022 [US4] テスト先行で Playwright の取得器（R13、FR-008〜010）。`apps/server/src/lib/mfme/fetcher.ts`（`chromium.launch({ headless: false })`、`browser.newContext()`（保存しない）、ログインの完了を最大 5 分待つ、月ごとに入出金の画面、閉じたら `failed`、終わったら必ず閉じる）、`dom.ts`（行の読み取りとセレクター。**実画面の DOM は未解析なので暫定**。1か所に置く。T032 で仕上げる）。合成の `apps/server/test/fixtures/mfme/cf-month.html`。テスト `apps/server/test/mfme-dom.test.ts`（`page.setContent`、`describe.skipIf`）、`mfme-fetcher.test.ts`（偽の `launch` で、`browser.newContext()`（永続でない文脈）を使い、`launchPersistentContext` やユーザーデータの場所を使わないこと）。web の `features/statements/MfmeFetch`（期間、状態の表示、失敗で貼り付けへの案内）とテスト

---

## Phase 7: User Story 5 - AI で候補を作り、精度を測る (Priority: P3)

**Goal**: ルールに一致しない明細を端末内 → 外部の AI で推定し、評価で一致率を比べる

**Independent Test**: 偽の AI で順序と外部への送信の条件が仕様どおり。形に合わない出力は `none`。評価で項目ごとの一致率が出る

- [ ] T023 [P] [US5] テスト先行で `mask.ts` の `maskContent`・`buildAiPayload(statement, account)`（許可した項目だけ。R11）と `prompt.ts` の `buildPrompt(payload, accounts, taxCategories)`・`parseSuggestion(raw, accounts)`（`AiSuggestion` で検証、相手になりうる有効な科目と既知の税区分だけ。R10）を実装する。テスト `mask.property.test.ts`（INV-45: 任意の内容・口座名・メモで、4 桁以上の数字・口座名・メモ・振込の名義が出ない）、`prompt.property.test.ts`（INV-46: 任意の JSON で、通ったものは有効なコードだけ）
- [ ] T024 [US5] テスト先行で `usecases/inference.ts` の `inferWithAi(deps, statementIds)`（R8: 端末内が使えればまず端末内、確信度 < `external_threshold` で外部が有効なら外部、端末内が使えなければ外部が有効なら外部、無効なら `none`。結果を候補に保存、`model` を記録。`external_threshold` は T014 の設定から読む）。テスト `statements/infer.test.ts`（`FakeSuggestionProvider` で全分岐、外部に渡るのは `buildAiPayload` の結果だけ）
- [ ] T025 [US5] テスト先行で server の AI（R10・R12、FR-027・027a）。`lib/ai-client.ts`（OpenAI 互換の `SuggestionProvider`。`fetch` で `/v1/chat/completions`、`response_format`、時間切れ 30 秒・60 秒、API キーはキーチェーン `trebuchet-ai-api-key`）、`lib/fm-server.ts`（`fm available`、`fm serve --host 127.0.0.1 --port`、`/health` を待つ、`startup.ts` の終了時に止める）、`packages/db/src/ai-settings-repository.ts`（registry の `ai_settings`）、`statementDeps` に端末内・外部の `SuggestionProvider` を配線（T006）、H:§4.3・§7 のルート（URL は `https://` か localhost）。テスト `packages/db/test/ai-settings-repository.test.ts`、`apps/server/test/ai-client.test.ts`（偽の `fetch`）、`fm-server.test.ts`（偽の `spawn`）、`ai-settings.api.test.ts`（API キーを返さない、`AI_NOT_CONFIGURED`。偽の `SecretStore` で、API キーがキーチェーンにだけ入り、応答・ログ・DB に出ないこと）。復元（`packages/db/src/backup/restore.ts`）で `app_settings` と同じく `ai_settings` を端末の値のまま引き継ぐ
- [ ] T026 [US5] 前提に T021（`lib/jobs.ts`）。テスト先行で評価（R17、§1.9、FR-029、SC-004）。`evals.ts` の `evaluate(samples, splitDate, infer)`（基準日より前からルールを作り、以後を推定、項目ごと・方法ごとの一致率を千分率の整数で）、`runEvaluation`（`includeAi`、外部は有効なときだけ）、`eval_runs` の保存、H:§6.1・§6.2（ジョブ）。テスト `statements/evals.test.ts`、`apps/server/test/statements.evals.api.test.ts`
- [ ] T027 [US5] web の画面。`features/statements/` の「AI で推定」（`needsAi` を 10 件ずつ §4.3 に送り進捗を出す）、`EvalRuns`（前回との差）と `routes/e/$entityId/statements/evals.tsx`、`features/ai-settings/AiSettingsForm` と `routes/settings/ai.tsx`（端末内の可否、外部の接続先・モデル・API キー。しきい値は T017 の画面）。`mock-api.ts` に既定の応答、`pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成。テスト `apps/web/test/routes/statements-ai.test.tsx`、`settings-ai.test.tsx`

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T028 E2E `apps/web/e2e/statements.spec.ts`（合成の貼り付け → 口座の対応 → 承認 → 仕訳帳 → 取消で未処理。ロケーターは `exact: true` でコンテナに絞る）。実行は利用者の端末
- [ ] T029 性能計測 `scripts/bench-statements.ts` と `package.json` の `bench:statements`（SC-006: 合成の 500 件の貼り付け → プレビュー → 候補の一覧が 5 秒以内。AI を除く。認証つきで、`scripts/lib/bench-common.ts` と `.tmp/` を使う。`bench-reports.ts` を参考にする）。実行は利用者の端末。US2（T016）の後
- [ ] T030 [P] 文書: `AGENTS.md` に「明細の取込と AI 仕訳（006）」の層の表と規則（`buildAiPayload` だけで送る、DOM は `dom.ts`、API キーはキーチェーン）、コマンド表に `pnpm bench:statements`、ADR `docs/adr/0009-ai-journal-suggestions.md`（R20。マスクは口座名・メモ・数字・振込の名義を除くが、利用名に混じる個人名は伏せきれない限界を書く）、`specs/INVARIANTS.md` に INV-40〜47、`docs/requirements.md` の FR-06・FR-07・NFR-07 の状態
- [ ] T031 quickstart §3 の実環境の確認（メインと利用者。貼り付けの形、`fm serve` の `response_format`、外部の AI のマスク、時間、精度）。違いは形だけを記録し、値を書かない。**貼り付けの形の確認は、US1 の実データでの仕上げ（quickstart §2.1 を実データで行う）の前提**。形が違えば `paste.ts` とフィクスチャを直すタスクを足す
- [ ] T032 MF ME の DOM の解析の後、`apps/server/src/lib/mfme/dom.ts` のセレクターと合成の `cf-month.html` を実画面に合わせて仕上げる（T031 の後、利用者の端末。メインと利用者）。**SC-007（1 か月分を 3 分以内）はこのタスクまで保留**。値・口座名は書かず、形だけを記録する
- [ ] T033 最終の全体検証（メイン）: `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @trebuchet/web build`

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup（T001）→ Foundational（T002〜T006）→ US1 → US2 → US3・US4・US5 → Polish
- T022 だけが T001（`playwright`）に依存する。T001 を後にしても T021 までは進められる

### User Story Dependencies

- **US1**: Foundational の後。T007 → T008 → T009 → T010 → T011
- **US2**: US1 の後（明細がないと候補を作れない）。T012・T013 → T014 → T015 → T016 → T017
- **US3**: US2 の後（承認から学ぶ）。T018 → T019 → T020
- **US4**: US1 の後なら US2・US3 と独立（プレビューへ渡すだけ）。T021 → T022
- **US5**: US2 の後（候補、承認、T014 のしきい値の設定がいる）。評価（T026）は US3 のルールと T021（`lib/jobs.ts`）を使う（US4 を保留しても T021 は先に行う）。T023 → T024 → T025 → T026 → T027

### Within Each User Story

- テスト → スキーマ → ドメイン → db → server → web
- テストが旧コードで落ちることを確かめてから実装する（部下が赤の確認を飛ばしたら、メインが `git stash` で確かめる）

### Parallel Opportunities

- T002・T005・T007・T012・T013・T018・T023・T030 が [P]（別ファイルで、未完了のタスクに依存しない）。実行は順番に行う

## Implementation Strategy

### MVP First（Foundational ＋ US1 ＋ US2）

1. Foundational（T002〜T006）
2. US1（T007〜T011）: 貼り付けで明細を取り込める
3. US2（T012〜T017）: 候補を確かめて登録できる。既存の仕訳と結びつけて二重計上を防ぐ
4. 合成の事業体で、承認した明細だけが仕訳になり、取消で戻ることを確かめる（INV-41〜44）

### Incremental Delivery

1. MVP → US3（ルール）で確かめるだけの明細を増やす（SC-001, SC-004）
2. US4（取得）は DOM の解析の後に実画面で仕上げる（T032。SC-007 はそれまで保留）
3. US5（AI）でルールに一致しない明細を減らす
4. フェーズの区切りごとにコミットし（メッセージにタスク ID）、`/usage` を控える

## Notes

- 部下への渡し方: 関連するタスクのまとまり（同じユーザーストーリーのテストと実装、同じファイルを触るタスク）を1体に渡す。タスクの行と、参照する節（R・§・INV・H:§）だけを渡す
- implementer に渡す: メインが行う T001・T031・T032・T033 以外のすべて（T028・T029 の実行は利用者の端末）
- implementer-hard の候補: T015（承認の全部か無か、INV-41・43・47 の性質テストの設計）。まず implementer に渡し、整合性の判断が要ると報告されたときだけ implementer-hard に回す
- 完了の [X] はメインがまとめて付ける
- サンドボックスではローカルのポートを開けない。dev サーバー・E2E・`fm serve`・Playwright のブラウザの確認は利用者の端末で行う
