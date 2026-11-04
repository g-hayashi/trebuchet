---

description: "Task list for 011-ui-overhaul"
---

# Tasks: 画面の作り直し（日々の使いやすさ）

**Input**: Design documents from `specs/011-ui-overhaul/`

**Prerequisites**: [plan.md](./plan.md)（Q1〜Q3 の答えは記録済み、2026-11-03）、[spec.md](./spec.md)（D1〜D5 を反映済み）、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)

**Tests**: 必須。Constitution V（テストファースト）により、各タスクでテストを先に書き（画面は既存の web のテストを新しい形に直し）、**失敗することを確かめてから**実装する。不変条件 INV-69〜72（data-model §4）は fast-check の性質テストで検証する（`fc.assert(fc.property(...))` を直接呼ぶ）。

**Organization**: ユーザーストーリーごとにまとめ、各ストーリーの中は 下の層（schema・domain・db・server）→ web の順（plan「US ごとの変更の層」）。「テスト → 実装」の対は同じタスクの中に置き、1 体の部下にまとめて渡す。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列にしてよい（別ファイルで、未完了のタスクに依存しない）。並列に実行する指示ではない（部下は 1 体ずつ順番に動かす）
- **[Story]**: US1 骨組み・ホーム、US2 仕訳、US3 明細、US4 証憑、US5 請求、US6 帳票、US7 決算・申告、US8 マスタ・期間、US9 設定、US10 スマホ、US11 AI
- 参照: `R` は research.md、`§` と `INV` は data-model.md、`H:` は contracts/http-api.md（§1 足す、§2 変える、§3 消す、§4 エラーコード）、`UI:` は contracts/ui-shell.md（§1 ヘッダー〜§7 主な操作）、`Q:` は quickstart.md

## 全タスク共通のルール

- **[AGENTS.md](../../AGENTS.md) の「開発の進め方」「データと一時ファイル」に従う**（テスト先行、`TenantUnitOfWork`、`respond`、web の `features/<機能>/api.ts` と `invalidateLedger`、新しい API を呼ぶ画面は `mock-api.ts` に既定の応答を足す、ルートを足し・消したら `pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成してから typecheck、マイグレーションの STRICT と `--custom`、エラーコード・共有の型を変えるときの `grep -rn <値> packages apps scripts`、部下のテストの範囲）
- この機能に固有: **依存（npm）を足さない**（combobox・toast・Sheet・Steps は自前、R2）。帳簿の不変条件 INV-1〜68 と 001 の仕訳の API は変えない（かんたん入力も 2 行の `JournalInput`、R5）。**web に業務ルールを置かない**（税区分の既定は `schema/tax-defaults.ts`、件数・合計・並びは server）。新しい帳簿の API は認証と解錠を要求し、`apps/server/test/auth-coverage.test.ts`（INV-29）に足す（FR-063）
- **画面の文言・メニューの名前は contracts/ui-shell.md が正本**。web のテスト・E2E はその名前で `getByRole` し（`exact: true`）、変えるときは文書とテストを同時に直す（R18）。旧 URL の転送は作らない
- マイグレーションは最新が `0015_receipts_integrity`。各タスクで生成した順に番号が付く（data-model §1 の 0016・0017 は目安）。新しい表は `) STRICT;` に置き換える
- AI を呼ぶテストは偽の `fetch`・`SuggestionProvider` を使う（`fm`・外部の AI を呼ばない）。`eval:statements` の結果は `.tmp/eval-statements/` に件数と割合だけ（R10）
- 実データ（`work/`・`data/`）は扱わない。手動の確認の記録に値・取引先名を書かない

---

## Phase 1: Setup

- [X] T001 （メイン）`.gitignore` に `bak/` を足し（R16、FR-056）、`specs/INVARIANTS.md` に INV-69〜72 の行を data-model §4 の文で足す

---

## Phase 2: Foundational（全ストーリーの前提）

**Purpose**: 依存を足さずに作る共通の部品（R2）。各ストーリーの画面がこれを使う

- [X] T002 [P] テスト先行で `apps/web/src/components/ui/toast.tsx`（`ToastProvider`・`useToast()`。成功は `role="status"`・`aria-live="polite"`、失敗は `role="alert"`、画面の上に固定、5 秒で消える。UI: §5）を作り、`__root.tsx` に Provider を置き、`components/ui/save-notice.tsx` を中で `useToast` を呼ぶ形に置き換える（呼び出し側 26 ファイルは直さない。FR-005）。テスト `apps/web/test/components/toast.test.tsx`。既存の web のテストのうち `SaveNotice` の文言を見るものが落ちれば直す
- [X] T003 [P] テスト先行で `apps/web/src/components/ui/sheet.tsx`（既存の `radix-ui` の Dialog を右から出す。`md` 未満は全画面）と `components/ui/steps.tsx`（①〜④ の段階と `aria-current="step"`）を作る（R2）。テスト `apps/web/test/components/sheet-steps.test.tsx`
- [X] T004 [P] テスト先行で `apps/web/src/components/ui/combobox.tsx`（WAI-ARIA の combobox: `input` + `listbox`、`aria-activedescendant`、↑↓ で選び Enter で確定して `onCommit` で次の欄へ、絞り込みは呼ぶ側の `match(option, query)`。R2）を作る。テスト `apps/web/test/components/combobox.test.tsx`（キーボードだけの選択、確定で次の欄にフォーカス、0 件の表示）

**Checkpoint**: 共通の部品がそろい、既存の web のテストが通る

---

## Phase 3: User Story 1 - ホームと骨組み (Priority: P1) 🎯 MVP

**Goal**: ヘッダー・メニュー・トップの移動を作り直し、ホームに今日やること・今期の数字を出す（FR-001〜010、SC-001〜003）

**Independent Test**: spec US1 の Independent Test。web のテストでヘッダー・メニュー（UI: §1・§2）、ホームの件数・0 件・項目ごとの失敗（UI: §3）、server のテストで `GET /home` の値が帳票と一致（INV-72）

- [X] T005 [US1] **（R18。US1 の最初）** メニューの名前に依存するテストを先に直す: `apps/web/e2e/helpers/nav.ts` の `openNav` と `apps/web/test/routes/entity-nav.test.tsx` を UI: §1・§2 と R1 の表の名前・`aria-label` にし、赤を確かめる。続けて `apps/web/src/components/layout/AppHeader.tsx`（ロゴ・事業体の名前のリンク、`#entity-switcher`、右は「設定」と「施錠してサインアウト」だけ、確認のダイアログの文は R17。施錠中・未サインインは右を出さない）と `components/layout/EntityNav.tsx`（R1 の 1 段目・2 段目、1 項目のグループを作らない、「帳票」は損益計算書）を作り、`routes/__root.tsx` と `routes/e/$entityId/route.tsx` の `NAV` を置き換える。まだないルート `e/$entityId/settings.tsx`・`receipts/new.tsx`・`deferred-assets/index.tsx` を R1 の末尾のとおり足し、`reports/index.tsx` の転送先を損益計算書にする。`routeTree.gen.ts` を再生成
- [X] T006 [US1] テスト先行でトップの移動を直す（R4、FR-001・010）: `apps/web/src/routes/index.tsx` と `features/entities/EntitySwitcher.tsx` の `entityToRestore` を、事業体 1 件ならそのホーム、2 件以上なら一覧（最後に開いたものを上に、目立たせる）、0 件なら作成の案内にし、ロゴ・事業体の名前は最後に開いた事業体のホーム（見つからなければ `/`）へ。テストは `apps/web/test/routes/entity-nav.test.tsx` に足す（0・1・2 件）
- [X] T007 [US1] テスト先行でホームの要約の下の層（R3、§2.1、INV-72）: `packages/schema/src/home.ts`（`HomeSummary`・`Section<T>`、`CASH_AND_DEPOSIT_CODES`）、`packages/domain/src/home/summary.ts`（純関数）と `usecases/home.ts` の `getHomeSummary`（求め方は R3 と §2.1 の表。項目ごとに例外・`err` を `{ status: "error", code }` にする。FR-009）、`ReceiptStore` に `count(query)`（ポート、`packages/db/src/receipt-repository.ts`、`packages/domain/test/fakes/` の偽物）。テスト: `packages/domain/test/home/summary.test.ts`（各件数・0 件・1 項目の失敗）と INV-72 の性質テスト `home/summary.property.test.ts`（`ledger-setup.ts` の任意の貸借一致の仕訳で、figures と損益計算書・貸借対照表が一致）、db の `count` のテスト
- [X] T008 [US1] テスト先行で `apps/server/src/routes/home.ts`（`GET /entities/:id/home`、今日は `todayOf(clock)`。H: §1）を作り `createApp` に足す。テスト `apps/server/test/home.api.test.ts`（値が `reports/profit-and-loss`・`balance-sheet` の応答と一致、404、1 項目の失敗でほかが返る）と `auth-coverage.test.ts`
- [X] T009 [US1] テスト先行でホームの画面（UI: §3、FR-006〜008）: `apps/web/src/features/home/`（`api.ts`、`HomePage.tsx`）と `routes/e/$entityId/index.tsx`。今日やること（0 件は出さず、すべて 0 なら「残っている作業はありません」、押し先は UI: §3 の検索の引数つき URL）、今期の数字（会計期間がなければ登録の案内）、最近の仕訳、近道、「前回のバックアップ」（既存の `GET /api/backup/status`）・「最後の明細の取込」（なければ「まだありません」）、項目の失敗は「読み込めませんでした」と「再読み込み」。押し先の画面（明細・証憑・請求の一覧）が検索の引数 `status`・`link` を読むようにする（読まなければこのタスクで足す。T024・T026 は切替の見た目だけ）。`mock-api.ts` に `home` の既定の応答。テスト `apps/web/test/routes/home.test.tsx`

**Checkpoint**: メニューから各画面に 1 回で届き、ホームの数字が帳票と一致する

---

## Phase 4: User Story 2 - 仕訳の入力と一覧 (Priority: P1)

**Goal**: かんたん入力・科目の絞り込み・Enter の移動・下書き・履歴の候補・一覧のその場の訂正（FR-011〜018、SC-004・005）

**Independent Test**: spec US2 の Independent Test。web のテストでかんたん入力が 2 行の `JournalInput` を送る、Enter の移動、一覧の Sheet。INV-69

- [X] T010 [P] [US2] テスト先行で税区分の既定を 1 か所にする（R5）: `packages/schema/src/tax-defaults.ts` の `defaultTaxCategory` を作り、`packages/domain/src/journal.ts:49-60` はそれを import し、`apps/web/src/features/journals/JournalForm.tsx:62-80` の複製を消して schema を使う（表示の「自動（○○）」だけ。送るときは今どおり省く）。テスト `packages/schema/test/tax-defaults.test.ts`（今の domain のテストの表を移す）。domain・web の既存のテストが通ることを確かめる
- [X] T011 [P] [US2] テスト先行で科目の読み（R5、D3）: `packages/schema/src/account-readings.ts` の `ACCOUNT_READINGS`（seed `packages/domain/src/seed/accounts.individual.ts` の全コード → ひらがな）と `apps/web/src/lib/account-search.ts`（名前・コード・読みの NFKC の部分一致。利用者の科目は名前とコードだけ）。テスト: `packages/schema/test/account-readings.test.ts`（読みの形式）、`packages/domain/test/account-readings.test.ts`（seed 全コードとの一致）、`apps/web/src/lib/account-search.test.ts`
- [X] T012 [US2] テスト先行で履歴候補（R5、§2.2、H: §1）: `packages/schema/src/journals.ts` の `JournalSuggestion` は左右別の科目・税区分・取引先を保持（2026-11-03判断）。`packages/domain/src/journals/suggest.ts` の `suggestFromHistory(journals, query)` は全履歴の有効な借貸各1行から摘要正規化一致か左右の取引先一致、新しい順最大3件、6値の組で重複排除。`apps/server/src/routes/journals.ts` の `GET /journals/suggestions` は摘要200字まで・摘要か取引先必須、動的IDより前。テスト `packages/domain/test/journals/suggest.test.ts`、`apps/server/test/journals-suggestions.api.test.ts`、`auth-coverage.test.ts`
- [X] T013 [US2] テスト先行で仕訳の下書き（R6、§1.1、H: §1、INV-69）: schema の `JournalDraft`（§1.1 の形。行は 50 行まで、金額は整数か null、摘要は仕訳と同じ上限）、表 `journal_drafts`（`id INTEGER PRIMARY KEY CHECK (id = 1)`、`payload TEXT NOT NULL`、`updated_at TEXT NOT NULL`、STRICT。`packages/db/src/schema/tenant.ts` とマイグレーション）、db のリポジトリ、`packages/domain/src/usecases/journal-drafts.ts`（取得・置き換え・削除。監査の記録に書かない）、server の `GET/PUT/DELETE /journal-draft`（DELETE はなくても 204）。テスト: db の統合テスト（`tenant-store` の STRICT の確認を含む）、INV-69 の性質テスト（任意の仕訳と任意の下書きの操作の列で、試算表・仕訳帳・`HomeSummary.figures` が変わらない。domain の偽物と db）、`apps/server/test/journal-draft.api.test.ts`、`auth-coverage.test.ts`
- [X] T014 [US2] テスト先行で仕訳の一覧の件数・合計（R7、§2.3、H: §2）: `GET /journals` の応答に `summary: { count, amount }`（条件に合う全件。amount は各仕訳の借方合計の和。ページ送りと別に 1 回の `COUNT`・`SUM`）。schema の応答の型、db の問い合わせ、server。テスト: db（ページ送りをまたぐ件数・取消の扱いは今の一覧の条件のまま）、`apps/server/test/journals.api.test.ts` に足す
- [X] T015 [US2] テスト先行でかんたん入力（R5、FR-011〜013）: `apps/web/src/features/journals/QuickEntryForm.tsx`（日付・借方・貸方・金額・摘要、任意で取引先・タグと借方/貸方それぞれの税区分（2026-11-03判断）。科目と取引先は T004 の combobox と T011 の `account-search`、使用停止の科目・取引先を出さない。日付に `autoFocus`、Enter は次の欄・最後の欄で登録、登録の後は日付を残して借方へ。送るのは 2 行の `JournalInput`）を既定にし、`routes/e/$entityId/journals/new.tsx` で「詳細」（今の `JournalForm`、最後の行の金額を差額で埋める。入力済みの値は上書きしない）に切り替えられるようにする。主な操作は「登録」（UI: §7）。テスト `apps/web/test/routes/journals-new.test.tsx` を直す（キーボードだけで登録、送る本文、税区分の自動の表示）
- [X] T016 [US2] テスト先行で入力の画面の下書き・複製・履歴の候補（R5・R6、FR-014・015）: 新規の入力で変更から 1 秒待って `PUT /journal-draft`、登録の成功で `DELETE`、開いたとき下書きがあれば「続ける」「捨てる」（訂正は対象外）。`journals/new?from=<journalId>` で日付を今日にして写す（2 行はかんたん、3 行以上は詳細）。摘要・取引先の入力から 300 ms 待って `GET /journals/suggestions` を呼び、候補を選ぶと科目・税区分・取引先が入る。`features/journals/api.ts`、`mock-api.ts`。テスト `journals-new.test.tsx` に足す
- [X] T017 [US2] テスト先行で仕訳の一覧と中身（R7・R8、FR-016〜018）: `routes/e/$entityId/journals/index.tsx` の検索のボタンをなくし条件の変更から 300 ms 待って読み直す、期間の初期値は今の会計期間、`summary` の件数・合計を出す。行（行全体がボタン）で `Sheet` に中身と履歴、「訂正」（Sheet の中で `JournalForm` の訂正の形）・「取消」・「複製して入力」（可否は server の応答。締めた年度は今の「当年度に訂正仕訳を起票」）。中身の部品を `journals/$journalId.tsx` と共有する。定型の理由 `features/journals/reasons.ts`（誤記の訂正、金額の誤り、科目の誤り、二重の登録、取引の取消）を `components/reason-dialog.tsx` の選択肢にする（選ぶと欄に入り編集できる。理由は必須のまま）。訂正・取消の後は `invalidateLedger`。テスト `journals.test.tsx`・`journal-detail.test.tsx` を直す

**Checkpoint**: ホームから入力・一覧に 1 回で届き、キーボードだけで登録、一覧の行から訂正まで 2 回

---

## Phase 5: User Story 3 - 明細のステップ・自動の候補・ルール (Priority: P1)

**Goal**: 取込から承認までのステップ、取込の直後の候補、1 件ずつの確認、ルールの自動の作成と利用者の管理の区別、評価の削除（FR-019〜025、SC-006）

**Independent Test**: spec US3 の Independent Test。INV-71。web のテストでステップと「承認して次へ」

- [ ] T018 [US3] テスト先行でルールの `managed_by`（R9、§1.2、H: §2、INV-71）: 列 `managed_by TEXT NOT NULL DEFAULT 'auto' CHECK (managed_by IN ('auto','user'))`（`schema/tenant.ts` とマイグレーション）、schema の `InferenceRule.managedBy: "auto" | "user"`、承認の入力から `learn` を消し承認のたびに今の学ぶ条件（`packages/domain/src/usecases/inference-rules.ts:98-107`）で `learnRule`、`PATCH /inference-rules/:ruleId` で科目・税区分・状態を変えたら `user`（戻さない）、`learnRule` と `seedRulesFromJournals` は `user` の行を変えない（`seedRulesFromJournals` の今の「同じ内容のルールがあれば飛ばす」はそのまま）。`learn` を参照するテストを `grep -rn "learn" packages apps` で探して直す。テスト: INV-71 の性質テスト（`packages/domain/test/statements/`、任意のルールと承認の列）、db（`statement-repository`）、server の承認・ルールの API のテスト
- [X] T019 [US3] テスト先行でアプリの中の評価を消す（R10、§1.3、H: §3）: R10 の「削除の対象」の一覧（表 `eval_runs` の `DROP TABLE`、評価の実行と保存、`lib/jobs.ts`、`JOB_RUNNING`・`JOB_NOT_FOUND`、web の評価の画面、関係するテスト）を消す。採点の純関数 `statements/evals.ts` は残す。消した API が 404 になるテストを足す。`rg "eval_runs|evalRuns|JOB_RUNNING|JOB_NOT_FOUND" packages/*/src packages/*/test apps/*/src apps/*/test scripts` が 0 件（過去と削除用の migration・snapshot は除く）
- [X] T020 [US3] テスト先行で `scripts/eval-statements.ts`（`pnpm eval:statements`。`package.json` に足す）: 合成の明細（`packages/domain/test/fixtures/statements/` の README の方針、置き場所は同じ場所の `statement-evals.ts`）で、ルール → 端末内 → 外部の推定を採点の純関数（`statements/evals.ts`）で集計し、`.tmp/eval-statements/` に件数と割合だけを残して前回と比べる（`scripts/eval-column-suggestions.ts` と同じ形。先頭のコメントに使い方）。場面（`scene`）ごとに集計できる形にする（`journal_entry` は T040 で足す）。集計のテストは偽の `SuggestionProvider` で `packages/domain/test/` に置く。CI に含めない
- [ ] T021 [US3] テスト先行で取込のステップと自動の連鎖（R9、FR-019・020）: `apps/web/src/routes/e/$entityId/statements/import.tsx` と `features/statements/ImportWorkspace.tsx` に `Steps`（①入力 → ②列と口座 → ③取込 → ④確認・承認）。取込の確定の成功の後、`POST /inference-rules/seed` → `POST /statements/candidates` → `POST /statements/infer`（AI の設定が無効なら飛ばす）を順に呼び、進みを出し、AI の失敗は知らせて確認へ進む。主な操作は「次へ」／「取り込む」（UI: §7）。テスト `statements-import.test.tsx` を直す（呼ぶ順、AI の失敗）
- [ ] T022 [US3] テスト先行で確認とルールの一覧（R9、FR-021〜024）: `features/statements/ReviewQueue.tsx`（未処理を 1 件ずつ、明細と候補の仕訳を並べ、「承認して次へ」〔主な操作〕・「飛ばす」・「除外」、最後は完了の知らせとホーム・一覧へ。`BulkApprove` は今のしきい値の規則で上に）、承認の画面から「ルールを学ぶ」の選択を消す、一覧に「候補をもう一度作る」を控えめに残す、しきい値を `statements/settings` だけにする（一覧・確認から消す）、ルールの一覧に「自動」「利用者が直した」の印。承認の後は `invalidateLedger`。テスト `statements.test.tsx`・`statements-rules.test.tsx`・`statements-settings.test.tsx` を直す

**Checkpoint**: 10 件の取込から承認までステップだけで進み、承認からルールができる

---

## Phase 6: User Story 4 - 証憑の追加・一覧・詳細 (Priority: P2)

**Goal**: 目的ごとの画面、複数の追加、区分の既定、次の未入力へ（FR-026〜030、SC-007）。web だけ

**Independent Test**: spec US4 の Independent Test

- [X] T023 [US4] テスト先行で証憑の追加（R11・R4、FR-026〜028）: `apps/web/src/routes/e/$entityId/receipts/new.tsx` を作り直し `receipts/capture.tsx` を消す（`routeTree.gen.ts` を再生成）。`<input type="file" multiple>` で選んだファイルを既存の `POST /receipts` に 1 件ずつ順に送り、結果（追加・重複・エラー）を 1 件ずつ出す。区分の既定は `localStorage` の `trebuchet.receiptCategory.<entityId>`（理由の文は今のまま）。追加の後、未入力の証憑の値の入力（取引年月日・金額・取引先、AI の読み取りが有効なら「読み取る」）を同じ画面で開き、「次の未入力の証憑へ」で進む。主な操作は「追加する」。テスト: `receipts-upload.test.tsx`・`receipts-capture.test.tsx`・`receipt-fill.test.tsx` を `receipts-new.test.tsx` にまとめて直す（3 件、重複 1 件、区分の既定、次へ）
- [X] T024 [US4] テスト先行で一覧と詳細（R11、FR-029・030）: `receipts/index.tsx` の上に「未入力」（`missing=true`）・「仕訳なし」（`link=none`）の切替（引数の読み取りは T009 で済み。ここは切替の見た目）、今の検索の欄（取引年月日・金額・取引先。憲法 II）は残してテストで確かめる、`receipts/$receiptId.tsx` を上に原本・値・結びつき、下に `<details>` で情報・履歴・差し替え・削除。テスト `receipts-list.test.tsx`・`receipt-detail.test.tsx`・`receipt-edit.test.tsx`・`receipt-link.test.tsx` を直す

**Checkpoint**: 3 件をまとめて追加し、一覧に戻らずに値を入れ終える

---

## Phase 7: User Story 5 - 請求の流れ・入金・印刷 (Priority: P2)

**Goal**: 工数 → 請求書を作る → 入金の流れ、発行済みの月、取引先の 1 つの欄、行からの入金、詳細からの印刷（FR-031〜037、SC-008）

**Independent Test**: spec US5 の Independent Test

- [ ] T025 [US5] テスト先行で取引先と請求の条件の一括の保存（R15、H: §1）: schema `packages/schema/src/masters.ts` の `PartnerInput` に `isActive?: boolean | undefined`、`PartnerProfileInput = { partner: PartnerInput, billingTerms: BillingTermsInput | null }`（null は条件を消す）、domain のユースケース `savePartnerProfile`（`TenantUnitOfWork<{ invoicing: InvoicingStore }>` の 1 つの `run` で `masters` と `invoicing` に書く。今の `saveBillingTerms`・`deleteBillingTerms` の検証を使う）、server の `POST /partners/profile`（201）・`PUT /partners/:partnerId/profile`（200、404、409 名前の重複）。テスト: domain（条件の検証の失敗で取引先も巻き戻る）、`apps/server/test/partners-profile.api.test.ts`、`auth-coverage.test.ts`
- [ ] T026 [US5] テスト先行で請求の流れの画面と取引先の欄（R13、FR-031・034・035）: `routes/e/$entityId/invoices/index.tsx` に `Steps`（①工数 → ②請求書を作る → ③入金）と各段階の入口、取引先（請求先）の一覧と「取引先を登録」、請求書の一覧（既定は未入金・期限切れ。引数 `status` の読み取りは T009 で済み）。請求の条件のある取引先が工数の対象になること（FR-034）をテストで確かめる。取引先の欄 `features/masters/PartnerProfileForm.tsx`（名前・敬称・メモ・請求の条件・使用停止。T025 の API。US8 の取引先の画面でも使う）。一覧の行の「入金」で `Sheet` に `PaymentForm`、入金先の既定は `localStorage` の `trebuchet.depositAccount.<entityId>`（使用停止なら使わない）。入金の後は `invalidateLedger`。主な操作は「請求書を作る」。テスト `invoices-list.test.tsx`・`invoices-payments.test.tsx`・`partners-billing.test.tsx` を直す
- [ ] T027 [US5] テスト先行で請求書を作る画面（R13、FR-032・033、D5）: `routes/e/$entityId/invoices/new.tsx` の言葉を「請求書を作る」に統一し「ここでは保存しません。発行すると請求書と仕訳ができます」を出す。取引先と月を選ぶと、請求書の一覧（未取消）に同じ取引先・対象月があれば「発行済み（番号）」と出し、「取り消す」（詳細へ）か「追加で作る」（`confirmDuplicate: true`）を選ぶまで作るボタンを押せない。使用停止の取引先を対象に出さない。テスト `invoices-new.test.tsx` を直す
- [ ] T028 [US5] テスト先行で詳細からの印刷（R13、FR-036・037）: `routes/e/$entityId/invoices/$invoiceId_.print.tsx` を消し（`routeTree.gen.ts` を再生成）、`$invoiceId.tsx` に `features/invoicing/InvoicePrint.tsx` を `data-print-root` の要素として置き、「印刷・PDF に保存」で `window.print()`（主な操作。UI: §7）。`apps/web/src/print.css`（全体の `@media print` で `[data-print-root]` 以外を `display: none`、`@page { margin: 0 }`、余白は要素の `padding`）。屋号と氏名が発行時の写しで同じなら 1 回だけ出す。「ブラウザの印刷の設定でヘッダーとフッターを消せます」を小さく出す。テスト `invoice-print.test.tsx`・`invoice-detail.test.tsx` を直す。`apps/web/e2e/invoicing.spec.ts` の印刷の URL を詳細に直す

**Checkpoint**: 取引先の登録から発行・入金・印刷まで請求の画面の中で終わる

---

## Phase 8: User Story 6 - 帳票 (Priority: P2)

**Goal**: 仕訳帳の並び、科目名から元帳、期間のプリセット、前年の案内（FR-038〜041）

**Independent Test**: spec US6 の Independent Test

- [ ] T029 [US6] テスト先行で下の層（R12、§2.3、H: §2）: schema の `JournalBookQuery` に `sort`（`date` | `created`、既定 `date`）・`order`（`asc` | `desc`、既定 `asc`）、domain の仕訳帳の組み立て（`packages/domain/src/reports/` の仕訳帳。`date` は日付 → 仕訳番号 → 行、`created` は `created_at` → 仕訳番号 → 行、行は仕訳の中で常に今の順、CSV も同じ並び）、損益計算書・貸借対照表の `compare=previous-year` の応答に `previousHasData`（損益計算書は前年の同じ範囲に取消を除く仕訳の行があるか、貸借対照表は前年の会計期間があるか）。テスト: domain の仕訳帳の並び（4 通り）、`apps/server/test/reports.api.test.ts` に足す
- [ ] T030 [US6] テスト先行で帳票の画面（R12、FR-038〜041）: 仕訳帳に並べ替えの選択（取引日・登録日 × 昇順・降順、CSV の URL にも渡す）、試算表・損益計算書・貸借対照表の科目名を `general-ledger?accountId=&from=&to=` のリンクに（貸借対照表は期首から `asOf`）、`features/reports/controls.tsx` の `PeriodPicker` に今月・先月・今四半期・今年・昨年（計算は `apps/web/src/lib/dates.ts`、テスト `lib/dates.test.ts`）、`previousHasData` が false なら比較の欄の近くに理由と会計期間と移行の画面への案内。帳票の画面の中のタブで 5 つの帳票を行き来する。テスト `reports.test.tsx` を直す

---

## Phase 9: User Story 7 - 決算・申告 (Priority: P2)

**Goal**: 申告の控えを消し、決算書を今の年度で開き、要件のダイアログ、使わない欄を隠し、開業費を別の画面に（FR-042〜046）

**Independent Test**: spec US7 の Independent Test

- [ ] T031 [US7] テスト先行で申告の控えを消す（R14、§1.3、H: §3）: 表 `tax_return_memos`・`filed_documents` の `DROP TABLE`（マイグレーション）と、R14 の Decision の 1 項目めと追記の参照（db・domain・schema・server・web の控えの部分と関係するテスト）を消す（`routeTree.gen.ts` を再生成）。消した API が 404 になるテストを足す。控えに固有のエラーコードがあれば grep で消す。`grep -rn "tax_return_memos\|filed_documents\|filedDocuments\|TaxReturnMemo" packages apps scripts` が 0 件（マイグレーションの履歴を除く）
- [ ] T032 [US7] テスト先行で決算書の画面（R14、FR-043〜045）: `routes/e/$entityId/blue-return/index.tsx` を今日を含む会計期間の年（なければ最新）へ転送、`$year/index.tsx` の上に年度の select。`blue-return/$year/deduction.tsx` を消し（`routeTree.gen.ts` を再生成）、回答の欄を `features/blue-return/DeductionAnswersDialog.tsx` に移して欄 44 の近くに「要件を直す」（回答がなければ「要件に回答すると控除額が出ます」）、保存の後に決算書を読み直す。使わない欄の切替をなくし常に隠す、CSV は `blankUnused=true` を常に付ける。テスト `blue-return.test.tsx`・`blue-return-page*.test.tsx`・`blue-return-home-use.test.tsx` を直す
- [ ] T033 [US7] テスト先行で開業費の画面（R14、FR-046）: T005 で足した `routes/e/$entityId/deferred-assets/index.tsx` を仕上げる（`features/deferred-assets/` の部品、見出し、主な操作。固定資産台帳からの削除は T005 で済み）。API・規則（009）は変えない。テスト: `fixed-assets.test.tsx` の開業費の部分を新しい `deferred-assets.test.tsx` に移す

---

## Phase 10: User Story 8 - マスタ・消費税・会計期間 (Priority: P2)

**Goal**: 最初からある科目の保護、使用停止と検索、取引先の 1 つの欄、消費税の説明、会計期間の 4 段（FR-047〜052）

**Independent Test**: spec US8 の Independent Test。INV-70

- [ ] T034 [US8] テスト先行で最初からある科目の保護（R15、H: §2・§4、INV-70）: `packages/schema/src/errors.ts` に `ACCOUNT_SYSTEM_PROTECTED`（409。`apps/server/src/errors.ts` の状態の対応）、`packages/domain/src/usecases/masters.ts` の `renameAccount`・`updateAccount`（`name` を変えるとき）・`deleteAccount` で `isSystem` なら拒む（使用停止・再開と `reportLine` の変更は通る）。テスト: INV-70 の性質テスト（`packages/domain/test/`、任意の科目と操作の列で、拒まれた後の科目の表が変わらない、`isSystem` でない科目は今の規則のまま）、`apps/server/test/` の科目の API のテストに 409 を足す。seed の科目の名前を変える既存のテストがあれば利用者の科目に直す（grep）
- [ ] T035 [US8] テスト先行で科目・取引先の画面（R15、FR-047〜049）: `routes/e/$entityId/accounts.tsx` で `isSystem` の科目に名前の変更・削除を出さず「最初からある科目」の印、各行の右端に「使用停止」「使用再開」（`outline`）、上に検索（T011 の `account-search`）と「使用停止を隠す」（既定 ON）。`partners.tsx` に検索と T026 の `PartnerProfileForm`（使用停止を含む）。テスト `accounts.test.tsx` と取引先のテスト（`partners-billing.test.tsx` か新しい `partners.test.tsx`）を直す
- [ ] T036 [US8] テスト先行で消費税の説明と会計期間（R15、FR-050・051）: `features/entities/tax-help.ts`（課税区分・経理方式ごとの説明の文。既定の税区分、税額の計算、税抜は `TAX_METHOD_UNSUPPORTED`、簡易課税・2 割特例は本則と同じ扱い）を `tax-settings.tsx` に出す。`periods/index.tsx` を年度ごとのカードにし「期首残高 → 記帳 → 決算整理 → 締め」の状態（期首残高の有無、仕訳の一覧の `summary.count`、決算書へのリンク、締めの有無）と入口、freee の取込（`imports`）への入口。`imports/index.tsx`・`imports/new.tsx` の上に期首残高（元帳から作る）と照合（`imports/reconcile`）へのリンク。テスト `tax-settings.test.tsx`・`periods.test.tsx`・`imports-index.test.tsx`・`imports-menu.test.tsx` を直す

---

## Phase 11: User Story 9 - 設定・施錠・バックアップ (Priority: P2)

**Goal**: 設定のレイアウト、5 件と CSV、施錠の文言、既定の置き場所 `bak/`、復元を上へ（FR-053〜057、SC-009）

**Independent Test**: spec US9 の Independent Test

- [X] T037 [US9] テスト先行でバックアップの既定の置き場所（R16、§2.3、H: §2）: registry の `backup_folder` が未設定なら `<リポジトリ直下>/bak`（リポジトリ直下は `packages/db/src/tenant-store.ts:42` の `dataDir()` の既定と同じ求め方。`TREBUCHET_DATA_DIR` があっても `bak/` はリポジトリ直下。環境変数 `TREBUCHET_DEFAULT_BACKUP_DIR` で変えられる）。`apps/server/src/lib/backup-scheduler.ts:34` の未設定で止まる分岐と手動の実行（`backup-run.ts`、`routes/backup.ts`）を既定でも動かす。`BackupStatus` に `folderSource: "configured" | "default"`、未設定でも `configured: true`。証憑の写しも同じ置き場所の下。テスト: `apps/server/test/` のバックアップのテスト（一時のディレクトリを `TREBUCHET_DEFAULT_BACKUP_DIR` で渡す。既定で自動・手動が書ける、`folderSource`）。`configured: false` を前提にするテストを grep で直す
- [X] T038 [US9] テスト先行で記録の CSV（R17、H: §2）: `GET /auth/events?format=csv`・`GET /backup/runs?format=csv`（全件、`limit` を無視。列は日時・種類・結果・端末の種類など表示用の列だけ、資格情報の ID・トークン・鍵を出さない。書き方は `packages/domain/src/reports/csv.ts` に合わせる）。テスト: server の認証・バックアップのテストに足す（列に秘密がない、全件）
- [X] T039 [US9] テスト先行で設定の画面（R17、UI: §6、FR-053〜057）: `apps/web/src/routes/settings/route.tsx`（`nav aria-label="設定のメニュー"`: セキュリティ・バックアップ・AI・リモート、各ページの `h1` は同じ名前、`max-w-4xl`。`routeTree.gen.ts` を再生成）、認証の記録とバックアップの履歴は `limit=5` と「CSV に書き出す」（0 件なら無効）、`LockCard` の文と操作をヘッダーの「施錠してサインアウト」と同じにする、`grep -rn "Mac で施錠" apps` を 0 件にして端末の語を「この Mac」「スマホ・リモート」にそろえる、バックアップの画面を 状態 → 復元 → 履歴 の順にし、`folderSource` が `default` なら R16 の注意の文、書けずに失敗したら警告の近くに置き場所を変える案内（Edge Cases）。テスト `auth.test.tsx`・`backup.test.tsx`・`backup-inspect.test.tsx`・`settings-ai.test.tsx`・`remote.test.tsx` を直す

---

## Phase 12: User Story 10 - スマホ (Priority: P2)

**Goal**: スマホの幅ではみ出さず、メニューを絞り、対象の外に PC の推奨（FR-058・059、SC-010）。web だけ

**Independent Test**: spec US10 の Independent Test（E2E の 390 px）

- [ ] T040 [US10] テスト先行でスマホのメニューと PC の推奨（R11、UI: §1・§4）: `apps/web/src/lib/use-media-query.ts`、`components/layout/MobileNav.tsx`（ボタン「メニュー」、`aria-expanded`、`Sheet` の名前「メニュー」、`MOBILE_ROUTES` の項目と設定・施錠してサインアウト）、`components/layout/PcRecommended.tsx`（対象の外で `role="note"` の「PC での操作を推奨」）を `AppHeader`・`route.tsx` に組み込み、FR-058 の画面の表を `overflow-x-auto` の枠に入れる。テスト `apps/web/test/routes/mobile-nav.test.tsx`（`matchMedia` の偽物で項目の絞り込みと PC の推奨）
- [ ] T041 [US10] `apps/web/e2e/mobile.spec.ts`（390 × 844。FR-058 の各画面で `document.documentElement.scrollWidth <= clientWidth`、メニューから各画面に届く）を書く。実行は利用者の端末（T049）

---

## Phase 13: User Story 11 - 仕訳の入力の AI の候補 (Priority: P3)

**Goal**: 外部の AI が有効なとき、かんたん入力の摘要・金額から科目・税区分の候補（FR-060・061）

**Independent Test**: spec US11 の Independent Test（偽の AI の応答）

- [ ] T042 [US11] テスト先行で場面の payload（R19、INV-45・46）: `packages/domain/src/statements/mask.ts` に `buildJournalEntryPayload({ date, amount, memo })`（`maskContent` を通した摘要・金額・日付だけの `JournalEntryPayload`、`scene: "journal_entry"`）、既存の `AiPayload` に `scene: "statement"`、`SuggestionPayload = AiPayload | JournalEntryPayload`、`prompt.ts` は `scene` で指示文を分ける、`usecases/inference.ts` の `createAiSuggester` が両方を受ける。INV-45 の性質テストに `JournalEntryPayload` を足す（取引先の一覧・口座名を含まない）。`AiPayload` を参照するテストを grep で直す
- [ ] T043 [US11] テスト先行で `POST /journals/ai-suggestion`（R19、H: §1）: `apps/server/src/routes/journals.ts`、入力 `{ date, amount, memo }`（金額は整数 `0 < amount < 1e12`、摘要は空でない）、ルールを使わず 端末内 → 外部 の順で `createAiSuggester`、`AiSuggestion` で検証し一覧にない科目・税区分は `suggestion: null`（INV-46）、外部の AI が無効なら 422 `AI_NOT_CONFIGURED`、候補を保存しない。テスト `apps/server/test/journals-ai-suggestion.api.test.ts`（偽の `fetch`）、`auth-coverage.test.ts`
- [ ] T044 [US11] テスト先行で `apps/web/src/features/ai-assist/AiSuggestionPanel.tsx`（`scene` を受け取る。011 は `journal_entry` だけ）を `QuickEntryForm` に置く: 外部の AI が有効なときだけボタン、候補と根拠・確信度、「入れる」で `purpose` と科目の区分から借方・貸方の一方（決められなければ借方）と税区分を埋める（登録は利用者の操作）。`mock-api.ts`。テスト `apps/web/test/routes/journals-ai-suggestion.test.tsx`（無効ならボタンなし、入れるまで欄が変わらない、候補なし）
- [ ] T045 [US11] `scripts/eval-statements.ts` に `journal_entry` の場面の合成の例（摘要・金額 → 期待の科目、約 30 件。`packages/domain/test/fixtures/statements/journal-entry-evals.ts`）を足し、集計のテストを足す。実行と前後の比較は T049（利用者の端末、憲法 IV）

---

## Phase 14: Polish & Cross-Cutting Concerns

- [ ] T046 テスト先行で主な操作の見た目（FR-004、UI: §7）: UI: §7 の各画面で `variant="default"` のボタンが 1 つだけになるよう、ほかを `outline`・`ghost`・`link`、危ない操作を `destructive` に直す。テストは各画面のテストで主な操作の名前を `getByRole` で確かめる（class を見ない）。US1〜US9 で済んでいない画面だけを直す
- [ ] T047 [P] `scripts/bench-reports.ts` に `GET /home`（約 500 仕訳で 2 秒以内、SC-003。R20）を足す。実行は T049
- [ ] T048 （メイン）文書: `AGENTS.md` に「画面の作り直し（011）」の節（層と場所の表、`components/layout/`・`components/ui/` の部品、UI 契約が正本、`bak/`、`eval:statements` のコマンドの行と規則、控え・評価の削除、`learn` の廃止と `managed_by`）、コマンドの表に `pnpm eval:statements`、`docs/requirements.md` の要望 5〜14・U1〜U29 の状態、README のバックアップの既定の置き場所
- [ ] T049 （メイン）全体の検証: `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @trebuchet/web build`。`grep -rn "Mac で施錠\|eval_runs\|tax_return_memos\|filed_documents\|JOB_RUNNING" packages apps scripts` が 0 件（マイグレーションの履歴を除く）

---

## Phase 15: 利用者の端末での確認（メイン・利用者。値・取引先名は書かない）

- [ ] T050 利用者の端末で `pnpm --filter @trebuchet/web e2e`（既存 5 本 + `mobile.spec.ts`）、`pnpm bench:reports`（SC-003）、`pnpm eval:statements` を T018・T042 の前（T019・T020 を T018 より先に行い、T020 の直後のコミットを基準にする）と後で実行して比べる（憲法 IV。明細の場面のルール・AI の精度が下がらないこと。`journal_entry` の場面は前の版にないので、後の値を初めての基準値として記録する）。結果（通った・落ちた、件数と割合だけ）をこの行の下に記録する
- [ ] T051 Q: §3 の手動の確認（SC-011、Mac とスマホ）。要望ごとに日付と OK／NG と理由をこの行の下に記録する

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → US1** の順。US1 の T005（メニューとルート）は後のすべての画面のテストが前提にする
- US2〜US11 は US1 の後ならどの順でもよいが、下の依存がある:
  - T013（下書き）の INV-69 は T007 の `HomeSummary` を使う
  - T016 は T012・T013、T015 は T004・T010・T011
  - T025（取引先の欄の API）→ T026 → T035（取引先の画面で `PartnerProfileForm` を使う）
  - T033 は T005 の `deferred-assets/index.tsx`
  - T036 の会計期間の状態は T014 の `summary.count`
  - US3 は T019 → T020 → T018 の順（T020 の直後のコミットを評価の基準にする。T050）。T045 は T020 と T042 の後
  - T044 は T015 と T043
  - T040 は T003（Sheet）と T005
- Polish（T046〜T049）は全ストーリーの後、Phase 15 は最後
- マイグレーションを作るタスク（T013、T018、T019、T031）は並べて実行しない（番号と `meta/_journal.json` がぶつかる）

### 部下に渡す単位（クレジットの節約）

| まとまり | タスク |
|---|---|
| 共通の部品 | T002〜T004 |
| US1 骨組み | T005・T006 |
| US1 ホーム | T007〜T009 |
| US2 下の層 | T010〜T014 |
| US2 画面 | T015〜T017 |
| US3 下の層 | T018〜T020 |
| US3 画面 | T021・T022 |
| US4 | T023・T024 |
| US5 | T025〜T028 |
| US6 | T029・T030 |
| US7 | T031〜T033 |
| US8 | T034〜T036（T034 の INV-70 は整合性の判断が要れば implementer-hard） |
| US9 | T037〜T039 |
| US10・US11 | T040〜T045 |

## Implementation Strategy

1. **MVP**: Phase 1・2 と US1（骨組み・ホーム）。ここで止めても、メニュー・ヘッダー・ホームの改善が使える
2. P1 の US2（仕訳）・US3（明細）で毎日の作業を短くする
3. P2 の US4〜US10 を 1 つずつ足し、各 Checkpoint で該当の web のテストを通す
4. P3 の US11（AI）は最後。評価の前後の比較（T050）まで含めて終える
5. 各 US の区切りでコミットし（Conventional Commits、タスク ID）、`/usage` の値を引き継ぎメモに控える

## Notes

- 各タスクの「テスト先行」は、新しいテスト（または新しい形に直した既存のテスト）を実行して**赤を確かめてから**実装する
- 画面の文言を変えた web のテストは、そのタスクの中で直す（別のタスクに持ち越さない）
- 旧 URL（`/print`、`tax-return`、`statements/evals`、`blue-return/$year/deduction`、`receipts/capture`）を参照する E2E・テストは、消すタスクの中で直す
