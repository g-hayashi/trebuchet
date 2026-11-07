# Data Model: 源泉徴収（013）

005 の表（`packages/db/src/schema/tenant.ts`）に列を足す。新しい表は作らない。

## §1 表の変更

### §1.1 `tax_parameters`（003）に行を足す（R2）

| key | effective_from | effective_to | value | 意味 |
|---|---|---|---|---|
| `WITHHOLDING_THRESHOLD` | 2013-01-01・2027-01-01 | 2026-12-31・2047-12-31 | 1000000 | 低い率を掛ける上限（円） |
| `WITHHOLDING_RATE_LOW` | 2013-01-01・2027-01-01 | 2026-12-31・2047-12-31 | 1021 | 境目以下の率（万分率） |
| `WITHHOLDING_RATE_HIGH` | 2013-01-01・2027-01-01 | 2026-12-31・2047-12-31 | 2042 | 境目を超える部分の率（万分率） |

2027 年分から防衛特別所得税が加わり復興特別所得税の率が下がるが、合計の掛け率 102.1% は変わらないので率は同じ。期間を分けて出典を変える（R2）

key の CHECK を作り直す。`TaxParameterKey`（`packages/domain/src/types.ts`）に 3 つ足す。

### §1.2 `partner_billing_terms`（R4）

| 列 | 型 | 規則 |
|---|---|---|
| `withholding` | INTEGER NOT NULL DEFAULT 0 | 0 か 1。1 なら発行時に源泉徴収税額を計算する |

### §1.3 `invoices`（R5）

| 列 | 型 | 規則 |
|---|---|---|
| `withholding_base` | INTEGER NOT NULL DEFAULT 0 | 源泉徴収の対象額。設定「なし」なら 0 |
| `withholding_tax` | INTEGER NOT NULL DEFAULT 0 | 源泉徴収税額。`0 ≤ withholding_tax ≤ withholding_base ≤ total` |

`invoices_void_only` に 2 列を足して作り直す（発行後は変わらない）。

### §1.4 `invoice_payments`（R6）

| 列 | 型 | 規則 |
|---|---|---|
| `withholding_amount` | INTEGER NOT NULL DEFAULT 0 | 実際に差し引かれた源泉徴収税額。`>= 0` |

## §2 計算

- **対象額**（R3）: `taxDisplay = "separate"` かつ税率つきの内訳があれば `total − Σ tax`、それ以外は `total`
- **税額**（R1）: `floor((min(base, T) × L + max(0, base − T) × H) / 10000)`。`base ≤ 0` は 0
- **差引請求額**: `total − withholding_tax`（保存しない）
- **充当額**（消し込み 1 件）: `amount + fee_amount + withholding_amount`
- **残額**: `max(0, total − Σ 充当額)`（取消を除く。005 の `invoiceStatus` を拡張）
- **源泉徴収の残り**（FR-008 の既定値）: `max(0, withholding_tax − Σ withholding_amount)`（取消を除く）

## §3 仕訳

入金（`source = "payment"`、入金日付、全行に partnerId）:

| 借方 | 貸方 |
|---|---|
| 入金先（補助科目）amount | 売掛金 1030 = amount + fee + withholding |
| 支払手数料 5250 fee（> 0 のとき） | |
| 事業主貸 3090 withholding（> 0 のとき） | |

発行の仕訳（005）は変えない（売掛金／売上高を total で）。

## §4 不変条件（INV-73〜75。`specs/INVARIANTS.md` に足す）

| INV | 内容 |
|---|---|
| INV-73 | 源泉徴収税額は整数で `0 ≤ tax ≤ base`、base について単調増加で、`base ≤ T` なら `floor(base × L / 10000)`、`base > T` なら `floor(T × L / 10000) + floor((base − T) × H / 10000)` と等しい（国税庁の式） |
| INV-74 | 任意の発行・消し込み（源泉徴収税額・差額を含む）・取消の列で、Σ 充当額 ≤ total、入金の仕訳は貸借一致し、売掛金の貸方 = 充当額、事業主貸の借方 = withholding_amount。INV-33・34 は充当額に源泉徴収税額を含めても成り立つ |
| INV-75 | 年間の一覧の源泉徴収税額の合計 = その暦年の入金日の、取消でない `source = "payment"` の仕訳の事業主貸の借方の合計 |

発行済みの `withholding_base`・`withholding_tax` の不変は INV-38 に含める（トリガーとテストを足す）。

## §5 状態

請求書の状態（unpaid／partial／paid）は 005 のまま。残額の式だけが §2 に変わる。
