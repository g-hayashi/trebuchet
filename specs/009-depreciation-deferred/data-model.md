# Data Model: 定額法・一括償却資産・開業費の償却

**Feature**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **Date**: 2026-11-01

003 の表（[003 data-model §1](../003-tax-return/data-model.md)）を拡張し、事業体の DB に 3 表を足す。マイグレーションは `0011_depreciation`（生成 + 手直し、STRICT、作り直し）と `0012_depreciation_integrity`（`--custom`。投入とトリガー）（research R14）。

金額はすべて整数（円）。割合は万分率の整数（0〜10000）。償却率は千分率の整数（0.250 = 250）。年度は `fiscal_year`（個人は暦年）。

## 1. 表

### 1.1 `straight_line_rates`（定額法の償却率。新規、R2）

| 列 | 型 | 制約 |
|---|---|---|
| `useful_life_years` | integer | 2〜50（CHECK） |
| `effective_from` | text | `YYYY-MM-DD`（取得日で解決する） |
| `effective_to` | text | NULL 可（期限なし） |
| `rate_permille` | integer | 1〜1000（CHECK） |
| `source_url` | text | NOT NULL |

- PK (`useful_life_years`, `effective_from`)。値は research R2 の表（49 行）を `0012` で投入する。正本は `packages/domain/src/seed/depreciation-rates.ts` の `STRAIGHT_LINE_RATES`。一致を db のテストで確かめる
- 更新・削除はしない（行を足すか終了日を足す。AGENTS.md の税制の値と同じ）

### 1.2 `tax_parameters`（003 §1.1 の key を追加、R13）

- `key` の CHECK・Drizzle の enum・型 `TaxParameterKey` に `LUMP_SUM_COST_MIN`、`LUMP_SUM_COST_MAX`、`LUMP_SUM_YEARS`、`OPENING_COST_AMORTIZATION_MONTHS` を足す（表の作り直し）。行は research R13 の 4 行を `0012` で投入し、`seed/tax-parameters.ts` にも足す

### 1.3 `fixed_assets`（003 §1.4 を変更、R1）

足す・変える列だけ:

| 列 | 型 | 制約 |
|---|---|---|
| `method` | text | `small_asset_28_2` / `straight_line` / `lump_sum`（CHECK） |
| `in_service_on` | text | NULL 可（事業の用に供した日。NULL なら `acquired_on`）。`acquired_on` 以後（domain で検査） |
| `prior_accumulated` | integer | NOT NULL、既定 0、≥ 0（CHECK）。定額法は ≤ 取得価額 − 1、一括償却は ≤ 取得価額（domain、`PRIOR_ACCUMULATED_INVALID`） |
| `prior_through_year` | integer | NULL 可。`prior_accumulated > 0` なら NOT NULL（CHECK）。供用の年以上（domain） |
| `useful_life_years` | integer | 定額法は NOT NULL（CHECK `method <> 'straight_line' OR useful_life_years IS NOT NULL`）。値が償却率の表にあることは domain（`USEFUL_LIFE_UNSUPPORTED`）。一括償却は NULL |
| `disposal_kind` | text | NULL 可。`scrap`（廃棄）/ `sale`（売却）（CHECK）。`disposed_on` が NULL ⇔ NULL（CHECK）。除却の入力の既定は `scrap`（research R8、R16 の Q1） |

- 少額の特例は `in_service_on` NULL、`prior_accumulated = 0`、`prior_through_year` NULL に限る（domain）。`linked_journal_id` は少額の特例だけ（他の方法で指定したら `VALIDATION`）
- 物理削除はしない（003 のまま）。変更・除却は `closing_audit_log`（`fixed_asset`）

### 1.4 `deferred_assets`（繰延資産（開業費）。新規、R5）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `name` | text | 空でない（CHECK） |
| `total_amount` | integer | > 0（CHECK。支出の総額） |
| `opened_on` | text | `YYYY-MM-DD`（開業日） |
| `prior_accumulated` | integer | NOT NULL、既定 0、0 ≤ x ≤ `total_amount`（CHECK） |
| `prior_through_year` | integer | NULL 可。`prior_accumulated > 0` なら NOT NULL（CHECK）。開業の年以上（domain） |
| `account_id` | text | FK `accounts`。区分が資産の科目（domain、`ASSET_ACCOUNT_INVALID`）。既定 1080 開業費 |
| `note` | text | NULL 可 |
| `created_at` / `updated_at` | text | |

- 物理削除はしない。変更は `closing_audit_log`（`deferred_asset`）

### 1.5 `deferred_amortizations`（開業費の年度ごとの償却額の決定。新規、R5）

| 列 | 型 | 制約 |
|---|---|---|
| `deferred_asset_id` | text | FK `deferred_assets`。PK の一部 |
| `fiscal_year` | integer | FK `fiscal_periods(fiscal_year)`。PK の一部 |
| `amount` | integer | ≥ 0（CHECK）。上限（期首の未償却残高）以下は domain（`DEFERRED_AMORTIZATION_OVER_LIMIT`） |
| `decided_at` / `updated_at` | text | |

- 更新できるのは、その（開業費, 年度）に有効な償却の仕訳がなく、年度が締め前のときだけ（domain。R5・R12）。削除はトリガーで禁止する。変更は `closing_audit_log`（`deferred_amortization`）

### 1.6 `adjustment_journal_refs`（003 §1.5 を変更、R7）

| 列 | 型 | 制約 |
|---|---|---|
| `kind` | text | `home_use` / `depreciation` / `deferred_amortization`（CHECK） |
| `deferred_asset_id` | text | 新規。NULL 可、FK `deferred_assets`。`kind = deferred_amortization` のとき NOT NULL（出所の CHECK を広げる） |

- 他の列（`journal_id` PK、`allocation_id`、`asset_id`、`fiscal_year`）と削除禁止のトリガーは 003 のまま（作り直したのでトリガーは `0012` で作り直す）
- 同じ（出所, 年度）の参照は複数行あってよい（取り消した仕訳の行が残る）。有効な仕訳は高々 1 件（INV-60。確定のトランザクションで守る）

### 1.7 `closing_audit_log`（003 §1.10 を変更）

- `target_type` に `deferred_asset`、`deferred_amortization` を足す（CHECK、作り直し。トリガーは `0012` で作り直す）。`deferred_amortization` の `target_id` は `開業費ID:年度`

### 1.8 勘定科目の初期セット（R9）

- `5300` 固定資産除却損（`expense`、`PL_EXPENSE`、`reportLine` 30）を `5290` と `5310` の間に足す。初期セットは事業体の作成時に入るので、マイグレーションでは足さない

## 2. ドメインの型と計算（保存しない）

### 2.1 型

- **`FixedAsset`**（003 を拡張）: `inServiceOn: string | null`、`priorAccumulated: number`、`priorThroughYear: number | null`、`disposalKind: "scrap" | "sale" | null`（`disposedOn` が null ⇔ null）
- **`StraightLineRate`**: `{ usefulLifeYears, ratePermille, effectiveFrom, effectiveTo, sourceUrl }`
- **`DeferredAsset`**: `{ id, name, totalAmount, openedOn, priorAccumulated, priorThroughYear, accountId, note, createdAt, updatedAt }`
- **`DeferredAmortization`**: `{ deferredAssetId, fiscalYear, amount, decidedAt, updatedAt }`
- **`AdjustmentRef`**（003 を拡張）: `deferredAssetId: string | null`。`AdjustmentKind` に `deferred_amortization`
- **`Depreciation`**（003 の `depreciate` の結果を拡張。年度の償却。導出）: `{ method, cost, base, ratePermille | null, months | null, openingBookValue, ordinary, total, businessRatio, deductible, closingBookValue, disposalKind | null, disposalAmount, disposalDeductible }`。`disposalAmount` は除却の年度の定額法だけ正（その年度の償却の後の未償却残高。廃棄なら除却損、売却なら事業主貸への振替額）、他は 0。`disposalDeductible` は廃棄の除却損の事業分（売却・他は 0）
- **`DeferredAmortizationView`**（年度の開業費。導出）: `{ fiscalYear, openingBalance /* 上限 */, target /* 目安 */, decision: DeferredAmortization | null, registered: boolean, closingBalance }`
- **`DepreciationRow`**（3 ページの行。schema）: 003 の列に `source: "fixed_asset" | "deferred_asset"`、`ratePermille: number | null`、`months: number | null`、`disposedOn: string | null` を足す。`method` は `DepreciationRowMethod` = `small_asset_28_2` / `straight_line` / `lump_sum` / `deferred`。`assetId` は資産または開業費の ID
- **`AdjustmentProposal.breakdown`**（schema の union を拡張）: 償却は `{ method, acquisitionCost, businessRatio, depreciation, deductible, months | null, ratePermille | null, openingBookValue, closingBookValue, disposalKind | null, disposalAmount, disposalDeductible }`（少額の特例も同じ形で埋める）。開業費は `{ totalAmount, openingBalance, amount, target, closingBalance }`
- **`BlueReturnWarning` のコード**を足す（schema の `BlueReturnWarningCode`）:
  - `ASSET_REGISTER_MISMATCH`: 勘定ごとに 1 件。`{ accountId, accountName, bookOpening, registerOpening, difference /* bookOpening − registerOpening */ }`（R10）
  - `DEPRECIATION_PARAMETER_MISSING`: 資産・開業費ごとに 1 件。`{ source, sourceId, key /* "STRAIGHT_LINE_RATE" か税制の値の key */, date }`（R13）

### 2.2 計算の規則（research の節が正本。式だけを集める）

`startYear` = `prior_through_year + 1`（あれば）、なければ供用の年（定額法・一括償却）／開業の年（開業費）。`startYear` より前の年度は計算しない（3 ページに載せない、案を作らない、R10 の照合をしない）。

- **月数**（定額法、R3）: 年度 Y の最初の月 = 供用の年なら供用の月、他は 1 月。最後の月 = 除却の年なら除却の月、他は 12 月。月数 = 最後 − 最初 + 1（1〜12）
- **定額法**（R3）: `opening(Y) = cost − prior − Σ_{y=startYear}^{Y−1} dep(y)`、`dep(Y) = min(⌈cost × rate × months / 12000⌉, opening(Y) − 1)`（`opening(Y) ≤ 1` なら 0）。除却の年度は `disposalAmount = opening(Y) − dep(Y)`（廃棄・売却とも）、除却の翌年度以後は計算しない
- **一括償却**（R4）: n = `LUMP_SUM_YEARS`、k = Y − 供用の年 + 1。`unit = ⌊cost / n⌋`。`dep(Y) = k < n ? min(unit, opening(Y)) : (k = n ? opening(Y) : 0)`。除却に関わらない
- **少額の特例**: 003 のまま（取得の年に取得価額、残高 0）
- **必要経費算入額**: `deductible = ⌊dep × ratio / 10000⌋`、家事分 = `dep − deductible`（除却損も同じ規則）
- **開業費**（R5）: `opening(Y) = total − prior − Σ_{y<Y} effective(y)`。`effective(y)` = 決定の額（その年度に有効な償却の仕訳があるとき）、なければ 0。月数 = [開業の月, 開業の月 + 59] と年度 Y の重なりの月数。`target(Y) = min(opening(Y), ⌈total × months / M⌉)`（M = `OPENING_COST_AMORTIZATION_MONTHS`）。決定の上限は `opening(Y)`
- **台帳の期首**（R10）: 年度 Y の期首より前に取得した資産について、定額法は除却の年度が Y より前なら 0、そうでなければ `opening(Y)`。一括償却は `opening(Y)`。少額の特例は 0。開業費は開業日が Y の期首より前なら `opening(Y)`

### 2.3 仕訳の案（日付は年度末日、行の税区分は `OUT_OF_SCOPE`、INV-23）

| 案 | 行 |
|---|---|
| 定額法・一括償却（`depreciation`） | 借方 減価償却費 / 貸方 資産の勘定（`dep`）。家事分 > 0 なら 借方 事業主貸 / 貸方 減価償却費（家事分） |
| 定額法の廃棄の年度（`disposal_kind = scrap`。同じ案に足す） | 借方 固定資産除却損 / 貸方 資産の勘定（`disposalAmount`）。家事分 > 0 なら 借方 事業主貸 / 貸方 固定資産除却損 |
| 定額法の売却の年度（`disposal_kind = sale`。除却損の 2 行の代わり） | 借方 事業主貸 / 貸方 資産の勘定（`disposalAmount` の全額。家事分に分けない、除却損の科目を使わない）。譲渡所得の計算は範囲外 |
| 開業費（`deferred_amortization`） | 借方 減価償却費 / 貸方 開業費の勘定（決定の額） |

案を作らないとき: 金額がすべて 0、年度が締め済み（FR-021）、登録済み（その出所・年度に有効な仕訳がある、FR-017）、少額の特例で `linked_journal_id` がある、開業費の決定がない・0 円。

## 3. 状態の移り変わり

- **定額法・一括償却の資産**: 登録 → 年度ごとに（`startYear` から）償却の案 → 仕訳を登録（`adjustment_journal_refs`、`depreciation`、年度）→ 翌年度 … → 定額法は残高 1 円で案が止まる、一括償却は n 年度で止まる。除却（`disposed_on`、`disposal_kind`）→ 定額法は除却の年度の案（償却 + 廃棄なら除却損 ／ 売却なら事業主貸への振替）で終わる。一括償却は種類にかかわらず続く
- **計算に効く項目の変更・除却**: 該当する年度に有効な償却の仕訳があれば 409（R12）。仕訳を 001 で取り消す → 案が再び出る → 変更・除却 → 案を登録し直す
- **開業費**: 登録 → 年度の決定（0 円 → 記録だけ ／ 正の額 → 案）→ 案を登録 → 翌年度の上限が減る。仕訳を取り消すと、その年度の決定は残り、案が再び出る（金額を変えてもよい）
- **年度の締め（001）**: 締め済みの年度では案を作らない（一覧に出さず、確定は `PERIOD_CLOSED`）。資産・開業費の登録と、締め済みの年度の決定の変更は `PERIOD_CLOSED`（決定だけ。資産の登録は 003 と同じく締め済みでもできる）

## 4. 不変条件（001〜008 の INV-1〜54 に追加）

- **INV-55**（定額法）: どの資産（取得価額、耐用年数 2〜50 の率、供用の月、前年までの累計、除却の有無と種類）でも、各年度 `0 ≤ dep(Y) ≤ opening(Y) − 1`、月数は 1〜12、`closing(Y) = opening(Y) − dep(Y) − disposalAmount(Y) = opening(Y+1)`。除却しなければ、`startYear` から償却が止まるまでの Σdep = 取得価額 − 前年までの累計 − 1（SC-002）。除却すれば（廃棄・売却とも）、除却の年度の期末の残高は 0
- **INV-56**（一括償却）: どの取得価額（範囲内）・n・前年までの累計でも、各年度の額は 0 以上の整数、`startYear` から n 年度目までの合計 = 取得価額 − 前年までの累計、n 年度目の後は 0。除却の有無で各年度の額は変わらず、除却損は常に 0（FR-010、FR-011、SC-002）
- **INV-57**（償却の案の形）: 案は INV-23 を満たし、資産の勘定の貸方の合計 = `dep + disposalAmount`、減価償却費の借方 − 貸方 = `deductible`、除却損の借方 − 貸方 = `disposalDeductible`（売却なら除却損の行はない）、事業主貸の借方 = 家事分の合計（売却なら + `disposalAmount`）。`0 ≤ deductible ≤ dep`、`deductible + 家事分 = dep`（INV-20 と同じ規則）
- **INV-58**（開業費）: どの決定の列でも、各年度 `0 ≤ 決定の額 ≤ opening(Y)`（超える決定は拒否される）、`opening(Y) ≥ 0`、`0 ≤ target(Y) ≤ opening(Y)`。0 円の決定は案を作らない。有効な仕訳のない決定は翌年度の上限を減らさない
- **INV-59**（台帳と帳簿の一致）: 生成した資産・開業費について、`startYear` の期首残高を台帳の期首に合わせて登録し、各年度の案をすべて登録して翌年度の期首に繰り越すと、どの年度でも `ASSET_REGISTER_MISMATCH` と `DEPRECIATION_MISMATCH` は出ない（SC-003、FR-020）
- **INV-60**（登録は 1 回）: どの（資産・開業費, 年度）でも、有効な償却の仕訳は高々 1 件。登録済みなら案の一覧に出ず、確定は `ADJUSTMENT_NOT_NEEDED`。仕訳を取り消すと案が再び出る（FR-017）

検証: INV-55〜58 は domain の性質テスト（`fc.assert(fc.property(...))`）。INV-59・60 は domain の性質テスト（`FakeUnitOfWork`）で、INV-60 は db の統合テスト（`closing-adjustment.test.ts`、実際の UnitOfWork）でも確かめる。
