# Data Model: 証憑（領収書・レシート）の保存・読み取り・仕訳との紐づけ

**Feature**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **Date**: 2026-11-02

事業体の DB（tenant）に 5 表を足し、`tax_parameters` に 4 つの key を足す（表の作り直し）。registry の `ai_settings` に 1 列を足す。ファイルはデータ場所の `receipts/` とバックアップの置き場所の `trebuchet-receipts/` に置く（§1.8）。マイグレーションは §5。

金額は円の整数（`0 < amount < 1e12`、未入力は NULL）。日付は `YYYY-MM-DD`、日時は ISO 8601（UTC）、主キーは UUIDv7（`IdGenerator`）。SHA-256 は小文字の 16 進 64 文字。

## 1. 表・ファイル

### 1.1 `receipts`（証憑。FR-002・005・019。R4・R7・R10）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `received_at` | text | NOT NULL。アプリが最初のファイルを受け取った日時（受領日時、FR-002）。変えない |
| `channel` | text | `local` / `remote`（CHECK。R10。要求の Host で決める） |
| `category` | text | `paper_scan` / `electronic`（CHECK。FR-005） |
| `current_sha256` | text | NOT NULL、FK `receipt_files(sha256)`（`DEFERRABLE INITIALLY DEFERRED`。下の「循環した外部キー」）。今の版（R7） |
| `transaction_date` | text | NULL 可。`YYYY-MM-DD` |
| `amount` | integer | NULL 可。`amount > 0 AND amount < 1000000000000`（CHECK） |
| `partner_name` | text | NULL 可。1〜100 文字（CHECK `length(trim(partner_name)) > 0`） |
| `partner_key` | text | `partner_name` が NULL ⇔ NULL（CHECK）。`normalizeReceiptText(partner_name)`（R4） |
| `memo` | text | NULL 可。500 文字まで |
| `deleted_at` | text | NULL 可（論理削除、R7） |
| `deleted_reason` | text | `deleted_at` が NULL ⇔ NULL（CHECK） |
| `version` | integer | NOT NULL、既定 1（楽観ロック） |
| `created_at` / `updated_at` | text | NOT NULL |

- 索引: `receipts_search_date`（`deleted_at`, `transaction_date`）、`receipts_amount`（`amount`）、`receipts_received`（`received_at`, `id`。一覧の並びとカーソル）
- DELETE はトリガーで禁止。`received_at`・`channel`・`id` の UPDATE もトリガーで禁止。`deleted_at` は NULL から値へ 1 回だけ（削除の取り消しはない）
- 変更はすべて `receipt_audit_log`（§1.5）
- **循環した外部キー**（I1）: `receipts.current_sha256` → `receipt_files(sha256)` と `receipt_files.receipt_id` → `receipts(id)` は互いを指す。どちらを先に入れても外部キーが違反になるので、**両方の外部キーを `DEFERRABLE INITIALLY DEFERRED`** にし、コミットの時点で検査する（追加は `receipts` → `receipt_files` の順、差し替えは `receipt_files` → `receipts` の更新の順で、どちらも同じトランザクションの中）。drizzle-kit の生成は `DEFERRABLE` を出力しないので、`0014_receipts.sql` の生成後に `STRICT` と同じく手で書き足す（§5）。`PRAGMA defer_foreign_keys` は使わない（接続ごとの設定で、リポジトリの呼び出しに依存する）

### 1.2 `receipt_files`（証憑のファイルの版。FR-002・003・018。R7・R8）

| 列 | 型 | 制約 |
|---|---|---|
| `sha256` | text | PK（事業体の中で一意＝重複の判定、FR-004）。CHECK 64 文字の 16 進 |
| `receipt_id` | text | NOT NULL、FK `receipts`（`DEFERRABLE INITIALLY DEFERRED`。§1.1 の循環） |
| `file_version` | integer | NOT NULL、≥ 1。UNIQUE（`receipt_id`, `file_version`） |
| `media_type` | text | `image/jpeg` / `image/png` / `image/heic` / `application/pdf`（CHECK。中身で判定、R10） |
| `size_bytes` | integer | `> 0 AND <= 20971520`（CHECK） |
| `original_name` | text | NOT NULL（送られたファイル名。表示と取り出しの名前だけに使う。AI には送らない） |
| `width` / `height` | integer | NULL 可（PDF・調べられないとき）。> 0 |
| `full_color` | integer | NULL 可。0 / 1（R3） |
| `added_at` | text | NOT NULL |
| `channel` | text | `local` / `remote` |

- UPDATE・DELETE はトリガーで禁止（不変）
- 同じ `receipt_id` の `file_version` は 1 から連番。`receipts.current_sha256` は最大の版（INV-63）

### 1.3 `receipt_links`（証憑と仕訳の結びつき。FR-010〜013。R5）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `receipt_id` | text | NOT NULL、FK `receipts` |
| `journal_id` | text | NOT NULL、FK `journals` |
| `linked_at` | text | NOT NULL |
| `unlinked_at` | text | NULL 可 |
| `unlink_reason` | text | `unlinked_at` が NULL ⇔ NULL（CHECK） |

- 部分 UNIQUE `receipt_links_active`（`receipt_id`）WHERE `unlinked_at IS NULL`（有効な結びつきは証憑ごとに高々 1 件、INV-64）
- 索引 `receipt_links_journal`（`journal_id`）WHERE `unlinked_at IS NULL`（仕訳の詳細・一覧の件数）
- DELETE は禁止。UPDATE は `unlinked_at`・`unlink_reason` を NULL から値へ 1 回だけ（トリガー）

### 1.4 `receipt_readings`（外部の AI の読み取りの記録。FR-017。R14）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `receipt_id` | text | NOT NULL、FK `receipts` |
| `file_sha256` | text | NOT NULL、FK `receipt_files(sha256)`（読んだ版） |
| `read_at` | text | NOT NULL |
| `model` | text | NOT NULL（設定のモデル名） |
| `status` | text | `succeeded` / `invalid` / `failed` / `timeout`（CHECK） |
| `error_code` | text | NULL 可（`status <> 'succeeded'` のとき）。文字列の定数 `RECEIPT_READING_ERROR`（domain の `receipts/reading.ts`。`AI_TIMEOUT`・`AI_HTTP_ERROR`・`AI_INVALID_OUTPUT`・`RECEIPT_READ_UNSUPPORTED`・`RECEIPT_CONVERSION_FAILED`）。失敗からの写像は research R13 |
| `cand_date` / `cand_amount` / `cand_partner` / `cand_account_code` / `cand_tax_category` | text / integer / text / text / text | NULL 可（候補なし）。`status <> 'succeeded'` なら全部 NULL（CHECK） |
| `confidence` | integer | NULL 可。0〜100 |
| `compared_at` | text | NULL 可（値の比べ、R14） |
| `date_match` / `amount_match` / `partner_match` | integer | NULL 可。0 / 1 |
| `account_match` / `tax_match` | integer | NULL 可。0 / 1（証憑から仕訳を登録したとき） |

- DELETE は禁止。UPDATE は**列ごとに** NULL から値へ 1 回だけ（トリガー。`compared_at`・`date_match`・`amount_match`・`partner_match`・`account_match`・`tax_match` のそれぞれ。値の保存の比べと仕訳の登録の比べは別の機会なので、片方が書いても残りの列は後から書ける。L2）。ほかの列の UPDATE は禁止
- 画像・応答の本文の列は持たない（AI の応答の `reason` も保存しない。R14）

### 1.5 `receipt_audit_log`（証憑の履歴。追記のみ。FR-013・018。R7）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `occurred_at` | text | NOT NULL |
| `target_type` | text | `receipt` / `receipt_link` / `receipt_reading`（CHECK） |
| `target_id` | text | NOT NULL |
| `action` | text | `create` / `update` / `replace_file` / `delete` / `link` / `unlink` / `read`（CHECK） |
| `reason` | text | NULL 可 |
| `before_json` / `after_json` | text | NULL 可（`auditEntry` の値） |

- 索引 `receipt_audit_log_target`（`target_type`, `target_id`）。UPDATE・DELETE はトリガーで禁止
- 記録する値（§2.5）。`auditEntry`（`packages/domain/src/audit.ts`）で作る。型は `AuditEntry<ReceiptAuditTarget, ReceiptAuditAction>`

### 1.6 `tax_parameters`（key を追加。R2・R3・R20）

`key` の CHECK・Drizzle の enum・型 `TaxParameterKey` に 4 つを足す（表の作り直し）。正本は `packages/domain/src/seed/tax-parameters.ts`。出典は 4 行とも https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0026007-006_03.pdf （スキャナ一問一答 令和8年7月）。

| key | effective_from | effective_to | value | 根拠 |
|---|---|---|---|---|
| `RECEIPT_INPUT_CYCLE_MONTHS` | 2024-01-01 | NULL | 2 | 問23（業務処理サイクルの最長 2 か月） |
| `RECEIPT_INPUT_GRACE_BUSINESS_DAYS` | 2024-01-01 | NULL | 7 | 問22・問23（おおむね 7 営業日） |
| `RECEIPT_SCAN_MIN_LONG_PX` | 2024-01-01 | NULL | 2338 | 問26（A4 の縦 2,338 画素） |
| `RECEIPT_SCAN_MIN_SHORT_PX` | 2024-01-01 | NULL | 1654 | 問26（A4 の横 1,654 画素） |

### 1.7 registry `ai_settings`（列を追加。R15）

| 列 | 型 | 制約 |
|---|---|---|
| `receipt_images_enabled` | integer | NOT NULL、既定 0、`IN (0, 1)`（CHECK） |

- 1 にできるのは `external_enabled = 1` のときだけ（server の検査。DB の CHECK は `receipt_images_enabled = 0 OR external_enabled = 1`）
- 復元（`packages/db/src/backup/restore.ts` の `readAiSettings`・`INSERT`）の列の並びに足す

### 1.8 ファイル（R8・R9・R11）

| 置き場所 | 名前 | 中身 |
|---|---|---|
| `<データ場所>/receipts/<entityId 小文字>/` | `<sha256>.trc`（平文の SHA-256） | 形式 `TRC1`（下） |
| `<バックアップの置き場所>/trebuchet-receipts/<entityId 小文字>/` | `<HMAC-SHA256(Kname, sha256) の 16 進>.trc` | データ場所のファイルと同じバイト列 |
| `.tmp/receipt-convert-<乱数>/` | 変換の作業ファイル | 平文。`finally` で消す。起動時に残りを消す |

- **`TRC1`**: `"TRC1"（4 バイト）| salt（16）| nonce（12）| 暗号文 | タグ（16）`
  - 鍵 `Kfile = HKDF-SHA256(DK, salt, "trebuchet/receipt:<entityId 小文字>/v1")`（32 バイト、AES-256-GCM）
  - AAD = `"TRC1" | salt | nonce | UTF-8(entityId 小文字) | UTF-8(sha256)`
  - 復号は GCM の検証が通り、かつ平文の SHA-256 = 名前のときだけ平文を返す
- **`Kname = HKDF-SHA256(DK, salt=空, "trebuchet/backup/receipt-name/v1")`**（バックアップの置き場所の名前だけに使う）
- 書き込みは `<名前>.partial` に書いてから改名。同じ名前があれば書かない

## 2. 型と規則

### 2.1 型（schema、`packages/schema/src/receipts.ts`）

- `ReceiptCategory` = `"paper_scan" | "electronic"`（表示名は `paper_scan` →「紙を撮影（原本は保存）」、`electronic` →「電子取引」。web の `features/receipts/labels.ts` に 1 か所。識別子は変えない。E1）、`ReceiptChannel` = `"local" | "remote"`、`ReceiptMediaType`（§1.2 の 4 つ）
- `RECEIPT_MAX_BYTES = 20 * 1024 * 1024`、`RECEIPT_MAX_PIXELS = 100_000_000`（1 億画素。`ReceiptImageTool.probe` が `width × height` で判定し、超えれば 422 `VALIDATION` の `details.maxPixels`。R10・R12）
- `ReceiptCreateOptions`（multipart の `options`）: `{ category, transactionDate?: DateString | null, amount?: Amount | null, partnerName?: string | null, memo?: string | null }`
- `ReceiptUpdateInput`: `{ category?, transactionDate?: DateString | null, amount?: Amount | null, partnerName?: string | null, memo?: string | null, reason?: string, version: number }`（未指定の項目は変えない。null で空にする＝訂正なので理由が要る）
- `ReceiptReplaceOptions`（multipart の `options`）: `{ reason: string, version: number }`
- `ReceiptDeleteInput`: `{ reason: string, version: number }`
- `ReceiptLinkInput`: `{ journalId: Id, replace?: boolean, reason?: string }`、`ReceiptUnlinkInput`: `{ reason: string }`
- `ReceiptJournalInput`: `{ journal: JournalInput, readingId?: Id | null }`
- `ReceiptQuery`（検索、§2.3）
- `ReceiptLinkState` = `"none" | "linked" | "journal_voided"`
- `ReceiptWarningCode` = `"FIELDS_MISSING" | "INPUT_PERIOD_EXCEEDED" | "RESOLUTION_BELOW_GUIDE" | "NOT_FULL_COLOR" | "JOURNAL_VOIDED"`。`ReceiptWarning` = `{ code, details? }`（`INPUT_PERIOD_EXCEEDED` は `{ deadline }`、`RESOLUTION_BELOW_GUIDE` は `{ width, height, minLong, minShort }`）
- `ReceiptSummary`（一覧・仕訳の詳細）: `{ id, receivedAt, channel, category, transactionDate, amount, partnerName, mediaType, deleted: boolean, linkState, journal: JournalRef | null, warnings: ReceiptWarning[] }`
- `ReceiptDetail`: `ReceiptSummary` ＋ `{ memo, version, currentFile: ReceiptFileView, files: ReceiptFileView[], readings: ReceiptReadingView[], deletedAt, deletedReason }`。`ReceiptFileView` = `{ sha256, fileVersion, mediaType, sizeBytes, originalName, width, height, fullColor, addedAt, channel }`
- `ReceiptReadingView`: `{ id, readAt, model, status, errorCode, candidates: { transactionDate, amount, partnerName, accountCode, taxCategory } (各 null 可), confidence, reason: string | null }`。`reason` は `POST …/readings` の応答だけが持つ（AI の候補の説明。保存しないので、詳細の `readings` では null）
- `ReceiptHistoryEntry`: `{ occurredAt, targetType, action, reason, before, after }`
- 001 の `GET /journals` の `journals[]`（`JournalOutput`）の各項目に `receiptCount: number`、`GET /journals/:journalId` の応答（006 が `statements` を足した形）に `receipts: ReceiptSummary[]` を足す（ルートで合成、R6。`JournalOutput` の Zod は変えず、応答の型だけを広げる）
- パスのパラメーター: `ReceiptParam = { receiptId }`、`ReceiptFileParam = { receiptId, sha256 }`（事業体の `:entityId` は `tenant` ミドルウェアが処理する。ルートは `/entities/:entityId` の下、`apps/server/src/app.ts` の `tenantRoutes`）
- `AiReceiptReading`（`ai.ts`、R14。`{ transactionDate, amount, partnerName, accountCode, taxCategory, confidence, reason（200 字まで） }`）、`AiSettingsInput`・`AiSettings` に `receiptImagesEnabled: boolean`（**必須**。L2）

### 2.2 導出の規則

- **結びつきの状態**（保存しない）: 有効な結びつきがない → `none`。あって仕訳が `active` → `linked`。あって仕訳が `voided` → `journal_voided`
- **警告**（`receiptWarnings(receipt, file, link, params)`、純関数。削除済みは警告を出さない）:
  - `FIELDS_MISSING`: 取引年月日・金額・取引先のどれかが NULL（FR-005「未入力」）
  - `INPUT_PERIOD_EXCEEDED`: `category = paper_scan`、取引年月日あり、`dateOf(received_at) > deadline`。`deadline = addBusinessDays(addDays(addMonthsToDate(transaction_date, M), -1), N)`（M・N は §1.6 を取引年月日で解決。解決できなければ出さない）。`dateOf(received_at)` は **`Asia/Tokyo` に固定**した日付（`ReceiptDeps.dateOf`。server が `todayOf` と同じ変換で作って渡す。domain は `Date`・`Intl` を使わない）。比べるのは受領日時で、取引年月日を後から入れた日ではない。営業日は土日を除く
  - `RESOLUTION_BELOW_GUIDE`: `category = paper_scan`、今の版が画像で `width`・`height` あり、`max(w,h) < minLong` または `min(w,h) < minShort`（§1.6 を取引年月日〔なければ受領日〕で解決）
  - `NOT_FULL_COLOR`: `category = paper_scan`、今の版の `full_color = 0`
  - `JOURNAL_VOIDED`: 結びつきの状態が `journal_voided`
- **理由が要るか**（`needsReason(before, input)`）: 取引年月日・金額・取引先・区分のどれかが、NULL でない前の値から別の値（NULL を含む）に変わる。メモだけ・NULL の欄を埋めるだけなら要らない。差し替え・削除・付け替え・解除は常に要る
- **重複**: 追加・差し替えのファイルの SHA-256 が `receipt_files` にあれば `RECEIPT_DUPLICATE`（`details: { receiptId, deleted }`）

### 2.3 検索の条件（`ReceiptQuery`、R4）

| 条件 | 型 | 意味 |
|---|---|---|
| `dateFrom` / `dateTo` | DateString | `transaction_date BETWEEN`（両端を含む。未入力の行は外れる） |
| `amountMin` / `amountMax` | 整数 | `amount BETWEEN`（両端を含む） |
| `partner` | string（1〜100） | `partner_key LIKE '%' || normalizeReceiptText(partner) || '%' ESCAPE '\'`（`%`・`_`・`\` を逃がす） |
| `category` | `ReceiptCategory` | 一致 |
| `missing` | boolean | true なら `FIELDS_MISSING` の行だけ |
| `link` | `none` / `linked` / `journal_voided` | 結びつきの状態 |
| `includeDeleted` | boolean（既定 false） | false なら `deleted_at IS NULL` |
| `cursor` / `limit` | string / 1〜200（既定 100） | 並びは `received_at DESC, id DESC` |

- すべて AND。`normalizeReceiptText(s)` = `s.normalize("NFKC").toUpperCase().replace(/\s+/g, "")`
- 検索の正しさは INV-65（素朴なフィルタと一致）

### 2.4 結びつける仕訳の候補（`rankJournalCandidates`、R6）

- 基準日 = 取引年月日（なければ受領日の日付）。対象 = 基準日 ± `RECEIPT_CANDIDATE_WINDOW_DAYS`（14）日の有効な仕訳
- 並び: ①借方合計 = 証憑の金額（金額が未入力なら全部同順位）②`|日付の差|` ③`|借方合計 − 金額|` ④仕訳番号。上位 `RECEIPT_CANDIDATE_LIMIT`（20）件。各候補に `{ journal: JournalRef, total, daysDiff, amountMatches }`

### 2.5 履歴に書く値（`receipt_audit_log`）

| 操作 | target | before | after | reason |
|---|---|---|---|---|
| 追加 | `receipt` / `create` | null | 証憑の値（§1.1 の列）＋最初のファイルの `sha256` | null |
| 値の更新 | `receipt` / `update` | 変更前の証憑の値 | 変更後の証憑の値 | 訂正なら必須 |
| 差し替え | `receipt` / `replace_file` | `{ sha256, fileVersion }`（前の版） | `{ sha256, fileVersion }`（新しい版） | 必須 |
| 削除 | `receipt` / `delete` | 証憑の値 | `{ deletedAt }` | 必須 |
| 結びつけ | `receipt_link` / `link` | 付け替えなら前の結びつき | `{ receiptId, journalId }` | 付け替えなら必須 |
| 解除 | `receipt_link` / `unlink` | `{ receiptId, journalId }` | `{ unlinkedAt }` | 必須（自動の閉じは「結びついた仕訳が取り消されたため」） |
| 読み取り | `receipt_reading` / `read` | null | `{ receiptId, fileSha256, model, status }` | null |

- 証憑の値 = `{ category, transactionDate, amount, partnerName, memo, currentSha256, deletedAt }`（`partnerKey` は含めない）
- 過去の値の復元（`replayReceiptHistory`、純関数）: `create` の `after` から始め、`update` の `after`・`replace_file` の `after.sha256`・`delete` を順に当てる（INV-63）

## 3. 状態の移り変わり

- **証憑**: 追加（値は任意、`FIELDS_MISSING`）→ 値の入力（理由なし）→ 訂正（理由あり）・差し替え（理由あり、版 +1）→ 削除（理由あり、結びつきがあれば先に解除）。削除の後は値・ファイル・結びつき・読み取りの操作をすべて 409 `RECEIPT_DELETED`。表示・取り出し・履歴は削除の後もできる
- **結びつき**: なし → 結びつけ（`linked`）→ 仕訳の訂正（同じ `journal_id`、`linked` のまま）→ 仕訳の取消（`journal_voided`）→ 別の仕訳に結び直す（古い結びつきを自動で閉じる）／解除（`none`）。`linked` から別の仕訳へは `replace: true` と理由（付け替え）
- **読み取り**: 設定が有効 → 読み取り（記録 1 行、`succeeded` / `invalid` / `failed` / `timeout`）→ 利用者が値を保存（`date_match` などを 1 回だけ）→ 証憑から仕訳を登録（`account_match`・`tax_match` を 1 回だけ）。差し替えの後は新しい版を読み直せる
- **ファイル**: 追加・差し替えで暗号化して置く → 表示・取り出しで復号（施錠中は 401 `LOCKED`）→ バックアップで置き場所に写す（増分）→ 復元で戻す

## 4. 不変条件（001〜009 の INV-1〜60 に追加）

- **INV-61**（ファイルの暗号化）: どの内容・事業体・DK でも、`decryptReceipt(encryptReceipt(bytes, entityId, dk), entityId, sha256(bytes), dk) = bytes`。暗号文の 1 バイトの変更・切り詰め、別の DK、別の事業体、別の名前（sha256）では必ず失敗し、平文を 1 バイトも返さない。ファイル名 = 平文の SHA-256。DK・`Kfile`・`Kname` はファイル・DB・ログ・応答に出ない（INV-51 の拡張）
- **INV-62**（追加は全部か無か・重複なし）: どの追加・差し替えの列（同じ内容の繰り返し、途中の DB の失敗を含む）の後も、①`receipt_files.sha256` は事業体の中で一意 ②同じ内容の 2 回目は新しい証憑・版を作らない（`RECEIPT_DUPLICATE`）③失敗した追加・差し替えは行も、その呼び出しが作ったファイルも残さない ④`receipt_files` の各行にデータ場所のファイルがあり、復号すると `sha256` に一致する
- **INV-63**（履歴の完全性）: どの操作の列（値の入力・訂正・差し替え・削除・結びつけ・解除・読み取り）の後も、5 表の行数は減らず、`receipt_files` と `receipt_audit_log` の既存の行は変わらない。各証憑の `file_version` は 1 から連番で `current_sha256` は最大の版。`replayReceiptHistory` で `receipt_audit_log` を当てると、どの時点の証憑の値も、操作の直後の値と一致する（追加したときの値と原本を含む。SC-005）
- **INV-64**（結びつき）: 有効な結びつきは証憑ごとに高々 1 件。削除済みの証憑は有効な結びつきを持たない。有効な結びつきの仕訳は存在する。仕訳の訂正の後も結びつきは同じ `journal_id` のまま有効で、取消の後も残り状態は `journal_voided`。結びつきの操作は仕訳帳と試算表を変えない（証憑から仕訳を登録する場合を除く）
- **INV-65**（検索）: どの証憑の集合と条件（§2.3）でも、検索の結果の集合 = 素朴なフィルタ（domain の `matchesReceiptQuery`）の結果で、並びは `received_at DESC, id DESC`。全角・半角・大文字小文字・空白の違いだけの取引先は同じ結果になる
- **INV-66**（AI への送信）: `buildReceiptReadingRequest` の出力は、固定の指示文、科目のコードと名前の一覧、税区分の一覧、画像 1 枚（`image/jpeg`。APP1 は Orientation だけ、APP13・COM なし）だけからなり、取引先の一覧・仕訳・口座・メモ・元のファイル名・証憑の入力済みの値を含まない。`ReceiptReader` は外部の endpoint だけに送り、`external_enabled` と `receipt_images_enabled` がともに真のときだけ呼ばれる（それ以外は `AI_NOT_CONFIGURED` で 1 回も呼ばない）。006 の `buildAiPayload`・`createAiSuggester` は画像を受け取らない（INV-45 は 006 の経路でそのまま成り立つ）
- **INV-67**（AI の出力）: どの応答の文字列でも、`parseReceiptReading` の候補は項目ごとに `AiReceiptReading` の検証を通り、科目・税区分は事業体の一覧にあるものだけ、それ以外の項目は「候補なし」。読み取り（成功・失敗とも）は `receipts` の値を変えない
- **INV-68**（バックアップと復元）: 成功したバックアップの実行の後、その `.tbk` に含まれる各事業体の `receipt_files` のすべての `sha256` について、置き場所に `Kname` の名前のファイルがあり、その `.tbk` の DK で復号すると `sha256` に一致する。復元の後、データ場所の `receipt_files` の各行のファイルが復号できて `sha256` に一致する（SC-006）。欠けていれば `--allow-missing-receipts` なしの復元は何も変えずに `RECEIPTS_MISSING`。INV-54 は変わらない

検証: INV-61 は db の性質テスト（`fc.assert(fc.property(...))`。任意のバイト列・1 バイトの変更）。INV-62・64 は db の統合テスト（実際の UnitOfWork、`useTempDataDir`）と domain の性質テスト（`FakeUnitOfWork`・偽の `ReceiptFileStore`）。INV-63・65 は domain の性質テスト（操作の列の生成）と、INV-65 は db でも素朴なフィルタと比べる性質テスト（実行回数を絞る）。INV-66・67 は domain の性質テスト（任意の科目・税区分・JPEG のセグメント・応答の文字列）。INV-68 は db の統合テスト（`.tmp/` の置き場所、バックアップ → 復元の往復、ファイルの欠け・改ざん）。

## 5. マイグレーション

- tenant `0014_receipts.sql`: `pnpm --filter @trebuchet/db exec drizzle-kit generate --name receipts --config drizzle.tenant.config.ts`。新しい 5 表の `);` を `) STRICT;` に置き換え、**循環した 2 つの外部キー（§1.1）の `REFERENCES` に `DEFERRABLE INITIALLY DEFERRED` を手で書き足す**（`receipts.current_sha256`、`receipt_files.receipt_id`。再生成のたびに同じ書き足しが要る）。`tax_parameters` の CHECK の変更は表の作り直しになる（009 の `0011` と同じ手順で、既存の行を写す）
- tenant `0015_receipts_integrity.sql`（`--custom --name receipts_integrity`）: §1 のトリガー（DELETE の禁止、不変の列、1 回だけの UPDATE）、`tax_parameters` の 4 行の `INSERT`、作り直した `tax_parameters` のトリガーがあれば作り直す
- registry `0002_ai_receipt_images.sql`（`drizzle.registry.config.ts` で生成）: `ai_settings` に列を足す（ADD COLUMN。CHECK を含めて生成されないときは表を作り直す）
- `packages/db/test/tenant-store.test.ts` が STRICT を、`closing-repository.test.ts` の `listTaxParameters` が seed との一致（4 行を含む）を確かめる。`receipt-schema.test.ts` が循環の外部キー（`foreign_keys=ON` で、同じトランザクションの中ならどちらの順でも入り、コミットの時点で相手がなければ失敗する）と、`tax_parameters` の作り直しで既存の行が残ること（009 の `migration-depreciation.test.ts` と同じ形）を確かめる
