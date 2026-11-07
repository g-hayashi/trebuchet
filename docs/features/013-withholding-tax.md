# 源泉徴収（013）

仕様: `specs/013-withholding-tax/`。入金の時点で事業主貸に計上する判断: [ADR 0015](../adr/0015-withholding-at-payment.md)。請求・入金の土台は [005](005-recurring-invoicing.md)。

| 層 | 場所 |
|---|---|
| 業務ルール（対象額、税額の式、差引請求額、残額・源泉徴収の残り） | `packages/domain/src/invoicing/withholding.ts`、`detail.ts`、`draft.ts`、`status.ts`、仕訳の案は `journal-drafts.ts` |
| 税制の値（境目・率。適用期間と出典つき） | `packages/domain/src/seed/tax-parameters.ts`（正本）と DB の `packages/db/drizzle/tenant/0020_withholding.sql` |
| ユースケース | `packages/domain/src/usecases/invoicing.ts`（発行、消し込み、年間の一覧 `withholdingSummary`） |
| 永続化（`partner_billing_terms.withholding`、`invoices.withholding_base`・`withholding_tax`、`invoice_payments.withholding_amount`） | `packages/db/src/invoicing-repository.ts`、`schema/tenant.ts`、`0021_withholding_payment_trigger.sql` |
| スキーマ | `packages/schema/src/invoicing.ts` |
| HTTP | `apps/server/src/routes/invoicing.ts`（`GET /withholding/:year`） |
| 画面 | `apps/web/src/features/invoicing/`（`BillingTermsFields.tsx`、`InvoiceDraftEditor.tsx`、`InvoiceDetail.tsx`、`InvoicePrint.tsx`、`PaymentForm.tsx`、`WithholdingList.tsx`）、`routes/e/$entityId/invoices/withholding.tsx` |

- **対象かどうかは取引先の設定に従う**。アプリは所得税法 204 条の対象かを判定しない。対象は個人事業主の事業体だけ（法人は範囲外）。
- **対象額**は、消費税相当額を区分して表示する（`taxDisplay = separate`）ときは税抜、それ以外は合計（013/R3）。**税額**は `floor((min(base, T) × L + max(0, base − T) × H) / 10000)`（013/R1。INV-73）。T・L・H は `tax_parameters` の `WITHHOLDING_THRESHOLD`・`WITHHOLDING_RATE_LOW`・`WITHHOLDING_RATE_HIGH`。発行日に該当する値がなければ `WITHHOLDING_RATE_MISSING`（422）で拒む。
- **発行の仕訳は変えない**（売掛金／売上高を合計で 1 件）。`withholding_base`・`withholding_tax` は発行時に固定し、トリガー `invoices_void_only` が更新を止める（INV-38）。
- **入金の仕訳**は借方 入金先・支払手数料（差額があるとき）・事業主貸 3090（源泉徴収税額）、貸方 売掛金（充当額 = 入金額 + 差額 + 源泉徴収税額）。事業主貸の行は `source = "payment"` の仕訳に出る。充当額の合計が合計を超える消し込みは `PAYMENT_EXCEEDS_BALANCE`（INV-74）。
- **API は源泉徴収税額の既定値を補わない**。省略は 0。「請求書の源泉徴収税額 − 入金済み」の既定は web が `InvoiceDetail.withholdingRemaining` から入れる（013/R6）。
- **年間の一覧**は入金日の暦年で、取り消されていない消し込みの `withholding_amount > 0` を取引先ごとに集計する。合計は帳簿の事業主貸の借方と一致する（INV-75）。確定申告書の作成と支払調書の取込は範囲外。
- 税率を足すときは、`seed/` の正本とマイグレーションの両方に、適用の期間と出典の URL つきで足す（AGENTS.md の税制の値の規則）。
