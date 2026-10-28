# HTTP API: 汎用の明細取込

006 の `specs/006-mfme-ai-journal/contracts/http-api.md` のうち、取込（§3.1〜§3.3）を置き換え、取込元（§3）と列の案（§4）を足す。認証・Host・CSRF は全ルートに掛かる（004）。パスは `/api/e/:entityId` の下。

## 1. エラーコード

| コード | HTTP | 意味 | details |
|---|---|---|---|
| `STATEMENT_TABLE_UNREADABLE` | 422 | 表を読めない（空、必須の列がない、1 行も読めない）。006 の `STATEMENT_PASTE_UNREADABLE` の名前を変えたもの | `missingColumns?: string[]`、`unreadable: {line, reason}[]` |
| `STATEMENT_TABLE_TOO_LARGE` | 422 | 行数・列数が上限を超える（R12）。バイト数の超過は 002 の `readUpload` の既存のエラー | `maxRows`、`maxColumns` |
| `STATEMENT_MAPPING_INVALID` | 422 | 列の対応が §data-model 3 の検証を通らない、または列の番号が表の列数を超える | `issues` |
| `STATEMENT_ACCOUNT_UNMAPPED` | 422 | 006 と同じ。commit で、対応のない口座が `accounts` にも入っていない | `names` |
| `STATEMENT_SOURCE_NOT_FOUND` | 404 | 取込元がない | |
| `STATEMENT_SOURCE_NAME_TAKEN` | 409 | 取込元の名前が重複 | |
| `STATEMENT_PLAN_CHANGED` | 409 | 006 と同じ | |

## 2. 取込

すべて multipart/form-data: `file`（貼り付けは web が UTF-8 の Blob にしたもの）、`options`（JSON 文字列）。

### 2.1 `POST /statements/imports/layout`

`options`: `{ origin: "paste" | "file", sourceId?: Id, encoding?: "utf-8" | "shift_jis", delimiter?: Delimiter, headerRow?: number | null }`（`encoding`・`delimiter`・`headerRow` は利用者の選び直し。§2.2・§2.3・§4.1 も同じ `encoding` を受け、layout で使った値を送る）

`200`: `StatementTableLayout`（data-model §3）。`sourceId` を指定し、見出しが違えば `headerDiff` と、見出しの名前の同じ列の役割を引き継いだ `suggestedColumns` を返す

### 2.2 `POST /statements/imports/preview`

`options`:
```text
{ origin, year: number,               // 年のない日付にだけ使う
  mapping: StatementColumnMapping,
  fixedAccountName?: string,          // mapping が accountName を持たないとき必須（INV-50）
  sourceId?: Id }                     // 当てはめた取込元（表示と last_used_at のため）
```

`200`: 006 の `StatementImportPreview` に次の変更:
- `unmappedAccounts: { name: string, suggestion: StatementAccountSuggestion | null }[]`（R9）
- `source: { id, name } | null`

### 2.3 `POST /statements/imports`

`options`: §2.2 の内容に次を足す:
```text
{ expected: { inputSha256, countNew },
  accounts: { name: string, input: StatementAccountInput }[],   // 未対応の口座の対応（R9）。既に対応のある口座は入れない
  saveSource: { id?: Id, name: string } | null }                // 取込元を保存・更新する。null は保存しない
```

`201`: `{ batch, added, changed, source: StatementSource | null }`。`batch.sourceName` を足す

- 未対応の口座が `accounts` にもなければ 422 `STATEMENT_ACCOUNT_UNMAPPED`
- `saveSource.name` が別の取込元と重複すれば 409 `STATEMENT_SOURCE_NAME_TAKEN`
- 口座の対応・取込元・明細・取込の回は 1 つの UnitOfWork で書く（INV-47）

### 2.4 `GET /statements/imports`

006 と同じ。各回に `sourceName` を足す。

## 3. 取込元

- `GET /statement-sources` → `{ sources: StatementSource[] }`（`last_used_at` の新しい順）
- `PATCH /statement-sources/:id` body `{ name }` → `{ source }`。409 `STATEMENT_SOURCE_NAME_TAKEN`、404
- `DELETE /statement-sources/:id` → 204。明細・取込の回・仕訳は変わらない

## 4. 列の対応の案（端末内の AI）

### 4.1 `POST /statements/imports/column-suggestion`

multipart（§2 と同じ）。`options`: `{ origin, delimiter?, headerRow? }`

`200`: `{ suggestion: { columns: Partial<Record<Role, number>>, amountSign: AmountSign | null, confidence: number } | null, unavailable?: "disabled" | "unavailable" | "timeout" | "invalid" }`

- 端末内の AI だけを呼ぶ。外部の AI の設定は読まない（FR-018）
- 辞書の案で必須の役割がそろう表では呼ばない（`suggestion: null`、`unavailable` なし）
- 時間切れは 20 秒（R10）

## 5. 変更しない API

`/statement-accounts`（006 §2）、候補・承認・除外・ルール・評価（006 §4〜§7）は変えない。
