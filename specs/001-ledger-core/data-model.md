# Data Model: 001-ledger-core

仕様: [spec.md](./spec.md) ／ 技術判断: [research.md](./research.md)

## 0. 物理構成

| ファイル | 内容 |
|---|---|
| `data/registry.sqlite` | 事業体の一覧（ID、名称、DBファイル名、作成日時）。仕訳などの帳簿データは持たない |
| `data/tenants/<entityId>.sqlite` | 事業体ごとの帳簿。以下 §2 以降のテーブルはすべてこのファイルに置く |

- テナントの分離は **DBファイルの分離** で担保する（FR-002, SC-007）。帳簿テーブルに `entity_id` 列は持たない。
- 1リクエストは1つのテナントDBだけを開く。テナントを横断する SQL は書けない構造にする。
- すべてのテナントDBに同じマイグレーションを適用する（[research.md](./research.md) R2）。

## 1. 共通の規約

- 主キー: UUIDv7（文字列, 時系列順にソート可能）。`id TEXT PRIMARY KEY`
- 金額: `INTEGER`（円）。アプリ側は `number` 型で、`Number.isSafeInteger` と上限 1兆円未満を Zod で検証する
- 日付: `TEXT`（`YYYY-MM-DD`）。日時: `TEXT`（ISO 8601, UTC）
- 真偽値: `INTEGER`（0/1）
- `STRICT` テーブル、`PRAGMA foreign_keys = ON`

## 2. マスタ

### entity_profile（1行のみ）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK。registry と同じID |
| name | TEXT | NOT NULL |
| kind | TEXT | `individual` \| `corporation` |
| fiscal_start_month | INTEGER | 1〜12。個人は 1 |
| created_at | TEXT | NOT NULL |

### fiscal_periods（会計期間）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK |
| fiscal_year | INTEGER | UNIQUE。開始日の年 |
| start_date / end_date | TEXT | start < end、期間は互いに重ならない |
| status | TEXT | `open` \| `closed` |
| closed_at | TEXT | NULL 可 |

**状態遷移**: `open` → `closed`（締め, FR-024）→ `open`（理由つきの解除）。遷移は audit_log に記録する（FR-025）。

### accounts（勘定科目）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK |
| code | TEXT | UNIQUE。初期セットは固定コード、利用者の追加分は自動採番 |
| name | TEXT | NOT NULL, UNIQUE |
| category | TEXT | `asset` \| `liability` \| `equity` \| `revenue` \| `expense` |
| normal_side | TEXT | `debit` \| `credit`。category から決まる（事業主貸は資産側に表示するが性質は equity の控除） |
| report_section | TEXT | 決算書の区分（`PL_SALES`, `PL_COGS`, `PL_EXPENSE`, `PL_OTHER`, `BS_ASSET`, `BS_LIABILITY`, `BS_EQUITY`） |
| report_line | INTEGER | 決算書の欄番号（例: 売上=1、地代家賃=24、任意科目=25〜30）。NULL 可 |
| sort_order | INTEGER | 決算書の科目順 |
| is_system | INTEGER | 初期セットの科目（コード変更不可） |
| is_active | INTEGER | 使用停止なら 0（FR-005） |

**規則**: 仕訳行から参照されている科目は削除不可（FK + アプリ側のチェック）。名称の変更は audit_log に記録する。

**初期セット**（個人事業用, FR-004）: 青色申告決算書（一般用）の科目と、過去3年に使われた科目を含める。
- 資産: 現金、普通預金、売掛金、前払金、仮払金、工具器具備品、一括償却資産、繰延資産（開業費）、事業主貸
- 負債: 未払金、未払費用、預り金、前受金、借入金
- 純資産: 元入金、事業主借
- 収益: 売上高、雑収入
- 費用（決算書 8〜31 欄）: 租税公課、荷造運賃、水道光熱費、旅費交通費、通信費、広告宣伝費、接待交際費、損害保険料、修繕費、消耗品費、減価償却費、福利厚生費、給料賃金、外注工賃、利子割引料、地代家賃、貸倒金、＋任意科目（会議費、諸会費、支払手数料、新聞図書費、研修費）、雑費

正確な一覧と欄番号は `packages/domain/src/seed/accounts.individual.ts` に置き、テストで決算書の欄との対応を検証する。

### sub_accounts（補助科目）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK |
| account_id | TEXT | FK → accounts |
| name | TEXT | (account_id, name) UNIQUE |
| is_active | INTEGER | |

### partners（取引先）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK |
| name | TEXT | NOT NULL, UNIQUE |
| honorific | TEXT | `様` \| `御中` \| NULL |
| memo | TEXT | |
| is_active | INTEGER | |

### tags（メモタグ）
`id`, `name`（UNIQUE）

### tax_categories（税区分, 固定の参照データ）
| code | 名称 | 区分 | 税率 |
|---|---|---|---|
| `OUT_OF_SCOPE` | 対象外 | — | — |
| `SALES_10` | 課税売上10% | sales | 10 |
| `SALES_8R` | 課税売上8%（軽） | sales | 8 |
| `PURCHASE_10` | 課対仕入10% | purchase | 10 |
| `PURCHASE_8R` | 課対仕入8%（軽） | purchase | 8 |
| `EXEMPT` | 非課税 | — | — |
| `NON_TAXABLE` | 不課税 | — | — |

コードとして持ち、マイグレーションで投入する（FR-010）。freee の税区分名との対応表は 002 で扱う。

### consumption_tax_settings（消費税の設定）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK |
| effective_from | TEXT | UNIQUE。適用開始日 |
| taxpayer_status | TEXT | `exempt` \| `general` \| `simplified` \| `two_tenths` |
| accounting_method | TEXT | `tax_included` \| `tax_excluded` |

**規則**（FR-009）: 適用期間は `effective_from` 順に連続し、次の行の前日までが適用範囲。最初の行の `effective_from` は最初の会計期間の開始日以前。空白・重複は保存時に拒否する。`exempt` のとき `accounting_method` は `tax_included` に固定する。

## 3. 残高・仕訳

### opening_balances（期首残高）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK |
| fiscal_period_id | TEXT | FK |
| account_id | TEXT | FK |
| sub_account_id | TEXT | FK, NULL 可 |
| side | TEXT | `debit` \| `credit` |
| amount | INTEGER | > 0 |

**規則**（FR-011）: 会計期間ごとに、借方合計 = 貸方合計 でなければ保存しない（一括置換で保存する）。(fiscal_period_id, account_id, sub_account_id) UNIQUE。

### journals（仕訳）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK |
| journal_no | INTEGER | UNIQUE。事業体内の通し番号（FR-016） |
| date | TEXT | いずれかの会計期間に含まれる |
| fiscal_period_id | TEXT | FK。date から決まる |
| memo | TEXT | |
| status | TEXT | `active` \| `voided` |
| corrects_journal_id | TEXT | FK → journals, NULL 可。締め済み年度の仕訳に対する訂正仕訳（FR-019a） |
| source | TEXT | `manual`（002 以降で `import_freee` などを追加） |
| version | INTEGER | 訂正のたびに +1（楽観ロック） |
| created_at / updated_at | TEXT | |

**状態遷移**: `active` →（理由つき取消）→ `voided`。`voided` から戻す操作はない。
**削除トリガー**: `BEFORE DELETE ON journals` で `RAISE(ABORT)`（FR-022）。

### journal_lines（仕訳行）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK |
| journal_id | TEXT | FK |
| line_no | INTEGER | (journal_id, line_no) UNIQUE |
| side | TEXT | `debit` \| `credit` |
| account_id | TEXT | FK |
| sub_account_id | TEXT | FK, NULL 可。科目に属するもの |
| amount | INTEGER | CHECK (amount > 0 AND amount < 1000000000000) |
| tax_category | TEXT | tax_categories.code |
| tax_amount | INTEGER | 内税額。>= 0 |
| partner_id | TEXT | FK, NULL 可 |
| description | TEXT | 摘要 |

訂正時は、その仕訳の行を全件置き換える（変更前は audit_log に保存済み）。

### journal_line_tags
`journal_line_id`, `tag_id`（複合PK）

## 4. 不変条件（Constitution I, V — プロパティベーステストの対象）

| ID | 不変条件 | 担保する場所 |
|---|---|---|
| INV-1 | 有効な仕訳ごとに Σ借方 = Σ貸方 | ドメインの `createJournal`/`correctJournal`（DB 書込前）。統合テストで全仕訳を検査するビュー `v_unbalanced_journals` が空 |
| INV-2 | 各仕訳は借方行・貸方行を1行以上ずつ持つ | ドメイン |
| INV-3 | 金額は 0 < amount < 10^12 の整数 | Zod + DB の CHECK |
| INV-4 | 試算表の借方合計 = 貸方合計 | 帳票の導出関数（INV-1 と期首残高の一致から従う） |
| INV-5 | 資産 = 負債 + 純資産 + 当期利益 | 帳票の導出関数 |
| INV-6 | 取消済みの仕訳は集計に影響しない | 帳票の導出関数 |
| INV-7 | 締め済み年度の仕訳は変更されない | ドメイン（会計期間の状態を確認）＋ audit_log |
| INV-8 | 仕訳番号は単調増加で重複しない | DB の UNIQUE と採番トランザクション |
| INV-9 | audit_log は追記のみ | DB トリガー（UPDATE/DELETE を ABORT） |
| INV-10 | 内税額 = floor(税込額 × 税率 / (100 + 税率)) | ドメインの純関数 |

## 5. 監査（Constitution II）

### audit_log（変更履歴）
| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PK（UUIDv7） |
| occurred_at | TEXT | NOT NULL |
| target_type | TEXT | `journal` \| `account` \| `fiscal_period` \| `opening_balance` \| `tax_setting` |
| target_id | TEXT | |
| action | TEXT | `create` \| `correct` \| `void` \| `rename` \| `deactivate` \| `close` \| `reopen` \| `replace` |
| reason | TEXT | correct / void / reopen では NOT NULL（アプリで検証） |
| before_json | TEXT | 変更前のスナップショット（仕訳は行・タグを含む） |
| after_json | TEXT | 変更後のスナップショット |

- トリガー `audit_log_no_update` / `audit_log_no_delete` で変更・削除を禁止する（INV-9）
- 仕訳の変更と audit_log の追記は **同一トランザクション** で行う
- 利用者は1人のため「誰が」は記録しない（spec の Assumptions）

## 6. 帳票（保存しない, FR-031）

帳票は仕訳と期首残高から都度導出する。導出はドメイン層の純関数で行い、DB からは「期間内の有効な仕訳行」と「期首残高」だけを取得する。

| 帳票 | 入力 | 出力 |
|---|---|---|
| 仕訳帳 | 期間 | 仕訳番号・日付順の仕訳と行 |
| 総勘定元帳 | 期間、科目、補助科目（任意） | 前期繰越、各行（日付・相手科目・摘要・借方・貸方・残高） |
| 試算表 | 期間 | 科目ごとの期首・借方・貸方・期末、合計行 |
| 損益計算書 | 期間（＋比較期間） | 決算書の科目順、売上・経費・差引、前年比 |
| 貸借対照表 | 基準日（＋比較日） | 資産・負債・純資産、当期利益を含めた貸借一致 |

前期繰越 = 期首残高 + 会計期間の開始日から期間の開始日の前日までの仕訳の累計。収益・費用の科目は会計期間ごとに 0 から始める。
