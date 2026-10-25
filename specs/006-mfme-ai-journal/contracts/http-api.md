# Contract: HTTP API（006-mfme-ai-journal）

001 の [http-api.md](../../001-ledger-core/contracts/http-api.md) の規約（ベースパス `/api`、エラー形式、`warnings`、Hono RPC）と、004 の検査（Host → CSRF → 認証。全ルートが要サインイン）を使う。§2〜§6 のパスは `/entities/:entityId` の下、§7 は端末の設定（`/settings` の下）。入出力の正本は `packages/schema/src/statements.ts` と `ai.ts` の Zod 定義。金額は円の整数（明細は符号つき）。

## 1. 追加するエラーコード（`packages/schema/src/errors.ts`、`apps/server/src/errors.ts` の `ERROR_STATUS`）

| HTTP | code | 発生条件 | 要件 |
|---|---|---|---|
| 404 | `STATEMENT_NOT_FOUND` | 明細がない。`details.statementId` | FR-012 |
| 404 | `STATEMENT_ACCOUNT_NOT_FOUND` | 取込元の口座がない | FR-003 |
| 404 | `INFERENCE_RULE_NOT_FOUND` | ルールがない | FR-024 |
| 404 | `JOB_NOT_FOUND` | 取得・評価のジョブがない（server の再起動で消えたものを含む） | FR-008, FR-029 |
| 422 | `STATEMENT_PASTE_UNREADABLE` | 必須の列がそろわない・1 行も読めない。`details: { missingColumns?, unreadable }` | FR-001, Edge Cases |
| 422 | `STATEMENT_ACCOUNT_UNMAPPED` | 対応づいていない保有金融機関がある。`details.names` | FR-003 |
| 409 | `STATEMENT_PLAN_CHANGED` | 確定のときの入力のハッシュか新規の件数がプレビューと違う | FR-002 |
| 409 | `STATEMENT_ALREADY_REGISTERED` | 登録済みの明細の承認・除外 | FR-014, FR-017 |
| 409 | `STATEMENT_EXCLUDED` | 除外した明細の承認 | FR-017 |
| 422 | `STATEMENT_AMOUNT_MISMATCH` | 直した案の、明細の口座の行の合計が明細の金額と違う。`details: { expected, actual }` | FR-015, US2-3 |
| 409 | `JOURNAL_LINE_ALREADY_LINKED` | 結びつけ先の仕訳の行に、別の明細が結びついている | FR-021a |
| 409 | `JOB_RUNNING` | 取得・評価のジョブが動いている間に、もう1つを始めた | FR-008 |
| 422 | `AI_NOT_CONFIGURED` | 外部の AI を有効にしようとしたが、接続先・モデル・API キーがない。`details.fields` | FR-027 |

既存のコードの再利用: `VALIDATION`、`PERIOD_CLOSED`・`OUT_OF_PERIOD`（承認の日付）、`ACCOUNT_NOT_FOUND`・`ACCOUNT_INACTIVE`、`UNBALANCED`、`TAX_SETTING_GAP`、`REASON_REQUIRED`（除外・結びつきの取消）。

## 2. 取込元の口座（US1, FR-003）

| § | メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|---|
| 2.1 | GET | `/statement-accounts` | — | 200 `{ accounts: StatementAccount[] }` | FR-003 |
| 2.2 | PUT | `/statement-accounts/:name` | `{ usage, kind, accountId?, subAccountId? }`（`private` は `accountId` を持たない、ほかは必須。違えば `VALIDATION`） | 200 `{ account, rebuilt: number }`（作り直した未処理の候補の件数） | FR-003, Edge Cases |

## 3. 取込（US1, US4）

| § | メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|---|
| 3.1 | POST | `/statements/imports/preview` | `{ source: { kind: "paste", text, year } \| { kind: "mfme_fetch", jobId } }` | 200 `StatementImportPreview` = `{ inputSha256, period, totals: { inflow, outflow }, rows: { key, date, amount, content, accountName, status: "new" \| "existing" \| "changed", warnings: ("POSSIBLE_DUPLICATE")[] }[], unreadable: { line, reason }[], unmappedAccounts: string[], countNew }` / 422 `STATEMENT_PASTE_UNREADABLE` | FR-002, FR-004〜FR-006 |
| 3.2 | POST | `/statements/imports` | 3.1 の入力 ＋ `{ expected: { inputSha256, countNew } }` | 201 `{ batch, added: number, changed: number }` / 422 `STATEMENT_ACCOUNT_UNMAPPED` / 409 `STATEMENT_PLAN_CHANGED` | FR-007 |
| 3.3 | GET | `/statements/imports` | — | 200 `{ batches }`（新しい順） | FR-002 |
| 3.4 | POST | `/statements/mfme/fetch` | `{ from: YYYY-MM, to: YYYY-MM }` | 202 `{ jobId }` / 409 `JOB_RUNNING`。server が見えるブラウザを開く（R13） | FR-008, FR-009 |
| 3.5 | GET | `/jobs/:jobId` | — | 200 `{ status: "waiting_login" \| "running" \| "done" \| "failed", progress?, error?: { code, message, failedAccounts? } }` / 404 `JOB_NOT_FOUND` | FR-010 |

- 3.4 の取得の結果（行）は server のメモリにだけ置き、3.1・3.2 の `jobId` で使う。パスワード・クッキーは保存しない（FR-009）

## 4. 明細と候補（US2）

| § | メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|---|
| 4.1 | GET | `/statements?status=&accountId=&from=&to=` | `status` は `unprocessed`・`registered`・`excluded`・`changed` | 200 `{ statements: StatementView[] }`。`StatementView` = `{ id, date, amount, content, accountName, usage, status, changed, candidate: Candidate \| null, links: { journalId, kind }[], duplicateOf?: string[] }`。`Candidate` = `{ method, purpose, confidence, reason, draft, match?: { journalId, lineId }, model? }` | FR-012 |
| 4.2 | POST | `/statements/candidates` | `{ statementIds? }`（省略で未処理すべて） | 200 `{ built, needsAi: string[] }`（match → transfer → rule の段で作る。AI が要る明細の ID） | FR-013 |
| 4.3 | POST | `/statements/infer` | `{ statementIds }`（10 件まで） | 200 `{ results: { statementId, method, confidence }[], localAvailable, externalUsed }`（R8。web が繰り返して呼ぶ） | FR-025〜FR-028 |
| 4.4 | POST | `/statements/:statementId/approve` | `{ draft?: JournalDraft, purpose?, match?: { journalId, lineId }, partnerId?, learn?: boolean（既定 true） }`（省略で候補のまま） | 201 `{ journal \| null, link, rule? }` / 409 `STATEMENT_ALREADY_REGISTERED`・`STATEMENT_EXCLUDED`・`JOURNAL_LINE_ALREADY_LINKED`・`PERIOD_CLOSED` / 422 `STATEMENT_AMOUNT_MISMATCH`・`UNBALANCED`・`OUT_OF_PERIOD` | FR-014〜FR-016, FR-020, FR-021a, FR-022 |
| 4.5 | POST | `/statements/approve-bulk` | `{ statementIds?, threshold? }`（省略で設定の `bulk_threshold` 以上の未処理すべて） | 200 `{ approved: string[], failed: { statementId, code, message }[] }`（明細ごとに1つの UnitOfWork） | FR-018 |
| 4.6 | POST | `/statements/:statementId/exclude` | `{ reason? }` | 200 `{ statement }` / 409 `STATEMENT_ALREADY_REGISTERED` | FR-017 |
| 4.7 | POST | `/statements/:statementId/unexclude` | `{ reason }` | 200 `{ statement }` | FR-017 |
| 4.8 | POST | `/statements/:statementId/acknowledge-change` | — | 200 `{ statement }` | FR-005 |

- 仕訳から明細へ: 001 の `GET /journals/:journalId` の出力に `statements: { statementId, kind }[]` を足す（FR-020。005 の契約 §6 の出所と同じ場所）
- 承認の順序（1 つの `StatementUnitOfWork`）: 検査 → `createJournal`（`source = statement`）または結びつけ先の検査 → `statement_links` → ルールの学習 → 監査

## 5. ルール（US3）

| § | メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|---|
| 5.1 | GET | `/inference-rules?status=` | — | 200 `{ rules: InferenceRuleView[] }`（`hits`・`overrides`・確信度つき） | FR-024 |
| 5.2 | POST | `/inference-rules/seed` | `{ dryRun?: boolean }` | 200 `{ created, skipped, rules? }`（`dryRun` は作らずに案だけ） | FR-023 |
| 5.3 | PATCH | `/inference-rules/:ruleId` | `{ counterAccountId?, counterSubAccountId?, taxCategory?, partnerId?, purpose?, descriptionTemplate? }` | 200 `{ rule }` | FR-024 |
| 5.4 | POST | `/inference-rules/:ruleId/pause`・`/resume` | — | 200 `{ rule }` | FR-024 |
| 5.5 | GET | `/inference-rules/:ruleId/history` | — | 200 `{ history }` | FR-022 |

## 6. 評価と設定（US5）

| § | メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|---|
| 6.1 | POST | `/statements/evals` | `{ splitDate?, includeAi?: boolean }` | 202 `{ jobId }` / 409 `JOB_RUNNING` | FR-029 |
| 6.2 | GET | `/statements/evals` | — | 200 `{ runs: EvalRun[] }`（新しい順。前回との差は web で出す） | FR-029 |
| 6.3 | GET・PUT | `/statement-settings` | `{ bulkThreshold, externalThreshold }`（0〜100） | 200 `{ settings }` | FR-018, FR-027 |

## 7. AI の接続（端末の設定。FR-027, FR-027a）

| § | メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|---|
| 7.1 | GET | `/settings/ai` | — | 200 `{ localEnabled, localAvailable, externalEnabled, externalBaseUrl, externalModel, apiKeySet: boolean }`（API キーそのものは返さない） | FR-027a |
| 7.2 | PUT | `/settings/ai` | `{ localEnabled, externalEnabled, externalBaseUrl?, externalModel?, apiKey? }`（`apiKey` はキーチェーンへ。空文字で削除。URL は `https://` か localhost だけ） | 200 7.1 の形 / 422 `AI_NOT_CONFIGURED` | FR-027, FR-027a |
