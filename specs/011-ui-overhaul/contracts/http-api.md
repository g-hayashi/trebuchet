# HTTP API の変更（011）

すべて `/api` の下。帳簿の API は今と同じく Host → CSRF → 認証の検査と解錠を要求する（施錠中は 401 `LOCKED`。INV-29 の `auth-coverage.test.ts` が新しいルートも網羅する）。応答は `respond`（`apps/server/src/errors.ts`）。

## 1. 足す

| メソッドとパス | 入力 | 応答 | エラー | 根拠 |
|---|---|---|---|---|
| `GET /entities/:id/home` | なし（今日は `todayOf(clock)`） | 200 `HomeSummary`（data-model §2.1） | 404 事業体 | R3 |
| `GET /entities/:id/journal-draft` | なし | 200 `{ draft: JournalDraft \| null, updatedAt: string \| null }` | — | R6 |
| `PUT /entities/:id/journal-draft` | `JournalDraft` | 200 `{ updatedAt }` | 400 検証 | R6 |
| `DELETE /entities/:id/journal-draft` | なし | 204（なくても 204） | — | R6 |
| `GET /entities/:id/journals/suggestions?memo=&partnerId=` | どちらか必須。`memo` は 200 字まで | 200 `{ suggestions: JournalSuggestion[] }` | 400 検証 | R5 |
| `POST /entities/:id/journals/ai-suggestion` | `{ date, amount, memo }`（金額は整数 `0 < amount < 1e12`、摘要は空でない） | 200 `{ suggestion: AiSuggestion \| null, reason?: string }`（null は候補なし） | 422 `AI_NOT_CONFIGURED`（外部の AI が無効） | R19 |
| `POST /entities/:id/partners/profile` | `PartnerProfileInput = { partner: PartnerInput, billingTerms: BillingTermsInput \| null }` | 201 `{ partner, billingTerms }` | 400、409 名前の重複（今の規則） | R15 |
| `PUT /entities/:id/partners/:partnerId/profile` | 同上 | 200 同上 | 400、404、409 | R15 |

## 2. 変える

| メソッドとパス | 変更 | 根拠 |
|---|---|---|
| `GET /entities/:id/journals` | 応答に `summary: { count, amount }` を足す | R7 |
| `GET /entities/:id/reports/journal-book` | 問い合わせに `sort`（`date`\|`created`、既定 `date`）・`order`（`asc`\|`desc`、既定 `asc`）。`format=csv` も同じ並び | R12 |
| `GET /entities/:id/reports/profit-and-loss`・`balance-sheet` | `compare=previous-year` のとき応答に `previousHasData` | R12 |
| `PATCH /entities/:id/accounts/:accountId`・`DELETE` | `isSystem` の科目の名前の変更・削除は 409 `ACCOUNT_SYSTEM_PROTECTED`（`isActive`・`reportLine` の変更は通る） | R15 |
| `POST/PUT` 取引先（今のルート） | `PartnerInput` に `isActive?` | R15 |
| 明細の承認（今のルート） | 入力から `learn` を消す。承認のたびに学ぶ | R9 |
| `PATCH /entities/:id/inference-rules/:ruleId` | 変更したルールを `managedBy: "user"` にする。応答の `InferenceRule` に `managedBy` | R9 |
| `POST /entities/:id/inference-rules/seed` | `managedBy: "user"` のルールを変えない | R9 |
| `GET /auth/events` | `format=csv` で全件の CSV（`limit` を無視）。秘密・資格情報の ID・トークン・鍵の列を出さない | R17 |
| `GET /backup/runs` | `format=csv` で全件の CSV | R17 |
| `GET /backup/status` | `folderSource` を足す。未設定でも `configured: true`（既定 `bak/`） | R16 |
| `POST /backup/run`（今の手動の実行） | 未設定なら既定の置き場所に書く | R16 |

## 3. 消す

| パス | 根拠 |
|---|---|
| `/entities/:id/tax-return/...`（`routes/tax-return.ts` の全ルート） | R14 |
| `POST /entities/:id/statements/evals`、`GET /entities/:id/statements/evals` | R10 |

## 4. エラーコード

足す: `ACCOUNT_SYSTEM_PROTECTED`（409、`schema/errors.ts`）。消すコードがあれば（申告の控え・評価に固有のもの）、`grep -rn <コード> packages apps scripts` で参照を消す。
