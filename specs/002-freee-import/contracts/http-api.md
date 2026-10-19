# Contract: HTTP API（002-freee-import）

001 の [http-api.md](../../001-ledger-core/contracts/http-api.md) の規約（ベースパス `/api`、エラー形式、Hono RPC、テナントの指定）をそのまま使う。ここでは追加するものだけを書く。入出力の正本は `packages/schema` の Zod 定義。

- ファイルを送るエンドポイントは `multipart/form-data`。フィールド `file`（1つ）。上限 5 MB（超えると 413 `FILE_TOO_LARGE`）
- 応答は JSON。ファイル本体はサーバーに保存しない（research R11）

## 追加するエラーコード

| HTTP | code | 発生条件 | 要件 |
|---|---|---|---|
| 422 | `IMPORT_UNKNOWN_FORMAT` | freee の仕訳帳・元帳と判別できない。`details.expected`（期待したファイルの種類）、`details.missingColumns` | FR-001 |
| 422 | `IMPORT_WRONG_KIND` | 仕訳帳を求める場面で元帳が送られた（またはその逆） | FR-001 |
| 409 | `IMPORT_FILE_CHANGED` | 確定のときのファイルのハッシュが、プレビューのハッシュと違う | FR-012 |
| 409 | `IMPORT_PLAN_CHANGED` | 確定のときに作り直したプレビューの件数が、画面が見た件数と違う（その間に帳簿が変わった）。`details.preview` に新しいプレビュー | FR-012 |
| 422 | `IMPORT_NOT_READY` | 対応が未定の名前が残っている、または新しく登録する仕訳が0件。`details.unmapped` | FR-009 |
| 409 | `IMPORT_BATCH_VOIDED` | 取消済みの取込をもう一度取り消そうとした | FR-024 |
| 409 | `CORRECTED_JOURNALS` | 取込の後に訂正された仕訳があり、`confirmCorrected` が true でない。`details.count`、`details.journalIds` | FR-026 |
| 404 | `IMPORT_BATCH_NOT_FOUND` | 取込の回がない | — |
| 413 | `FILE_TOO_LARGE` | 5 MB を超える | — |

締め済みの年度を含む取込の取消は 001 の `PERIOD_CLOSED`（`details.fiscalYears`）、会計期間がない日付は判定の `OUT_OF_PERIOD`（プレビューの中で返し、HTTP のエラーにはしない）。

## 取込（仕訳帳）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| POST | `/entities/:id/imports/freee/preview` | form: `file`、`options`（JSON 文字列の `ImportOptions`） | 200 `{ preview: ImportPreview }`。帳簿は変えない | FR-001〜006, FR-015, FR-016, FR-028〜030 |
| POST | `/entities/:id/imports/freee/commit` | form: `file`、`options`、`expected`（JSON 文字列の `{ fileSha256, countNew }`） | 201 `{ batch: ImportBatch, preview }` | FR-012〜015, FR-018 |
| GET | `/entities/:id/imports` | — | 200 `{ batches: ImportBatch[] }`（新しい順） | FR-018 |
| GET | `/entities/:id/imports/:batchId` | — | 200 `{ batch, journals: { journalId, journalNo, date, freeeJournalId, status, version }[] }` | FR-018 |
| POST | `/entities/:id/imports/:batchId/void` | `{ reason, confirmCorrected?: boolean }` | 200 `{ batch, voidedCount }` | FR-024〜027 |

### ImportOptions
```ts
{
  fiscalYears?: number[]            // 取り込む年度。省略時はファイルに含まれる、会計期間のある全年度
  include?: string[]                // 既定で対象外の仕訳（PRIOR_YEAR_CLOSING）のうち、含める freee の仕訳ID
  exclude?: string[]                // 個別に外す freee の仕訳ID（USER_EXCLUDED）
}
```
対応表はリクエストに含めない。画面は先に対応表を保存（下記）してからプレビューを作り直す。

### ImportPreview（要約）
```ts
{
  file: { name, sha256, kind: "journal", encoding, rowCount }
  years: { fiscalYear, hasPeriod, closed, counts: { new, already, excluded, rejected } }[]
  counts: { new, already, excluded, rejected, warnings }
  totals: { debit, credit }                       // new の仕訳の合計
  items: ImportPlanItem[]                         // 仕訳ごと（data-model §3）
  mappings: { accounts: MappingRow[], taxes: MappingRow[] }   // ファイルに出てくる名前と、保存済み／初期案／未定
  toCreate: { subAccounts: { accountId, name }[], partners: string[], tags: string[] }
  warnings: { code, message, freeeJournalId?, details? }[]    // FREEE_CHANGED は details.before / after
  ready: boolean                                  // 未定の対応がなく、new が1件以上
}
```

## 対応表

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/entities/:id/import-mappings` | — | 200 `{ accounts: AccountMapping[], taxes: TaxMapping[] }`（保存済みのみ） | FR-011 |
| PUT | `/entities/:id/import-mappings` | `{ accounts?: AccountMapping[], taxes?: TaxMapping[] }`（指定した行だけを追加・更新） | 200 同上 | FR-007〜011 |

```ts
AccountMapping = { sourceName: string; accountId: string; subAccountId?: string; subAccountName?: string }
TaxMapping     = { sourceName: string; taxCategory: TaxCategoryCode }
```
対応先に新しい科目が必要なときは、001 の `POST /entities/:id/accounts` で作ってから対応表を保存する（FR-010）。使用停止の科目・他の科目の補助科目は 422 `VALIDATION`。

## 期首残高（総勘定元帳）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| POST | `/entities/:id/fiscal-periods/:year/opening-balances/freee-proposal` | form: `file`（元帳） | 200 `{ proposal: OpeningProposal }`。帳簿は変えない | FR-019, FR-020, FR-020a |

保存は 001 の `PUT /entities/:id/fiscal-periods/:year/opening-balances` に案の行を渡す（新しい書き込みの経路は作らない, research R6）。
対応が未定の科目があるときは、`proposal.unmapped` に名前を入れ、その科目の行は案に含めない（画面は保存を押せない）。

## 照合

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| POST | `/entities/:id/fiscal-periods/:year/reconcile/freee` | form: `file`（その年度の元帳） | 200 `{ rows: ReconciliationRow[], allMatched: boolean, unmapped: string[] }` | FR-021〜023 |

元帳の年度と `:year` が違う（元帳の取引日が会計期間の外）ときは 422 `VALIDATION`。
