# Data Model: 002-freee-import

001 の [data-model.md](../001-ledger-core/data-model.md) に追加・変更するものだけを書く。テーブルはすべて事業体ごとの DB（`data/tenants/<entityId>.sqlite`）に置き、STRICT とする。マイグレーションは `0002_import`（drizzle-kit で生成し、`) STRICT;` に置き換える）。

## 1. 変更するもの

### journals.source
`manual` | `import_freee`。SQL の CHECK はないため、Drizzle の列挙を変えるだけ（research R12）。
取り込んだ仕訳は、001 の仕訳と同じテーブル・同じ規則で扱い、表示・検索・訂正・取消・帳票の集計で区別しない（FR-017）。訂正・取消は 001 の API をそのまま使う。

### audit_log
スキーマは変えない。取り込んだ仕訳は `target_type = journal`、`action = create`。`after_json` に `source`、`importBatchId`、`freeeJournalId` を含める。取込の取消は仕訳ごとに `action = void` と理由（research R12）。

## 2. 追加するテーブル

### import_batches（取込の回）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK（UUIDv7） |
| source | TEXT | `freee_journal`（仕訳帳。元帳は保存しない） |
| file_name | TEXT | NOT NULL |
| file_sha256 | TEXT | NOT NULL。小文字16進64文字 |
| imported_at | TEXT | NOT NULL |
| period_from / period_to | TEXT | 取り込んだ仕訳の最小日・最大日 |
| fiscal_years_json | TEXT | 取り込んだ年度の配列（例 `[2025]`） |
| count_new | INTEGER | 登録した仕訳の数（>= 1） |
| count_already | INTEGER | 取込済みとして除いた数 |
| count_excluded | INTEGER | 取込対象外の数 |
| count_rejected | INTEGER | 取込不可の数 |
| count_warnings | INTEGER | 警告の数 |
| status | TEXT | `active` \| `voided` |
| voided_at | TEXT | NULL 可 |
| void_reason | TEXT | `voided` のとき NOT NULL（CHECK） |

**状態遷移**: `active` →（理由つきの取消, FR-024）→ `voided`。戻す操作はない。物理削除はトリガーで禁止する。
新しい仕訳が0件のときは取込の回を作らない（確定のボタンを押せない）。

### import_journal_refs（取込元の仕訳の識別）
| 列 | 型 | 制約 |
|---|---|---|
| journal_id | TEXT | PK、FK → journals |
| batch_id | TEXT | FK → import_batches |
| freee_journal_id | TEXT | NOT NULL |
| freee_journal_no | TEXT | 表示用（freee の仕訳番号） |
| freee_date | TEXT | NOT NULL。FR-030 の範囲の判定に使う |
| snapshot_json | TEXT | NOT NULL。取込のときの freee の内容の正準 JSON（research R9） |
| revoked_at | TEXT | NULL 可。取込の取消で設定する |

- 部分一意インデックス `UNIQUE (freee_journal_id) WHERE revoked_at IS NULL`（INV-12）
- 物理削除はトリガーで禁止する。更新は `revoked_at` の設定だけ（アプリで限定）

### import_account_mappings（科目の対応表）
| 列 | 型 | 制約 |
|---|---|---|
| source_name | TEXT | PK。NFKC で正規化した freee の勘定科目名 |
| account_id | TEXT | FK → accounts, NOT NULL |
| sub_account_id | TEXT | FK → sub_accounts, NULL 可。`account_id` に属する |
| sub_account_name | TEXT | NULL 可。補助科目がまだないとき、取込で作る名前 |
| updated_at | TEXT | NOT NULL |

`sub_account_id` と `sub_account_name` の両方が入ることはない（CHECK）。

### import_tax_mappings（税区分の対応表）
| 列 | 型 | 制約 |
|---|---|---|
| source_name | TEXT | PK。NFKC で正規化した freee の税区分名 |
| tax_category | TEXT | tax_categories.code |
| updated_at | TEXT | NOT NULL |

対応表は設定なので変更履歴は残さない（Constitution II の対象は仕訳と証憑）。保存した行は初期案（research R13）より優先する。

## 3. ドメインの型（保存しない）

| 型 | 内容 |
|---|---|
| `FreeeFile` | `{ kind: "journal" \| "ledger", encoding: "utf-8" \| "shift_jis", header: string[], rows: Record<string,string>[] }` |
| `FreeeJournal` | 仕訳ID、仕訳番号、日付、決算整理仕訳、登録した方法、備考、行の配列（`side`, `accountName`, `subAccountName?`, `amount`, `taxName`, `taxAmount`, `partnerName?`, `tagNames[]`, `description`）。名前は NFKC 済み、摘要は元の文字 |
| `FreeeLedgerAccount` | 科目名、開始行の残高（符号つき）、行の配列（日付、決算整理仕訳、相手科目、借方、貸方、残高） |
| `MappingProposal` | ファイルに出てくる名前ごとに、保存済み・初期案・未定のどれか、と対応先 |
| `ImportPlanItem` | 仕訳ごとの判定 `new` \| `already` \| `excluded` \| `rejected`、理由のコード、組み立てた `JournalDraft`（new のとき）、警告 |
| `ImportPreview` | ファイルの種類・ハッシュ・年度ごとの件数、`ImportPlanItem[]`、対応表の案、新しく作る補助科目・取引先・メモタグ、警告、freee 側の変更・削除（FR-029, FR-030） |
| `OpeningProposal` | 帳簿の科目・補助科目ごとの貸借と金額、登録済みとの差（FR-020）、前年度の繰越との差（FR-020a）、警告 |
| `ReconciliationRow` | 帳簿の科目、対応する freee の科目名の一覧、両側の期首・借方合計・貸方合計・期末、一致かどうか、差額、差の原因の候補 |

### 判定のコード
| 種類 | コード | 条件 |
|---|---|---|
| excluded | `PRIOR_YEAR_CLOSING` | 決算整理仕訳 = 1 かつ 日付が会計期間の開始日（research R5） |
| excluded | `YEAR_NOT_SELECTED` | 利用者が選ばなかった年度（FR-004a） |
| excluded | `USER_EXCLUDED` | 利用者が個別に外した |
| rejected | `UNBALANCED` / `INVALID_AMOUNT` / `MISSING_FIELD` / `LINE_COUNT_MISMATCH` | 001 の検証、または freee の行の不整合 |
| rejected | `OUT_OF_PERIOD` / `PERIOD_CLOSED` | 会計期間がない、締め済み |
| rejected | `UNMAPPED` / `ACCOUNT_INACTIVE` | 対応表が未定、対応先の科目が使用停止 |
| already | `ALREADY_IMPORTED` | 取り消されていない参照がある（research R8） |

### 警告のコード
`TAX_AMOUNT_MISMATCH`、`TAX_CATEGORY_SUSPICIOUS`（research R14）、`POSSIBLE_DUPLICATE`（R16）、`FREEE_CHANGED`、`FREEE_DELETED`（R9）、`NEGATIVE_OPENING`（R6）、`OPENING_DIFFERS_FROM_CARRY_FORWARD`（FR-020a）。

## 4. 不変条件（001 の INV-1〜10 に追加）

| ID | 不変条件 | 担保する場所 |
|---|---|---|
| INV-11 | 取込は全部か無か。確定の途中で失敗したら、仕訳・マスタ・取込の記録が取込の前と同じ | `ImportUnitOfWork` の1トランザクション。失敗を注入する統合テスト（SC-006） |
| INV-12 | 取り消されていない参照の中で、freee の仕訳ID は一意（同じファイルを何度取り込んでも仕訳は増えない） | 部分一意インデックス ＋ プレビューの判定。プロパティテスト（SC-005） |
| INV-13 | 取り込んだ仕訳は INV-1〜3・INV-7・INV-10 を満たす | 001 の `validateJournal` を必ず通す |
| INV-14 | freee 形式の仕訳帳・元帳を生成して取り込むと、照合のすべての行が一致する（決算振替の繰り込みを含む） | プロパティテスト（research R17） |
| INV-15 | 取込の取消の後、帳票の金額は取込の前と同じ。取消された仕訳はすべて `voided` で、監査ログに理由がある | 操作列のプロパティテスト（SC-007） |
| INV-16 | 期首残高の案は貸借が一致する（元帳と振替が整合している場合） | プロパティテスト |
| INV-17 | `parse(toCsv(rows)) = rows`（CSV の往復） | プロパティテスト（research R2） |
