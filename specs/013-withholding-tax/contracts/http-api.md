# HTTP API: 源泉徴収（013）

マウントは `/api/entities/:entityId`。005 の `contracts/http-api.md` への差分だけを書く。認証・CSRF・Host の検査は既存のまま。

## §1 請求の条件（変更）

`PUT /partners/:partnerId/billing-terms`、`POST /partners/profile`、`PUT /partners/:partnerId/profile` の `billingTerms` と、`GET /billing-terms` の応答に足す:

```ts
withholding: boolean // 既定 false
```

## §2 請求書の計算・案・発行・詳細（変更）

`POST /invoices/calculate`、`POST /invoices/drafts`、`POST /invoices`、`GET /invoices/:invoiceId`、一覧の項目に足す:

```ts
withholdingBase: number   // 0 は源泉徴収なし
withholdingTax: number
netAmount: number         // total − withholdingTax
```

`GET /invoices/:invoiceId` だけに足す:

```ts
withholdingPaid: number      // 取消でない消し込みの Σ withholdingAmount
withholdingRemaining: number // max(0, withholdingTax − withholdingPaid)
```

`POST /invoices/calculate` は `partnerId` から取引先の設定を引く（入力に `withholding` を取らない）。

**エラー（足す）**: `WITHHOLDING_RATE_MISSING`（422）— 発行日に源泉徴収の税制の値がない。`details: { date }`

## §3 入金の消し込み（変更）

`POST /invoices/:invoiceId/payments` の `PaymentInput` に足す:

```ts
withholdingAmount?: number // 0 以上の整数。省略は 0
```

- `treatDifferenceAsFee` のとき `fee = remaining − amount − withholdingAmount`（0 以下は `VALIDATION`）
- `amount + fee + withholdingAmount > remaining` は `PAYMENT_EXCEEDS_BALANCE`（422、`details.applied` は源泉徴収税額を含む）
- 応答の消し込みに `withholdingAmount` を足す

## §4 年間の源泉徴収（新規）

`GET /withholding/:year`（`validate("param", FiscalYearParam)`）

```ts
type WithholdingSummary = {
  year: number
  partners: {
    partnerId: string
    partnerName: string
    paymentCount: number
    appliedTotal: number     // Σ(amount + fee + withholding)
    withholdingTotal: number
    payments: {
      paymentId: string
      invoiceId: string
      invoiceNo: string
      receivedOn: string     // YYYY-MM-DD
      applied: number
      withholdingAmount: number
    }[]
  }[]                        // 取引先名の順
  appliedTotal: number
  withholdingTotal: number
}
```

対象は取消でない消し込みのうち `withholdingAmount > 0` で、`receivedOn` がその年のもの。該当がなければ `partners: []`。Zod は `packages/schema/src/invoicing.ts` に置く。
