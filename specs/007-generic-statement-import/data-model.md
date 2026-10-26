# Data Model: 汎用の明細取込

006 の表（`specs/006-mfme-ai-journal/data-model.md` §1）は、ここに書いた変更のほかはそのまま使う。

## 1. 表（tenant）

### 1.1 `statement_sources`（新規）— 取込元と列の対応

| 列 | 型 | 制約 | 意味 |
|---|---|---|---|
| `id` | TEXT | PK | `IdGenerator` |
| `name` | TEXT | NOT NULL, UNIQUE, 1〜100 字 | 利用者がつけた名前（1 つの口座の取込元は、既定で口座の名前） |
| `fixed_account_name` | TEXT | NULL 可 | 1 つの口座の取込元の口座の名前（`statement_accounts.name` と同じ値。外部キーにしない。口座はこの取込で初めて作られることがある）。NULL はまとめの取込元 |
| `header_signature` | TEXT | NULL 可 | 見出しの署名（正規化した見出しのセルの JSON 配列）。NULL は見出しなし |
| `mapping_json` | TEXT | NOT NULL | `StatementColumnMapping`（§3）の JSON |
| `last_used_at` | TEXT | NOT NULL | 最後に取込を確定した日時（2 件以上が当たったときの並びに使う） |
| `created_at` / `updated_at` | TEXT | NOT NULL | |

- STRICT。物理削除してよい（帳簿の記録ではない。削除は `statement_audit_log` に残す）
- 検査は domain で行う: `fixed_account_name` が NULL ⇔ 対応が `accountName` の役割を持つ（INV-50）

### 1.2 `statement_batches`（変更）

- `origin` の CHECK を `IN ('paste', 'file')` にする（`mfme_fetch` を消す。research R13）
- `source_name TEXT NULL` を足す: 使った取込元の名前の写し（取込元を後で消しても残る）。NULL は取込元を保存しなかった取込
- 0008 の更新・削除を止めるトリガーは、表の作り直しの後に作り直す

### 1.3 そのほか

- `statements`・`statement_accounts` は変えない。`statements.external_id` は、対応で `externalId` の役割を選んだ取込元の値を入れる（006 の FR-005 の「変更あり」がそのまま効く）
- `statement_audit_log`: `target_type` の CHECK（`STATEMENT_AUDIT_TARGETS`、`packages/db/src/schema/tenant.ts`）に `statement_source` を、`action` の CHECK（`STATEMENT_AUDIT_ACTIONS`）に `delete` を足す（取込元の create / update / delete）。CHECK を変えるので、この表も作り直す

## 2. マイグレーション

1. `0009_statement_sources.sql`（`drizzle-kit generate`）: `statement_sources` の作成と、`statement_batches`・`statement_audit_log` の作り直し（`__new_` の表への写し）。生成後に新しい表の `);` を `) STRICT;` に置き換える。CHECK だけの変更で drizzle-kit が作り直しを出さなければ、`--custom` で作り直しの SQL を手で書く（`PRAGMA foreign_keys=OFF` → 新しい表 → 写し → 古い表の削除 → 名前の変更 → `PRAGMA foreign_keys=ON`）
2. `0010_statement_sources_integrity.sql`（`--custom`）: 作り直しで消える 0008 のトリガー（`statement_batches` の更新・削除の拒否、`statement_audit_log` の追記のみ）を、0008 と同じ本文で作り直す
- 生成した SQL で、`statements.batch_id` の外部キーが写しの後も効くこと（`PRAGMA foreign_key_check`）を db のテストで確かめる

## 3. 型（`packages/schema/src/statements.ts`）

```text
StatementColumnRole = "date" | "content" | "amount" | "outflow" | "inflow" | "accountName"
                    | "categoryMajor" | "categoryMinor" | "memo" | "externalId" | "transferFlag"
StatementDelimiter  = "\t" | "," | ";"
StatementAmountSign = "inflow_positive" | "outflow_positive"

StatementColumnMapping = {
  delimiter: StatementDelimiter
  headerRow: number | null          // 元のテキストの行の番号（0 起点）。null は見出しなし。保存した対応を当てはめるときは
                                    // この値を使わず、今回の判定で署名が一致した行を使う（前置きの行数は月ごとに変わりうる。R8）
  columns: Partial<Record<StatementColumnRole, number>>   // 列の番号（0 起点）
  amountSign?: StatementAmountSign  // columns.amount があるときは必須
}
```

検証（Zod の refine）:
- `date`・`content` が必須。`amount` か、`outflow` と `inflow` の両方の、どちらか一方だけ
- `amount` があれば `amountSign` が必須
- 同じ列の番号を 2 つの役割に使わない
- 列の番号は 0〜49（research R12）

`StatementEncoding = "utf-8" | "shift_jis"`（取込の `options.encoding` で指定すれば自動の判定を使わない。FR-002）

`StatementTableLayout`（layout の応答）:
```text
{ encoding: StatementEncoding, delimiter, headerRow: number | null, header: string[] | null,
  columnCount, rowCount, sampleRows: string[][] (≤10), needsYear: boolean,
  suggestedColumns: Partial<Record<Role, number>>,     // 辞書の案（R4）
  match: { kind: "none" } | { kind: "one", source: StatementSource } | { kind: "many", sources: StatementSource[] },
  headerDiff?: { added: string[], removed: string[] } }  // sourceId を指定して見出しが違うとき
```

`StatementSource = { id, name, fixedAccountName: string | null, mapping: StatementColumnMapping, header: string[] | null, lastUsedAt, createdAt, updatedAt }`

`StatementRow`（006 の `PastedRow` の名前を変えたもの。項目は同じ）: `accountName, date, content, amount（符号つき、入金が正）, categoryMajor?, categoryMinor?, memo?, transferFlag, externalId?`

`StatementAccountSuggestion = { kind: StatementAccountKind, accountId: Id, subAccountId: Id | null, usage: StatementAccountUsage | null, cues: string[] }`

## 4. domain の関数とポート

| 名前 | 場所 | 役割 |
|---|---|---|
| `parseDelimited(text, delimiter)`・`parseDelimitedLines` | `import/csv.ts` | 区切りつきの分割（`parseCsv` を一般化。R3） |
| `COLUMN_ROLE_NAMES`・`suggestColumns(header)` | `statements/columns.ts` | 見出しの辞書と案（R4） |
| `detectTableLayout(text, override?)` | `statements/table.ts` | 区切り文字・見出しの行・見本（R2） |
| `readStatementTable(text, mapping, { year, fixedAccountName? })` → `Result<StatementTable>` | `statements/table.ts` | 値の読み取り（R5・R6）。`StatementTable = { rows: StatementRow[], unreadable }` |
| `parseStatementAmount`・`parseStatementDate` | `statements/table.ts` | 金額・日付の書き方（R5・R6） |
| `headerSignature(header)`・`matchStatementSources(layout, sources)`・`diffHeader` | `statements/sources.ts` | 当てはめ（R8） |
| `inferStatementAccount(name, categoryMajors, accounts, subAccounts)` | `statements/account-inference.ts` | 口座の推定（R9） |
| `buildColumnPrompt(layout)`・`parseColumnSuggestion(raw, columnCount)` | `statements/column-prompt.ts` | AI の案（R10） |
| `evaluateColumnSuggestions(cases, provider)` | `usecases/statement-columns.ts` | 列の案の評価（R15） |
| `ColumnSuggestionProvider` | `ports.ts` | 端末内の AI の口（R10） |
| `StatementStore` に `listStatementSources`・`upsertStatementSource`・`deleteStatementSource` を足す | `ports.ts`、`packages/db/src/statement-repository.ts` | |
| ユースケース `detectStatementLayout`・`previewStatementImport`・`commitStatementImport`（入力を変更）・`listStatementSources`・`renameStatementSource`・`deleteStatementSource` | `usecases/statements.ts`、`usecases/statement-sources.ts` | |
| ユースケース `suggestStatementColumns` | `usecases/statement-columns.ts` | |

## 5. 不変条件（INV-48〜50。正本はここ。索引は `specs/INVARIANTS.md`）

- **INV-48**: 列の対応の案のための AI への入力（`buildColumnPrompt`）は、見出しのセルと先頭の明細の行 5 件以下だけを含み、見出しより前の行と 6 行目以降の行の値を含まない。列の対応の案は端末内の provider だけに送られる
- **INV-49**: 明細の行から生成したどの形の表（区切り文字・引用・前置き・見出しの有無・列の並び・金額 1 列（符号の向き 2 通り）か 2 列・金額と日付の書き方）でも、正しい対応で `readStatementTable` が返す行は元の行と同じ（件数・順・各行の日付・内容・金額・口座）。読めない行として捨てた行が、明細として加わることはない
- **INV-50**: 取込元の `fixed_account_name` が NULL ⇔ その対応が `accountName` の役割を持つ。1 つの口座の取込元で読んだ行の口座は、すべて `fixed_account_name`
- INV-47 を広げる: 取込の確定（明細・取込の回・未対応の口座の対応・取込元の保存）は全部か無か
