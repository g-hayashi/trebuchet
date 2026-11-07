# Research: 源泉徴収（013）

番号は 013 の中で振る（他の機能を指すときは `005/R27` の形）。

## R1 源泉徴収税額の式と端数

- **Decision**: `withholdingTax(base, p) = base ≤ 0 ? 0 : floor((min(base, T) × L + max(0, base − T) × H) / 10000)`。T は境目（1,000,000）、L・H は万分率（1021・2042）。整数だけで計算する（`base < 1e12` で積は `2.1e15 < 2^53`。BigInt は要らない）
- **Rationale**: 国税庁の式「（支払金額 − 100 万円）× 20.42% + 102,100 円」と一致する（T × L / 10000 = 102,100 は割り切れるので、全体を 1 回切り捨てても部分ごとに切り捨てても同じ）。1 円未満は切り捨て
- **Alternatives**: 率を % の小数で持つ → 浮動小数になり Constitution I に反する

## R2 税率の持ち方（税制の値）

- **Decision**: 003 の `tax_parameters` に key を 3 つ足す: `WITHHOLDING_THRESHOLD`（1,000,000）、`WITHHOLDING_RATE_LOW`（1021）、`WITHHOLDING_RATE_HIGH`（2042）。期間は 2013-01-01〜2026-12-31 と 2027-01-01〜2047-12-31 の 2 期間（復興特別所得税を含む率）。出典は 2026 年分までが国税庁タックスアンサー No.2795（率と式。期間は頁に書かれていない）、2027 年分からが国税庁の防衛特別所得税の源泉徴収の Q&A（PDF。本文は読めず二次情報で据え置きを確かめた。確度 medium）。正本は `packages/domain/src/seed/tax-parameters.ts`、DB へは手書きのマイグレーションで `INSERT` し、key の CHECK は 0014 の例（`__old_tax_parameters` に写して作り直す）に倣う
- **Rationale**: Constitution VI（税制はデータ、出典つき）。`resolveTaxParameter(key, date, params)` がそのまま使える。2038 年以降の行がなければ発行を `WITHHOLDING_RATE_MISSING` で拒む（spec の Edge Cases）
- **Alternatives**: 専用の表を作る → 既存の表と解決の関数で足りる
- **注意**: `packages/domain/test/blue-return/tax-parameters.test.ts` は行数を直接書いている（14）。行を足すと直す

## R3 源泉徴収の対象額

- **Decision**: `taxDisplay = "separate"` で、消費税相当額の内訳がある（`taxBreakdown` に税率つきの行がある）ときは `total − Σ taxBreakdown.tax`（税抜）。それ以外は `total`（税込）
- **Rationale**: 国税庁の取扱い（報酬と消費税相当額が明確に区分されていれば税抜を対象にできる）。区分を写しに表示するのは `separate` のときだけなので、表示と対象額が食い違わない。税率なしの明細（免税・対象外）は total と同じ額で含まれる
- **Alternatives**: `priceMode` で決める → 税抜入力でも内訳を表示しない（税込のみ）ことがあり、区分の表示と合わない

## R4 取引先の設定の置き場所

- **Decision**: `partner_billing_terms` に `withholding INTEGER NOT NULL DEFAULT 0 CHECK (withholding IN (0, 1))` を足し、`BillingTermsFields` に `withholding: z.boolean().default(false)` を足す
- **Rationale**: 源泉徴収は請求の条件で、請求しない取引先には要らない。取引先の画面の請求の条件（`PartnerProfileForm`・`BillingTermsFields.tsx`）で一緒に編集できる
- **Alternatives**: `partners` に足す → 請求のない取引先にも出てしまう

## R5 請求書に固定する値

- **Decision**: `invoices` に `withholding_base`・`withholding_tax`（どちらも `INTEGER NOT NULL DEFAULT 0`、`0 ≤ withholding_tax ≤ withholding_base ≤ total`）を足す。発行時に、取引先の設定が「あり」なら R1・R3 で計算し、「なし」なら 0・0。トリガー `invoices_void_only` は列を列挙しているので、作り直して 2 列を足す（INV-38）
- **Rationale**: 写しの再現性（005/INV-38）。率は発行日と `tax_parameters` から再現できるので持たない
- **Alternatives**: 率も写しに持つ → 表示しないので不要（YAGNI）

## R6 入金の消し込みと仕訳

- **Decision**: `PaymentInput` に `withholdingAmount: Yen0.optional()`（省略は 0）を足す。`invoice_payments` に `withholding_amount INTEGER NOT NULL DEFAULT 0 CHECK (withholding_amount >= 0)`。充当額 = `amount + fee + withholding`。`treatDifferenceAsFee` のとき `fee = remaining − amount − withholding`。`paymentJournalDraft` は withholding > 0 のとき借方 事業主貸（3090、partnerId つき）の行を足す。残額の計算（`invoiceStatus`）は充当額に源泉徴収税額を含める。既定値（spec FR-008）は web が `InvoiceDetail.withholdingRemaining` を入れる
- **Rationale**: 既存の `PAYMENT_EXCEEDS_BALANCE`・`JOURNAL_LINKED`・`voidPayment` がそのまま効く。科目は spec のとおり事業主貸（個人の所得税のため。期末の振替は要らない）
- **Alternatives**: 発行時に源泉徴収税額を計上する（売掛金を差引額にする）→ 実際に差し引かれる額は入金まで分からず、取引先の計算の違い（spec US2-2）を直せない。API で既定値を補う → 省略時の意味が「0」と「残り」で揺れる。web で入れて API は明示の値だけを受ける

## R7 年間の一覧

- **Decision**: `GET /api/entities/:entityId/withholding/:year`（`FiscalYearParam`）。取消でない消し込みのうち `withholding_amount > 0` で `received_on` がその暦年のものを、取引先ごとに集計する（件数、支払金額 = Σ(amount + fee + withholding)、源泉徴収税額 = Σ withholding）。明細の行も返す。年は暦年（個人の会計期間と同じ）。会計期間がない年は空の一覧を返す
- **Rationale**: 申告の「源泉徴収税額」は実際に差し引かれた額で、入金の日に決まる。帳簿の事業主貸の行（`source = "payment"`）と突き合わせる性質テストで SC-004 を確かめる
- **Alternatives**: 支払金額を対象額（税抜）で出す → 一部入金を年またぎで按分する規則が要り、複雑。支払調書の支払金額と違うときは明細の行と請求書から利用者が確かめる（spec Assumptions）

## R8 画面

- **Decision**: 取引先の請求の条件に「源泉徴収あり」のチェック。請求書の案・詳細・印刷に「源泉徴収税額」「差引請求額」の行（0 のときは出さない）。入金の消し込みの入力に「源泉徴収税額」の欄（既定は残り）。年間の一覧は `routes/e/$entityId/invoices/withholding.tsx`（`?year=`、既定は今年）に置き、請求の画面からつなぐ。API と query key は `features/invoicing/api.ts`
- **Rationale**: 既存の請求の画面の中で完結する。`variant="default"` のボタンは各画面 1 つ（011）
- **Alternatives**: 帳票（reports）の下に置く → 帳票は仕訳から導く表で、請求の記録の一覧とは性質が違う

## R9 文書

- **Decision**: ADR 0015（源泉徴収は入金の時点で事業主貸に計上する）、`docs/features/013-withholding-tax.md` と AGENTS.md の表の 1 行、`docs/requirements.md` の FR-05 の状態、マニュアルの記事（`masters`・`invoices`・`payments`）を更新する
