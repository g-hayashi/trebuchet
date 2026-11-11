# 画面の作り直し（011）

仕様: `specs/011-ui-overhaul/`。画面の正本は UI の契約 `contracts/ui-shell.md`（主な操作は §7、スマホは §4）。API の変更は `contracts/http-api.md`。ホーム・ヘッダー・メニュー・主なボタン・スマホ・設定・仕訳のかんたん入力・請求・印刷などを作り直した。帳簿の不変条件（INV-1〜68）は変えず、INV-69〜72 を足した（`specs/INVARIANTS.md`）。

## 011 の骨組み

| 層 | 場所 |
|---|---|
| 骨組み（ヘッダー、事業体のメニュー、スマホのメニュー、PC の推奨の表示） | `apps/web/src/components/layout/`（`AppHeader.tsx`、`EntityNav.tsx`、`MobileNav.tsx`、`PcRecommended.tsx`）、`apps/web/src/lib/use-media-query.ts` |
| 共通の部品 | `apps/web/src/components/ui/`（`sheet.tsx`、`steps.tsx`、`toast.tsx`、`combobox.tsx`、`dialog.tsx`、`button.tsx`、`table.tsx` など） |
| ホーム（今日やること、今期の数字） | `apps/web/src/features/home/`（`HomePage.tsx`、`api.ts`）、server の `GET /home`（`apps/server/src/routes/home.ts`）、`packages/domain/src/usecases/home.ts` |
| 仕訳の入力 | `apps/web/src/features/journals/`（`QuickEntryForm.tsx`、`JournalSuggestions.tsx`）、下書き `packages/domain/src/usecases/journal-drafts.ts`・`packages/db/src/journal-draft-repository.ts`、税区分の既定 `packages/schema/src/tax-defaults.ts`、科目の読み `account-readings.ts` |
| 取引先の一括の保存 | `POST /partners/profile`・`PUT /partners/:partnerId/profile`（`apps/server/src/routes/invoicing.ts`）、`savePartnerProfile`（`packages/domain/src/usecases/invoicing.ts`） |
| 最初からある科目の保護（INV-70） | `ACCOUNT_SYSTEM_PROTECTED`（`packages/schema/src/errors.ts`、`packages/domain/src/usecases/masters.ts`、`apps/web/src/lib/api-errors.ts`） |
| 印刷 | `apps/web/src/print.css`（請求書）、`features/blue-return/print.css`（決算書）、`features/invoicing/InvoiceDetail.tsx`・`InvoicePrint.tsx` |
| バックアップの既定の置き場所 | `apps/server/src/lib/backup-folder.ts`（`resolveBackupFolder`） |
| 明細の取込の手順と確認 | `apps/web/src/features/statements/`（`ImportWorkspace.tsx` の `Steps`、`candidate-chain.ts`、確認の表 `ReviewTable.tsx`。007/R17 で 1 件ずつの `ReviewQueue`・`BulkApprove`・`review` ルートを消した） |
| ルールの `managed_by`（INV-71） | `packages/domain/src/statements/rules.ts`（`learnRule`）、`usecases/inference-rules.ts`、`packages/db/src/schema/tenant.ts` |
| 仕訳の入力の AI の候補 | `packages/domain/src/statements/mask.ts`（`buildJournalEntryPayload`）・`prompt.ts`（`scene`）、`usecases/journal-ai-suggestion.ts`、`POST /journals/ai-suggestion`（`apps/server/src/routes/journals.ts`）、`apps/web/src/features/ai-assist/` |
| 評価・E2E | `scripts/eval-statements.ts`、`packages/domain/src/statements/eval-runner.ts`、`packages/domain/test/fixtures/statements/statement-evals.ts`、`apps/web/e2e/mobile.spec.ts` |

- **各画面で `variant="default"` のボタンは 1 つ**（`variant` を省くと `default`。主な操作。名前は ui-shell §7 の表）。それ以外は `outline` などにして見分けがつくようにする。新しい画面を足すときは §7 に足す。
- **ブラウザに覚える値は `localStorage` に置く**（帳簿のデータではない。011/R4）。最後に開いた事業体（`EntitySwitcher.tsx` の `entityToRestore`）、`trebuchet.receiptCategory.<entityId>`、`trebuchet.depositAccount.<entityId>`。DB や API に足さない。
- **印刷は詳細の画面から直接行う**（別のページ `/print` を作らない）。印刷する範囲は詳細の `data-print-root` で示し、ヘッダー・メニュー・知らせを隠す規則は `print.css` に置く。
- **バックアップの置き場所が未設定のとき、既定は `<リポジトリ直下>/bak/`**（011/R16。`resolveBackupFolder`。環境変数 `TREBUCHET_DEFAULT_BACKUP_DIR` で変えられる。`TREBUCHET_DATA_DIR` を変えても `bak/` はリポジトリ直下。`.gitignore` 済み）。既定の間は Mac を失うとバックアップも失われる。`BackupStatus.folderSource` が `configured`／`default`。テストは一時のディレクトリを渡す。
- **申告の控え（`tax_return_memos`・`filed_documents`）とアプリの中の評価（`eval_runs`、`lib/jobs.ts`、`JOB_RUNNING`）は消した**（011 の migration で `DROP TABLE`）。過去の migration と snapshot にだけ残る。決算書の計算は控えを参照していなかったので変わらない。再び作らない。
- **明細の承認の入力に `learn` はない**。承認のたびに学ぶ条件（`learnFromApproval`）でルールを作る・直す。ルールの一覧で利用者が直した・止めた・再開したルールは `managed_by = 'user'` になり、戻さない。承認と `seedRulesFromJournals` は `user` のルールを変えない（INV-71）。取込の確定の後、web が `inference-rules/seed` → `statements/candidates` → `statements/infer`（AI が無効なら飛ばす）を順に呼ぶ（`candidate-chain.ts`）。
- **AI の推定の場面は `scene`（`statement`・`journal_entry`）で分ける**。`journal_entry` に送るのは `buildJournalEntryPayload` の日付・金額・`maskContent` を通した摘要だけ（INV-45）。`statement` の場面の指示文は `packages/domain/test/statements/prompt-golden.test.ts` が固定する（変えるときは `eval:statements` の前後の比較が要る）。仕訳の AI の候補は保存せず、ルールを使わない。
- **端末内の AI の既定（非推奨・無効）の正本は[006](006-mfme-ai-journal.md)**。AI の設定の画面（`AiSettingsForm.tsx`）の端末内の項目に「非推奨」と理由、無効だと列の対応の案（007）も出ないことを示す。
- **`eval:statements` の規則**: 明細の推定のプロンプト・推定の経路（ルール → 端末内 → 外部）を変えるときは、変更の前と後で `pnpm eval:statements` を実行して結果を比べる（Constitution IV、011/R10）。AI（`fm` と外部）を呼ぶので CI に含まれない。結果は `.tmp/eval-statements/` に件数と割合だけを残し、モデル名・URL・キー・明細・AI の回答を書かない。外部の有効・無効の状態や fixture の版が違う結果は比べない。CI のテストは偽の `SuggestionProvider` で集計だけを確かめる。`eval:columns`（007）・`eval:receipts`（010）と同じ規則。

## 組織の一覧と削除

一覧のURLは `/list`（従来の `/?list=1` でも表示）。作成フォームの「個人・法人の違い」は展開式で、期首月・個人限定の決算機能・共通の初期設定を説明する。

- 非表示: `POST /api/entities/:entityId/archive`。registry の `entities.status` を `archived` にして通常の一覧・切替・自動処理から外す。帳簿・証憑は保持するが、事業体配下のAPIは404にする。
- 復元: `POST /api/entities/:entityId/restore`。`GET /api/entities/archived` の「非表示の組織」から一覧へ戻す。
- 完全削除: `DELETE /api/entities/:entityId/purge`（JSON `{ name }`）。非表示済みかつ名称一致が必要。対象の操作が進行中なら拒否する。`deleting` を保存し、対象のDBハンドルを閉じてDB・副ファイル・証憑だけを消し、最後に一覧の行を消す。失敗時は `deleting` のまま残し、復元を拒否して完全削除を再試行できる。
- バックアップ: 非表示の組織は状態ごと保持し、削除処理中の組織は新しいバックアップから除外する。既存のバックアップや証憑のバックアップは消さない。過去のバックアップを復元すると削除した組織も戻る場合があることを確認画面で説明する。

実装: `usecases/entity-lifecycle.ts`（domain）、`registry-repository.ts`・`tenant-store.ts`（db）、`routes/entities.ts`・`tenant.ts`（server）、`features/entities/EntityListPage.tsx`・`routes/list.tsx`（web）。

