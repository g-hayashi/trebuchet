# Contract: HTTP API（010-receipts）

001 の [http-api.md](../../001-ledger-core/contracts/http-api.md) の規約（ベースパス `/api`、エラー形式、Hono RPC、テナントの指定）と、004・008 の検査（Host → CSRF → 認証、施錠中は 401 `LOCKED`）をそのまま使う。追加・変更するものだけを書く。入出力の正本は `packages/schema/src/receipts.ts`（と `ai.ts`・`errors.ts`）の Zod 定義、型は [data-model.md](../data-model.md) §2.1。ルートは `respond(c, result, ...)` で返す（AGENTS.md）。新しいルートはすべて認証が要る（`requiresAuth` の公開の一覧に足さない。INV-29 のテストが自動で拾う）。

## 1. 追加するエラーコード

| HTTP | code | 発生条件 | 要件 |
|---|---|---|---|
| 404 | `RECEIPT_NOT_FOUND` | 証憑がない（別の事業体の ID を含む）。ファイルの版（`sha256`）がその証憑のものでない | — |
| 422 | `RECEIPT_FORMAT_UNSUPPORTED` | 中身が JPEG・PNG・HEIC・PDF のどれでもない（拡張子・`Content-Type` によらない）。`details.detected`（分かれば） | FR-001, FR-007, R10 |
| 409 | `RECEIPT_DUPLICATE` | 同じ事業体に同じ SHA-256 のファイルがある（削除済み・差し替え前の版を含む）。`details.receiptId`、`deleted` | FR-004, R10 |
| 409 | `RECEIPT_DELETED` | 削除済みの証憑の値の変更・差し替え・削除・結びつけ・読み取り | FR-019, R7 |
| 409 | `RECEIPT_LINKED` | 有効な結びつきのある証憑の削除。`details.journalId` | FR-019 |
| 409 | `RECEIPT_ALREADY_LINKED` | 有効な仕訳（`active`）に結びついている証憑を、`replace: true` なしで別の仕訳に結びつけた。`details.journalId` | FR-011, R5 |
| 500 | `RECEIPT_FILE_UNREADABLE` | データ場所のファイルがない・復号できない・ハッシュが合わない（改ざん、復元の欠け）。`details.sha256` | FR-009, INV-62 |
| 500 | `RECEIPT_CONVERSION_FAILED` | 表示用の変換（HEIC → JPEG）に失敗（`sips` がない、時間切れ） | FR-009, R12 |

- 既存のコードを使う: 413 `FILE_TOO_LARGE`（20 MB を超える）、400 `VALIDATION`、422 `REASON_REQUIRED`、409 `VERSION_CONFLICT`、404 `JOURNAL_NOT_FOUND`、409 `JOURNAL_VOIDED`（取消済みの仕訳に結びつける）、422 `AI_NOT_CONFIGURED`（読み取りの条件を満たさない、R13・R15）、401 `LOCKED`、001 の仕訳の登録のコード（`UNBALANCED`、`PERIOD_CLOSED` など）
- AI の読み取りの失敗（時間切れ、HTTP のエラー、形の不一致、PDF を描けない）は HTTP のエラーにせず、201 で読み取りの記録の `status` と `errorCode`（`AI_TIMEOUT`・`AI_HTTP_ERROR`・`AI_UNREACHABLE`・`AI_INVALID_OUTPUT`・`RECEIPT_READ_UNSUPPORTED`・`RECEIPT_CONVERSION_FAILED`）で返す（FR-017。記録が残る）
- `apps/server/src/errors.ts` の `ERROR_STATUS`（`satisfies Record<ErrorCode, …>`）に上の HTTP の値を足す。エラーコードを足したら `grep -rn` で同じ値を参照するテストと web の表示を直す（AGENTS.md）

## 2. 証憑（`/entities/:id/receipts`）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| POST | `/entities/:id/receipts` | multipart: `file`（20 MB まで）、`options`（JSON、`ReceiptCreateOptions`）。`uploadLimitFor(1, RECEIPT_MAX_BYTES)` | 201 `{ receipt: ReceiptDetail }`。413 `FILE_TOO_LARGE`、422 `RECEIPT_FORMAT_UNSUPPORTED`、409 `RECEIPT_DUPLICATE` | FR-001〜005, FR-007, FR-022, R10 |
| GET | `/entities/:id/receipts` | query `ReceiptQuery`（data-model §2.3） | 200 `{ receipts: ReceiptSummary[], nextCursor: string \| null }` | FR-008, R4 |
| GET | `/entities/:id/receipts/:receiptId` | — | 200 `{ receipt: ReceiptDetail }`（削除済みも返す） | FR-009 |
| GET | `/entities/:id/receipts/:receiptId/files/:sha256` | `?variant=original\|display`（既定 `display`）、`?download=1` | 200 本文（`Content-Type` は版の `media_type`。`display` で HEIC なら `image/jpeg`）。`Cache-Control: no-store`、`Content-Disposition`（`download=1` なら `attachment` と元の名前〔RFC 5987〕、それ以外は `inline`）、`X-Content-Type-Options: nosniff`。404・500 `RECEIPT_FILE_UNREADABLE`・500 `RECEIPT_CONVERSION_FAILED` | FR-009, R9, R12 |
| PATCH | `/entities/:id/receipts/:receiptId` | `ReceiptUpdateInput` | 200 `{ receipt: ReceiptDetail }`。422 `REASON_REQUIRED`（訂正で理由がない）、409 `VERSION_CONFLICT`・`RECEIPT_DELETED` | FR-005, FR-018, R7, R14 |
| POST | `/entities/:id/receipts/:receiptId/files` | multipart: `file`、`options`（`ReceiptReplaceOptions`） | 201 `{ receipt: ReceiptDetail }`（版 +1）。413・422・409 は追加と同じ、`REASON_REQUIRED`・`VERSION_CONFLICT`・`RECEIPT_DELETED` | FR-018, US5 シナリオ2 |
| POST | `/entities/:id/receipts/:receiptId/delete` | `ReceiptDeleteInput` | 200 `{ receipt: ReceiptDetail }`。409 `RECEIPT_LINKED`・`RECEIPT_DELETED`・`VERSION_CONFLICT`、422 `REASON_REQUIRED` | FR-019 |
| GET | `/entities/:id/receipts/:receiptId/history` | — | 200 `{ history: ReceiptHistoryEntry[] }`（古い順） | FR-018, SC-005 |

- 経路（`channel`）はサーバーが要求の Host で決める（`isLocalHost` なら `local`、それ以外は `remote`。R10）。`options` に経路を持たない
- 追加・差し替えの応答の `warnings` に `INPUT_PERIOD_EXCEEDED`・`RESOLUTION_BELOW_GUIDE`・`NOT_FULL_COLOR` が出ても 201（保存は拒まない、FR-022）
- 削除は `DELETE` メソッドではなく `POST .../delete`（理由の本文を送る。001 の `void` と同じ形）

## 3. 仕訳との結びつき

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/entities/:id/receipts/:receiptId/journal-candidates` | — | 200 `{ candidates: { journal: JournalRef, total: number, daysDiff: number, amountMatches: boolean }[] }`（data-model §2.4） | FR-011, R6 |
| POST | `/entities/:id/receipts/:receiptId/link` | `ReceiptLinkInput` | 201 `{ receipt: ReceiptDetail }`。404 `JOURNAL_NOT_FOUND`、409 `JOURNAL_VOIDED`・`RECEIPT_ALREADY_LINKED`・`RECEIPT_DELETED`、422 `REASON_REQUIRED`（付け替えで理由がない） | FR-011, FR-013, R5 |
| POST | `/entities/:id/receipts/:receiptId/unlink` | `ReceiptUnlinkInput` | 200 `{ receipt: ReceiptDetail }`。409 `RECEIPT_DELETED`、422 `REASON_REQUIRED`、有効な結びつきがなければ 422 `VALIDATION` | FR-013 |
| POST | `/entities/:id/receipts/:receiptId/journal` | `ReceiptJournalInput`（`journal` は 001 の `JournalInput`） | 201 `{ journal, receipt: ReceiptDetail }`。001 の `createJournal` のエラー、409 `RECEIPT_ALREADY_LINKED`（有効な仕訳に結びついている）・`RECEIPT_DELETED` | FR-010, R14 |

- `link` は、今の結びつきの仕訳が取り消されている（`journal_voided`）なら、`replace` なしで古い結びつきを自動で閉じて結び直す（R5）
- `journal` は 1 つの `ReceiptUnitOfWork` で 仕訳の登録 → 結びつき → 履歴 →（`readingId` があれば）`account_match`・`tax_match` を書く。どれかが失敗すれば全部戻る
- web は証憑から仕訳を登録した後に `invalidateLedger(queryClient, entityId)` を呼ぶ（AGENTS.md）

## 4. 仕訳の API（001 の応答に足す。R6）

| メソッド | パス | 変更 |
|---|---|---|
| GET | `/entities/:id/journals` | `journals[]` の各項目に `receiptCount: number`（有効な結びつきの数）。ルートで `countReceiptsByJournal` を引いて合成する |
| GET | `/entities/:id/journals/:journalId` | 応答に `receipts: ReceiptSummary[]`（有効な結びつきの証憑）。006 の `statements` と同じくルートで合成する |

- 001 の `LedgerRepository`・`Journal`・`JournalOutput` の Zod は変えない。web の `features/journals/api.ts` の型（Hono RPC の推論）が変わるので、`apps/web/test/mock-api.ts` の仕訳の既定の応答に `receiptCount: 0`・`receipts: []` を足す

## 5. 外部の AI の読み取り（US4）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| POST | `/entities/:id/receipts/:receiptId/readings` | — （今の版を読む） | 201 `{ reading: ReceiptReadingView }`（失敗も 201 で `status`・`errorCode`）。422 `AI_NOT_CONFIGURED`（外部の AI か証憑の送信が無効、接続先・モデル・キーが欠ける）、409 `RECEIPT_DELETED` | FR-014〜017, R13, R14 |

- 応答の `candidates` は入力欄の初期値にだけ使う。証憑の値は変わらない（INV-67）
- 時間切れは `RECEIPT_READ_TIMEOUT_MS`（90 秒）。要求は最長でその間待つ

## 6. AI の設定（006 を変更。R15）

| メソッド | パス | 変更 |
|---|---|---|
| GET | `/settings/ai` | `AiSettings` に `receiptImagesEnabled: boolean` |
| PUT | `/settings/ai` | `AiSettingsInput` に `receiptImagesEnabled: boolean`（省略時は今の値のまま）。`externalEnabled` が偽（または外部の必須項目が欠ける）のに真にしたら 422 `AI_NOT_CONFIGURED`。`externalEnabled` を偽にしたら `receiptImagesEnabled` も偽にする |

## 7. schema（Zod）の変更点

- 新規 `packages/schema/src/receipts.ts`: `RECEIPT_MAX_BYTES`、`ReceiptCategory`、`ReceiptChannel`、`ReceiptMediaType`、`ReceiptCreateOptions`、`ReceiptUpdateInput`、`ReceiptReplaceOptions`、`ReceiptDeleteInput`、`ReceiptLinkInput`、`ReceiptUnlinkInput`、`ReceiptJournalInput`、`ReceiptQuery`、`ReceiptLinkState`、`ReceiptWarningCode`・`ReceiptWarning`、`ReceiptSummary`、`ReceiptDetail`、`ReceiptFileView`、`ReceiptReadingView`、`ReceiptHistoryEntry`、`ReceiptParam`（`{ id, receiptId }`）・`ReceiptFileParam`（`+ sha256` は 64 文字の 16 進）。`index.ts` から再エクスポート
- `ai.ts`: `AiReceiptReading`、`AiSettingsInput`・`AiSettings` に `receiptImagesEnabled`
- `errors.ts`: §1 の 8 コード（`// 010-receipts（contracts/http-api.md §1）` の見出しで）

## 8. web

- `features/receipts/api.ts` に query key と呼び出しを置く（画面のファイルで `api.api...`・`unwrap(...)` を直接呼ばない）。multipart の送信は 007 の `features/statements/api.ts` の送り方に倣う
- `apps/web/test/mock-api.ts` に `/receipts` の一覧・詳細・候補・履歴と `/settings/ai` の `receiptImagesEnabled` の既定の応答を足す
- ルート（`routes/e/$entityId/receipts/index.tsx`・`$receiptId.tsx`・`capture.tsx`）を足したら `pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成する
