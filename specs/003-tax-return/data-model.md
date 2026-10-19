# Data Model: 決算処理と確定申告の支援

**Feature**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **Date**: 2026-10-19

001・002 の表（`accounts`、`journals`、`journal_lines`、`opening_balances`、`fiscal_periods`、`partners`、`consumption_tax_settings`、`tax_rates`、`audit_log`、`import_*`）は変えない。事業体の DB に次の表を追加する（マイグレーション `0003_tax_return`。生成後に `);` を `) STRICT;` に置き換え、トリガーは `--custom` で足す）。

金額はすべて整数（円）。割合は万分率の整数（0〜10000）。年度は `fiscal_year`（整数、例 2025）。

## 1. 表

### 1.1 `tax_parameters`（税制の値。R3）

| 列 | 型 | 制約 |
|---|---|---|
| `key` | text | `SMALL_ASSET_THRESHOLD` / `SMALL_ASSET_ANNUAL_LIMIT` / `BLUE_DEDUCTION_MAX` / `BLUE_DEDUCTION_STANDARD` / `BLUE_DEDUCTION_BASIC`（CHECK） |
| `effective_from` | text | `YYYY-MM-DD` |
| `effective_to` | text | NULL 可（期限なし） |
| `value` | integer | > 0 |
| `source_url` | text | NOT NULL |

- PK (`key`, `effective_from`)。値は research R3 の表をマイグレーションで投入する。ドメインの `seed/tax-parameters.ts` に同じ値を置く（テストと、マイグレーションとの一致を db のテストで確かめる）

### 1.2 `home_use_allocations`（家事按分の登録。FR-012〜013）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `fiscal_year` | integer | `fiscal_periods` に存在 |
| `account_id` | text | FK `accounts`。区分が費用であることはドメインで検査（`HOME_USE_ACCOUNT_INVALID`、R7） |
| `sub_account_id` | text | NULL 可、FK |
| `business_ratio` | integer | 0〜10000 |
| `basis` | text | 空でない（根拠のメモ） |
| `change_reason` | text | NULL 可。前の年度の同じ科目と割合が違うときは必須（ドメインで検査） |
| `created_at` / `updated_at` | text | |

- UNIQUE (`fiscal_year`, `account_id`, `sub_account_id`)（`sub_account_id` が NULL の重複は部分インデックスで防ぐ）
- 物理削除はしない。使わなくなった登録は `business_ratio = 10000`（按分なし）にする。変更は `closing_audit_log` に残す

### 1.3 `rent_details`（地代家賃の内訳。FR-017）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `fiscal_year` | integer | |
| `payee` | text | 支払先の住所・氏名。空でない |
| `property` | text | 賃借物件。空でない |
| `annual_rent` | integer | ≥ 0（本年中の賃借料・権利金等） |
| `deductible_amount` | integer | 0 ≤ x ≤ `annual_rent`（必要経費算入額） |
| `sort_order` | integer | |

- 削除可（帳簿ではなく決算書の記載事項のため）。変更は `closing_audit_log` に残す

### 1.4 `fixed_assets`（固定資産台帳。FR-018〜022）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `name` | text | 空でない |
| `quantity` | text | NULL 可（面積又は数量） |
| `acquired_on` | text | `YYYY-MM-DD` |
| `acquisition_cost` | integer | > 0 |
| `method` | text | `small_asset_28_2`（CHECK。後で値を足す） |
| `useful_life_years` | integer | NULL 可（少額の特例では空） |
| `business_ratio` | integer | 0〜10000 |
| `asset_account_id` | text | FK `accounts`。区分が資産であることはドメインで検査（`ASSET_ACCOUNT_INVALID`）。既定 1060 工具器具備品 |
| `linked_journal_id` | text | NULL 可、FK `journals`（取得がすでに仕訳されている場合。FR-022） |
| `note` | text | 摘要 |
| `disposed_on` | text | NULL 可（除却の日） |
| `created_at` / `updated_at` | text | |

- 物理削除はしない（除却は `disposed_on`）。変更は `closing_audit_log` に残す

### 1.5 `adjustment_journal_refs`（決算整理の仕訳の出所。R4）

| 列 | 型 | 制約 |
|---|---|---|
| `journal_id` | text | PK、FK `journals` |
| `kind` | text | `home_use` / `depreciation`（CHECK） |
| `allocation_id` | text | `kind = home_use` のとき NOT NULL、FK `home_use_allocations` |
| `asset_id` | text | `kind = depreciation` のとき NOT NULL、FK `fixed_assets` |
| `fiscal_year` | integer | |

- 仕訳そのものは 001 の `journals`（`source = manual`）。取消は 001 の仕訳の取消で行い、この表の行は残す（取消済みの仕訳は集計で除く）
- 物理削除をトリガーで禁止

### 1.6 `blue_deduction_answers`（控除の要件の回答。FR-010）

| 列 | 型 | 制約 |
|---|---|---|
| `fiscal_year` | integer | PK |
| `double_entry` | integer | 0/1（正規の簿記） |
| `statements_attached` | integer | 0/1（BS・PL の添付） |
| `filed_on_time` | integer | 0/1（期限内の申告） |
| `e_tax` | integer | 0/1（e-Tax での送信） |
| `electronic_books` | integer | 0/1（優良な電子帳簿の保存と届出） |
| `updated_at` | text | |

### 1.7 `closing_notes`（決算のメモ。FR-027、FR-030）

| 列 | 型 | 制約 |
|---|---|---|
| `fiscal_year` | integer | PK の一部 |
| `kind` | text | `special_circumstances`（特殊事情） / `opening_difference`（期首と前期末の差の説明）。PK の一部 |
| `body` | text | |
| `updated_at` | text | |

### 1.8 `tax_return_memos`（事業所得以外の控え。FR-033〜034）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `fiscal_year` | integer | |
| `kind` | text | `salary` / `social_insurance` / `small_business_mutual_aid` / `life_insurance` / `earthquake_insurance` / `donation` / `medical` / `stocks` / `crypto` / `foreign_tax_credit` / `other`（CHECK） |
| `label` | text | NULL 可（`other` のとき必須） |
| `amount` | integer | NULL 可、≥ 0 |
| `file_path` | text | NULL 可。`/` で始まる絶対パス（Zod で検査、R13） |
| `memo` | text | |

- 削除可（計算に使わない控え）

### 1.9 `filed_documents`（提出書類の記録。FR-035）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `fiscal_year` | integer | |
| `kind` | text | `blue_return` / `tax_return` / `attachment` / `other`（CHECK） |
| `file_path` | text | `/` で始まる絶対パス（Zod で検査、R13） |
| `filed_on` | text | NULL 可 |
| `memo` | text | |

- 削除可

### 1.10 `closing_audit_log`（決算の設定の変更履歴。R12）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `occurred_at` | text | |
| `target_type` | text | `home_use_allocation` / `rent_detail` / `fixed_asset` / `blue_deduction_answer` / `closing_note` / `account_report_line`（CHECK。`account_report_line` は科目の欄番号の変更、R12a） |
| `target_id` | text | |
| `action` | text | `create` / `update` / `dispose` / `delete`（CHECK） |
| `reason` | text | NULL 可 |
| `before_json` / `after_json` | text | NULL 可 |

- 更新・削除をトリガーで禁止（`audit_log` と同じ）

## 2. ドメインの型（保存しない）

- **`BlueReturnForm`**（R2）: 年分、`pl: FormLine[]`（欄番号、欄名、`kind: account | optional | computed | unused`）、`optionalLines: [25..30]`、`salesPartnerRows: number`、`bsRows: { label, side, accountCodes[] }[]`
- **`BlueReturn`**: `fiscalYear`、`formYear`（使った様式の年分、R2）、`status: open | closed`、`page1: { lines: { no, label, amount | null }[] }`、`page2: { monthly, rentDetails, deduction }`、`page3: { salesPartners, depreciation }`、`page4: { opening, closing }`、`transfer: { businessIncome /* 欄45 */, blueDeduction /* 欄44 */ }`、`warnings: BlueReturnWarning[]`
- **`BlueReturnWarning`** のコード: `OPTIONAL_LINES_OVERFLOW`、`PL_MISMATCH`、`HOME_USE_ADJUSTMENT_STALE`、`RENT_DETAILS_MISMATCH`、`DEPRECIATION_MISMATCH`、`SALES_TOTAL_MISMATCH`、`SALES_WITHOUT_PARTNER`、`DUPLICATE_PARTNER_NAME`、`OPENING_MISMATCH`、`DEFERRED_ASSET_NOT_AMORTIZED`、`OPENING_OWNER_ACCOUNTS`（期首に事業主貸・借の残高がある、R8）、`NEGATIVE_BALANCE`（001）、`DEDUCTION_ANSWERS_MISSING`、`PRIOR_PERIOD_OPEN`
- **`AdjustmentProposal`**: `kind`、元の ID、`journal: JournalDraft`（年度末日付）、`breakdown`（帳簿の金額、割合、事業分、家事分 または 取得価額、算入額）

## 3. 状態の移り変わり

- 按分の登録: 登録 → 振替の案 → 振替の仕訳を登録（`adjustment_journal_refs`）→ 帳簿・割合の変更で `HOME_USE_ADJUSTMENT_STALE` → 差額の振替を追加、または振替を取り消して再登録
- 資産: 登録（`linked_journal_id` あり → 案なし ／ なし → 償却の案）→ 償却の仕訳を登録 → 除却（`disposed_on`）
- 年度の締め（001）: 締め済みの年度では、案の登録（仕訳の作成）を 001 の `checkPeriod` が拒否する。按分・資産・メモの登録そのものは締め済みでもできる

## 4. 不変条件（001 の INV-1〜10、002 の INV-11〜17 に追加）

- **INV-18**: 決算書の経費計（欄32）と差引金額（欄33）は、同じ年度の 001 の損益計算書の費用合計と利益に等しい。欄43 = 欄33 + 欄34〜42 の加減（この機能では 0）、欄45 = 欄43 − 欄44
- **INV-19**: 決算書4ページの期首・期末とも、資産合計 = 負債・資本合計（期末は控除前の所得を含む）。期首は表示した金額（事業主貸・借が 0 なら空欄）で合計する（R8）
- **INV-20**: 按分で、0 ≤ 事業分 ≤ 帳簿の金額、事業分 + 家事分 = 帳簿の金額（帳簿の金額 > 0 のとき）。割合 10000 なら家事分 0、0 なら事業分 0
- **INV-21**: 少額減価償却資産の特例の資産は、取得価額 < 取得の日の基準額、かつ同じ年の特例の資産の取得価額の合計 ≤ 年間の上限。必要経費算入額 ≤ 取得価額
- **INV-22**: 青色申告特別控除額 = min(上限額, max(0, 欄43))。0 ≤ 控除額 ≤ 上限額
- **INV-23**: 決算整理の仕訳の案は、借方合計 = 貸方合計、行の金額 > 0、日付は年度末日（001 の `validateJournal` を通る）
- **INV-24**: 月別売上の合計 = 欄1 = 売上先の明細の合計（個別の行 + 上記以外の計）
