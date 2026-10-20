# Contract: HTTP API（003-tax-return）

001 の [http-api.md](../../001-ledger-core/contracts/http-api.md) の規約（ベースパス `/api`、エラー形式、Hono RPC、テナントの指定）をそのまま使う。追加するものだけを書く。入出力の正本は `packages/schema/src/blue-return.ts` の Zod 定義。年度は `:year`（例 2025）。

## 追加するエラーコード

| HTTP | code | 発生条件 | 要件 |
|---|---|---|---|
| 422 | `ENTITY_KIND_UNSUPPORTED` | 法人の事業体で決算書の API を呼んだ | Edge Cases |
| 422 | `HOME_USE_BASIS_REQUIRED` | 按分の根拠が空 | FR-012 |
| 422 | `HOME_USE_CHANGE_REASON_REQUIRED` | 前の年度と割合が違うのに理由が空 | FR-013 |
| 422 | `SMALL_ASSET_OVER_THRESHOLD` | 取得価額が基準額以上。`details.threshold`、`details.effectiveFrom` | FR-020 |
| 422 | `SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED` | 年間の上限を超える。`details.limit`、`details.total` | FR-020 |
| 422 | `SMALL_ASSET_NOT_APPLICABLE` | 取得の日が特例の適用期間外 | Edge Cases |
| 422 | `DEPRECIATION_METHOD_UNSUPPORTED` | 少額の特例以外の方法 | FR-019 |
| 422 | `HOME_USE_ACCOUNT_INVALID` | 按分の対象が費用の科目でない | FR-012 |
| 422 | `ASSET_ACCOUNT_INVALID` | 資産の勘定が資産の科目でない | FR-018 |
| 422 | `REPORT_LINE_INVALID` | 科目の欄番号の変更で、費用以外の科目、または費用の欄（8〜31）以外の番号 | FR-006 |
| 422 | `ADJUSTMENT_NOT_NEEDED` | 確定のときに作り直した案がない（差がない、帳簿の金額 ≤ 0、資産に仕訳が結びついている） | FR-014, FR-022 |
| 409 | `ADJUSTMENT_CHANGED` | 確定のときに作り直した案の金額が、画面が見た金額と違う。`details.proposal` に新しい案 | FR-015 |

締め済みの年度への登録は 001 の `PERIOD_CLOSED`。

## 決算書

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/entities/:id/blue-return/:year` | — （使わない欄は常に 0。空欄の表示は画面が行う、R14） | 200 `{ blueReturn: BlueReturn }` | FR-001〜011, FR-023〜032 |
| GET | `/entities/:id/blue-return/:year/csv` | `?blankUnused=true` | 200 `text/csv` | FR-003 |

## 科目の決算書の欄（001 の変更）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| PATCH | `/entities/:id/accounts/:accountId`（001） | `AccountPatch` に `reportLine?: number \| null` を足す | 200 `{ account }`。変更は `closing_audit_log`（`account_report_line`） | FR-006, R12a |

## 決算整理の仕訳の案

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/entities/:id/blue-return/:year/adjustments` | — | 200 `{ proposals: AdjustmentProposal[] }` | FR-014, FR-016, FR-021 |
| POST | `/entities/:id/blue-return/:year/adjustments` | `{ kind, sourceId, expected: { amount } }` | 201 `{ journal, ref }` | FR-015, FR-021 |

## 家事按分・地代家賃の内訳

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/entities/:id/blue-return/:year/home-use` | — | 200 `{ allocations, previousYear }` | FR-012 |
| PUT | `/entities/:id/blue-return/:year/home-use` | `{ accountId, subAccountId?, businessRatio, basis, changeReason? }` | 200 `{ allocation }` | FR-012〜013 |
| GET / PUT | `/entities/:id/blue-return/:year/rent-details` | PUT: `{ rows: RentDetailInput[] }`（全件の置き換え） | 200 `{ rows }` | FR-017 |

## 固定資産台帳

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/entities/:id/fixed-assets` | `?year=` | 200 `{ assets: (FixedAsset & { depreciation })[] }` | FR-018, FR-023 |
| POST | `/entities/:id/fixed-assets` | `FixedAssetInput` | 201 `{ asset }` | FR-018〜022 |
| PUT | `/entities/:id/fixed-assets/:assetId` | `FixedAssetInput & { reason }` | 200 `{ asset }` | FR-018 |
| POST | `/entities/:id/fixed-assets/:assetId/dispose` | `{ disposedOn, reason }` | 200 `{ asset }` | FR-018 |

## 控除の回答・メモ・控え・書類

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET / PUT | `/entities/:id/blue-return/:year/deduction-answers` | PUT: `DeductionAnswersInput` | 200 `{ answers, cap }` | FR-010 |
| PUT | `/entities/:id/blue-return/:year/notes/:kind` | `{ body }`（`kind`: `special_circumstances` / `opening_difference`） | 200 `{ note }` | FR-027, FR-030 |
| GET / POST | `/entities/:id/tax-return/:year/memos` | POST: `TaxReturnMemoInput` | 200 `{ memos: (TaxReturnMemo & { fileExists })[] }` / 201 | FR-033, FR-036 |
| PUT / DELETE | `/entities/:id/tax-return/:year/memos/:memoId` | | 200 / 204 | FR-033 |
| GET / POST | `/entities/:id/tax-return/:year/documents` | POST: `FiledDocumentInput` | 200 `{ documents: (FiledDocument & { fileExists })[] }` / 201 | FR-035〜036 |
| PUT / DELETE | `/entities/:id/tax-return/:year/documents/:documentId` | | 200 / 204 | FR-035 |

`fileExists` はサーバーが一覧を返すときに確かめる（research R13）。ファイルの中身は読まない。

## 取込のプレビュー（002 の変更）

`ImportWarningCode` に `TAX_CATEGORY_SUSPICIOUS_EXEMPT` を足す（`details: { count, freeeJournalIds }`）。プレビューの API の形は変えない（FR-037）。
