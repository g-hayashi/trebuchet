# Contract: ドメイン層のモジュール（010 の追加分）

001 の [domain-module.md](../../001-ledger-core/contracts/domain-module.md) に追加する。置き場所は `packages/domain/src/receipts/`（純関数。I/O・`node:` の import をしない）と `packages/domain/src/usecases/`。式・表は [data-model.md](../data-model.md)、根拠は [research.md](../research.md)。暗号化・ファイル・`sips`・AI の呼び出しはポート（§4）の向こう側（db・server）に置く。

## 1. 定数・データ

| 名前 | 場所 | 内容 |
|---|---|---|
| `TAX_PARAMETERS` | `seed/tax-parameters.ts` | 4 行を足す（data-model §1.6、R20） |
| `RECEIPT_CANDIDATE_WINDOW_DAYS = 14`、`RECEIPT_CANDIDATE_LIMIT = 20` | `receipts/candidates.ts` | 候補の範囲と件数（R6） |
| `RECEIPT_AI_MAX_PX = 2048` | `receipts/reading-prompt.ts` | AI に送る画像の長辺（R12） |
| `RECEIPT_READING_SYSTEM_PROMPT` | `receipts/reading-prompt.ts` | 固定の指示文（R13。変えるときは `pnpm eval:receipts` を前後で比べる、R17） |
| `RECEIPT_REASON_AUTO_VOIDED = "結びついた仕訳が取り消されたため"` | `receipts/history.ts` | 自動で閉じる結びつきの理由（R5） |
| `RECEIPT_READING_ERROR` | `receipts/reading.ts` | `receipt_readings.error_code` の文字列の定数: `AI_TIMEOUT`・`AI_HTTP_ERROR`・`AI_INVALID_OUTPUT`・`RECEIPT_READ_UNSUPPORTED`・`RECEIPT_CONVERSION_FAILED`（R13 の写像。ErrorCode ではない） |

`RECEIPT_MAX_BYTES`・`RECEIPT_MAX_PIXELS` は schema（`packages/schema/src/receipts.ts`）に置き、domain・server はそれを import する。

## 2. 関数（純関数）

| 関数 | 場所 | 入力 | 出力 | 要件・不変条件 |
|---|---|---|---|---|
| `detectReceiptFormat(bytes)` | `receipts/format.ts` | `Uint8Array`（先頭だけ見る） | `ReceiptMediaType \| undefined`（R10 のマジックバイト。HEIC は `ftyp` の major・compatible brands） | FR-001, R10 |
| `normalizeReceiptText(text)` | `receipts/search.ts` | | NFKC → 大文字 → 空白を除く | R4, INV-65 |
| `matchesReceiptQuery(receipt, linkState, query)` | `receipts/search.ts` | data-model §2.3 | `boolean`（db の SQL の検索の正解。テストの素朴なフィルタ） | INV-65 |
| `escapeLike(text)` | `receipts/search.ts` | | `%`・`_`・`\` を `\` で逃がした文字列（db が使う） | R4 |
| `addMonthsToDate(date, months)`、`addBusinessDays(date, days)` | `dates.ts`（既存のファイルに足す） | `YYYY-MM-DD` | 月の加算（日は月末に丸める）、土日を除く営業日の加算 | R2 |
| `inputDeadline(transactionDate, params)` | `receipts/warnings.ts` | `params` は解決済みの M・N | `YYYY-MM-DD`（data-model §2.2） | FR-022, R2 |
| `receiptWarnings(input)` | `receipts/warnings.ts` | `{ receipt, currentFile, linkState, receivedDate, taxParameters }` | `ReceiptWarning[]`（data-model §2.2。削除済みは空） | FR-005, FR-013, FR-022, R2, R3 |
| `linkStateOf(link, journalStatus)` | `receipts/history.ts` | 有効な結びつき（なければ undefined）と仕訳の状態 | `ReceiptLinkState` | R5 |
| `needsReason(before, input)` | `receipts/history.ts` | 今の値と `ReceiptUpdateInput` | `boolean`（data-model §2.2） | FR-018, R7 |
| `replayReceiptHistory(entries)` | `receipts/history.ts` | 1 件の証憑の `receipt_audit_log`（古い順） | 各時点の証憑の値の列 | SC-005, INV-63 |
| `rankJournalCandidates(receipt, journals, today)` | `receipts/candidates.ts` | 範囲の有効な仕訳 | data-model §2.4 の候補（上位 20 件） | FR-011, R6 |
| `stripJpegMetadata(jpeg)` | `receipts/jpeg-metadata.ts` | JPEG のバイト列 | APP1（Exif・XMP）・APP13・COM を除き、Exif の Orientation があれば Orientation だけの最小の APP1 を SOI の直後に置いた JPEG。JPEG でなければ `err(VALIDATION)` | R12, INV-66 |
| `buildReceiptReadingRequest(jpeg, context)` | `receipts/reading-prompt.ts` | メタデータを除いた JPEG、`SuggestionContext`（006 と同じ型。科目のコードと名前、税区分） | `ReceiptReadingRequest` = `{ system: string, choices: string, image: { mediaType: "image/jpeg", bytes: Uint8Array }, schema: object }`（`schema` は `response_format` の `json_schema`。各項目は null 可） | FR-015, R13, INV-66 |
| `parseReceiptReading(raw, context)` | `receipts/reading.ts` | 応答の `content` の文字列（`unknown`） | `{ status: "succeeded" \| "invalid", candidates: { transactionDate, amount, partnerName, accountCode, taxCategory }, confidence: number \| null, reason: string \| null }`（`reason` は 200 字まで。超えれば null。保存しない）（項目ごとに `AiReceiptReading` の該当の Zod で検証。科目・税区分は一覧にあるものだけ。JSON でなければ `invalid` で全部 null） | FR-016, R14, INV-67 |
| `compareReadingWithSaved(candidates, saved)` | `receipts/reading.ts` | 候補と保存した値 | `{ dateMatch, amountMatch, partnerMatch }`（取引先は `normalizeReceiptText` で比べる。候補が null の項目は null） | FR-017, R14 |
| `compareReadingWithJournal(candidates, journal)` | `receipts/reading.ts` | 候補と登録した仕訳 | `{ accountMatch, taxMatch }`（仕訳のどれかの行の科目コード・税区分と同じか） | FR-017, R14 |

## 3. ユースケース

依存は `ReceiptDeps = { uow: ReceiptUnitOfWork, files: ReceiptFileStore, clock: Clock, ids: IdGenerator, dateOf: (iso: string) => string }`（読み取りは `+ images: ReceiptImageTool, reader: ReceiptReader | undefined`）。**`dateOf(iso)` は ISO 8601（UTC）の日時を `Asia/Tokyo` の `YYYY-MM-DD` にする関数**で、server が `todayOf(clock)` と同じ変換で作って渡す（domain は `Date`・`Intl` を使わない。警告の `receivedDate` と候補の基準日〔受領日〕に使う。I2）。server の組み立ては `apps/server/src/deps.ts` の `receiptDeps(db, clock, entityId, options)`（`statementDeps` と同形。`createApp` の `receipts: { imageTool, reader, files }` で差し替える。T015・T034）。複数回書くものは 1 つの `uow.run` の中で書く（AGENTS.md）。

| 関数 | 場所 | 説明 |
|---|---|---|
| `addReceipt(deps, { bytes, originalName, channel, options, probe })` | `usecases/receipts.ts` | `probe` は呼び出し側（server）が `ReceiptImageTool.probe` で調べた `{ width, height, fullColor } \| null`（画素数の上限を超えたときは server がここへ来る前に 422 で返す）。**同期の区間**（`await` を挟まない、R10）: `detectReceiptFormat` → 大きさ → `files.digest` → 既存の `sha256`（`RECEIPT_DUPLICATE`）→ `files.has` でなければ `files.put` → `uow.run`（`receipts`・`receipt_files`（版 1）・`receipt_audit_log`（`create`））→ 失敗ならこの呼び出しが `put` したファイルだけ `files.discard`。`Result<ReceiptDetail>` |
| `listReceipts(deps, query)` | 同上 | `ReceiptStore.search` の結果に `linkStateOf`・`receiptWarnings` を付ける。`Result<{ receipts, nextCursor }>` |
| `getReceipt(deps, receiptId)` | 同上 | 詳細（版・読み取り・警告）。`RECEIPT_NOT_FOUND` |
| `updateReceipt(deps, receiptId, input)` | 同上 | **2 段で作る（D1）**。**US1（T017b）**: 削除済み → `RECEIPT_DELETED`、`version` 不一致 → `VERSION_CONFLICT`、値の検査（`VALIDATION`）→ 未入力の値を埋める・メモを変える → `update` の履歴（理由なし）。`needsReason` が真（入力済みの値の変更）なら、この段では訂正を受けず 422 `REASON_REQUIRED` を返す。**US5（T027）**: `reason` があれば（001 の `checkReason` を通して）訂正として受け、履歴に理由を残す。理由がなければ引き続き `REASON_REQUIRED`。**US4（T033）**: 更新の後に今の版の未比較の `succeeded` の読み取りへ `compareReadingWithSaved` を、列ごとに 1 回だけ書く |
| `replaceReceiptFile(deps, receiptId, { bytes, originalName, channel, reason, version, probe })` | 同上 | `addReceipt` と同じ同期の区間で、版 +1 の `receipt_files` と `current_sha256` の更新、`replace_file` の履歴 |
| `deleteReceipt(deps, receiptId, { reason, version })` | 同上 | 有効な結びつき → `RECEIPT_LINKED`、論理削除、`delete` の履歴 |
| `getReceiptHistory(deps, receiptId)` | 同上 | `receipt_audit_log` の古い順 |
| `readReceiptFile(deps, receiptId, sha256)` | 同上 | その証憑の版か確かめて `files.read`（復号とハッシュの検証は `ReceiptFileStore`）。`Result<{ bytes, mediaType, originalName }>`。表示の変換は server（`ReceiptImageTool.toDisplay`） |
| `linkInTx(tx, deps, receiptId, { journalId, replace, reason })`（内部。export しない） | 同上 | **`tx` を受ける共通の関数**（L1）。`linkReceipt` と `createJournalFromReceipt` がどちらも呼ぶ。`uow.run` を自分で開かない（入れ子の `run` を作らない）。規則は下の `linkReceipt` のとおり |
| `linkReceipt(deps, receiptId, { journalId, replace, reason })` | `usecases/receipt-links.ts` | 1 つの `uow.run` の中で `linkInTx` を呼ぶ: 証憑（削除済み → `RECEIPT_DELETED`）、仕訳（`JOURNAL_NOT_FOUND`・`JOURNAL_VOIDED`）、今の結びつきが `linked` で別の仕訳 → `replace` と理由がなければ `RECEIPT_ALREADY_LINKED`・`REASON_REQUIRED`、`journal_voided` なら自動で閉じる → 新しい結びつき → 履歴。同じ仕訳なら何もしない |
| `unlinkReceipt(deps, receiptId, { reason })` | 同上 | 有効な結びつきを閉じる（なければ `VALIDATION`）、`unlink` の履歴 |
| `createJournalFromReceipt(deps, receiptId, { journal, readingId })` | 同上 | 1 つの `uow.run` の中で、006 の `approveCandidate` と同じく `tx` の帳簿で 001 の `createJournal` を呼ぶ → 結びつき（同じ `tx` で `linkInTx`。`replace` なしなので `linked` なら `RECEIPT_ALREADY_LINKED`、`journal_voided` なら自動で閉じる）→ 履歴 → `readingId` があれば `compareReadingWithJournal` を 1 回だけ書く。`Result<{ journal, receipt }>` |
| `listJournalCandidates(deps, receiptId)` | 同上 | `ledger.findJournals`（基準日 ± 14 日、取消を除く）→ `rankJournalCandidates` |
| `listJournalReceipts(deps, journalId)`、`countReceiptsByJournal(deps, journalIds)` | 同上 | 仕訳の詳細・一覧の合成用（R6） |
| `readReceipt(deps, receiptId)` | `usecases/receipt-reading.ts` | 3 段（R13）: ①`uow.run` で証憑（削除済み → `RECEIPT_DELETED`）・今の版・科目・税区分を読む。`reader` が undefined（設定で無効）なら `AI_NOT_CONFIGURED` ②UnitOfWork の外で `files.read` → `images.toAiJpeg(bytes, mediaType, RECEIPT_AI_MAX_PX)` → `stripJpegMetadata` → `buildReceiptReadingRequest` → `reader.read` → `parseReceiptReading` ③`uow.run` で `receipt_readings` と `read` の履歴を書く。変換・AI の失敗も ③ で記録して `ok(reading)` を返す（失敗から `status`・`error_code`（`RECEIPT_READING_ERROR`）への写像は research R13） |

## 4. ポート（`packages/domain/src/ports.ts` に追加）

```ts
/** 証憑の表（packages/db の receipt-repository.ts が実装。UnitOfWork の run の中で使う） */
interface ReceiptStore {
  insertReceipt(row: ReceiptRow): void
  updateReceipt(row: ReceiptRow, expectedVersion: number): void   // 不一致は RepositoryConflictError
  getReceipt(id: string): ReceiptRow | undefined
  insertFile(row: ReceiptFileRow): void
  listFiles(receiptId: string): ReceiptFileRow[]
  findFileBySha(sha256: string): ReceiptFileRow | undefined        // 重複の判定（削除済みを含む）
  search(query: ReceiptQuery): { rows: ReceiptSearchRow[]; nextCursor: string | null }  // 結びつきと仕訳の状態を含む
  getActiveLink(receiptId: string): ReceiptLinkRow | undefined
  insertLink(row: ReceiptLinkRow): void
  closeLink(id: string, at: string, reason: string): void
  listActiveLinksByJournal(journalId: string): ReceiptLinkRow[]
  countActiveLinksByJournal(journalIds: readonly string[]): Map<string, number>
  insertReading(row: ReceiptReadingRow): void
  listReadings(receiptId: string): ReceiptReadingRow[]
  setReadingOutcome(id: string, outcome: Partial<ReadingOutcome>, at: string): void  // NULL の列だけ
  appendAudit(entry: ReceiptAuditEntry): void
  listAudit(receiptId: string): ReceiptAuditEntry[]
}
type ReceiptUnitOfWork = TenantUnitOfWork<{ receipts: ReceiptStore }>

/** 暗号化した証憑のファイル（packages/db の receipt-files.ts が実装。事業体ごとに作る。施錠中は VaultLockedError） */
interface ReceiptFileStore {
  digest(bytes: Uint8Array): string          // 平文の SHA-256（16 進）
  has(sha256: string): boolean
  put(sha256: string, bytes: Uint8Array): void   // TRC1 で暗号化して .partial → 改名。同じ名前があれば何もしない
  read(sha256: string): Uint8Array           // 復号と SHA-256 の検証。失敗は ReceiptFileUnreadableError
  discard(sha256: string): void              // 追加の失敗の後始末だけに使う
}

/** 画像の変換（server の image-tool.ts が sips で実装。テストは偽物） */
interface ReceiptImageTool {
  /** 調べられない（PDF など）は ok(undefined)。width × height が RECEIPT_MAX_PIXELS を超えれば err(VALIDATION, details.maxPixels) */
  probe(bytes: Uint8Array, mediaType: ReceiptMediaType): Promise<Result<{ width: number; height: number; fullColor: boolean | null } | undefined>>
  toDisplay(bytes: Uint8Array, mediaType: ReceiptMediaType): Promise<Result<{ bytes: Uint8Array; mediaType: string }>>
  toAiJpeg(bytes: Uint8Array, mediaType: ReceiptMediaType, maxPx: number): Promise<Result<Uint8Array>>
}

/** 外部の AI による証憑の読み取り（server の ai-client.ts の createReceiptReader。外部の endpoint だけを持つ） */
interface ReceiptReader {
  /** 記録するモデル名 */
  model(): Promise<string | undefined>
  /** 応答の message.content をそのまま返す。時間切れは details.timeout つきの失敗 */
  read(request: ReceiptReadingRequest): Promise<Result<unknown>>
}
```

- 偽物は `packages/domain/test/fakes/receipts.ts`（`FakeReceiptStore`、メモリーの `FakeReceiptFileStore`、`FakeImageTool`、`FakeReceiptReader`）。`fakes.ts` から再エクスポートする
- `ReceiptFileStore` の実装は `createReceiptFileStore(entityId)`（`packages/db/src/receipt-files.ts`）。鍵は `withDataKey` の中で作る
- server は `readReceipt` に、設定（R15）が有効なときだけ `createReceiptReader(...)` を、無効なら `undefined` を渡す
