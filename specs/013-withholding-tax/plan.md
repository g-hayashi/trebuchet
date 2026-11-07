# Implementation Plan: 源泉徴収と仮払税金

**Branch**: `main`（機能ブランチは切っていない） | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/013-withholding-tax/spec.md`

## Summary

「源泉徴収あり」の取引先の請求書に、源泉徴収税額と差引請求額を載せる。入金の消し込みで、実際に差し引かれた源泉徴収税額を事業主貸に計上して売掛金を消す。暦年ごとの一覧を出す。005 の請求・入金の表と仕訳に列と行を足すだけで、新しい表は作らない。税率は 003 の `tax_parameters` に適用期間と出典つきで足す（research R1〜R8）。

## Technical Context

**Language/Version**: TypeScript（strict、ESM）、Node 26（型の除去で直接実行）

**Primary Dependencies**: 既存のみ（Hono、React + TanStack Router/Query、Drizzle + better-sqlite3-multiple-ciphers、Zod、Vitest + fast-check）。新しい依存は足さない

**Storage**: テナント DB（SQLite）。`packages/db/drizzle/tenant/` に 0020 以降のマイグレーション（列の追加は generate、`tax_parameters` の行・CHECK・トリガーの作り直しは `--custom`）

**Testing**: Vitest。domain は性質テスト（INV-73〜75）と具体例、db・server・web は既存の 005 のテストのファイルに足す

**Target Platform**: macOS のローカル Web アプリ（127.0.0.1:8787 / localhost:5173）

**Project Type**: pnpm モノレポの Web アプリ（`packages/{schema,domain,db}`、`apps/{server,web}`）

**Performance Goals**: 既存どおり（請求は月に 10 件未満。年間の一覧は入金数十件）

**Constraints**: 金額は整数。発行済みの写しは不変（INV-38）。源泉徴収の仕訳は `JOURNAL_LINKED` で通常の訂正を拒む（INV-39）

**Scale/Scope**: 取引先 6〜8 社、請求 約 100 件/年

## Constitution Check

| 原則 | 判定 | 根拠 |
|---|---|---|
| I 帳簿の正確性 | 適合 | 整数の式（R1）。入金の仕訳は貸借一致で、INV-73〜75 を fast-check で書く。発行の仕訳は変えない |
| II 監査可能性 | 適合 | 列の追加だけで物理削除なし。写しはトリガーで不変。取消は 005 の取消の仕訳のまま。設定・操作は既存の監査の記録に載る |
| III ローカルとプライバシー | 適合 | 外部の送信なし |
| IV AI は提案 | 該当なし | AI を使わない |
| V テストファースト | 適合 | tasks で各ストーリーのテストを先に置く |
| VI 税制はデータ | 適合 | 率と境目を `tax_parameters` に適用期間と出典つきで足す（R2）。ロジックに直書きしない |
| VII シンプルさ | 適合 | 新しい表・抽象化なし。率は写しに持たない（R5） |

Phase 1 の後の再確認: 違反なし。

## Project Structure

### Documentation (this feature)

```text
specs/013-withholding-tax/
├── plan.md
├── research.md        # R1〜R9
├── data-model.md      # §1 表、§2 計算、§3 仕訳、§4 INV-73〜75
├── quickstart.md
├── contracts/http-api.md  # §1〜4
└── tasks.md           # /speckit-tasks で作る
```

### Source Code (repository root)

```text
packages/schema/src/invoicing.ts          # BillingTermsFields.withholding、PaymentInput.withholdingAmount、WithholdingSummary、詳細の項目
packages/domain/src/
├── types.ts                              # TaxParameterKey に 3 つ
├── seed/tax-parameters.ts                # 正本に 3 行（出典 URL）
├── invoicing/withholding.ts              # 新規: withholdingBase・withholdingTax（純粋関数、R1・R3）
├── invoicing/status.ts                   # 充当額に源泉徴収税額
├── invoicing/journal-drafts.ts           # paymentJournalDraft に事業主貸 3090
└── usecases/invoicing.ts                 # issueInvoice・recordPayment・previewInvoiceCalculation・withholdingSummary
packages/db/
├── src/schema/tenant.ts                  # 3 表に列
├── drizzle/tenant/0020_*.sql, 0021_*.sql # 列の追加 / tax_parameters・CHECK・トリガー
└── src/（請求のリポジトリ）               # 列の読み書き、年間の集計の問い合わせ
apps/server/src/routes/invoicing.ts       # GET /withholding/:year、既存の応答の項目
apps/web/src/
├── features/invoicing/api.ts             # withholdingSummaryQuery
├── features/invoicing/BillingTermsFields.tsx, InvoicePrint.tsx, InvoiceDetail.tsx（入金の欄）
├── routes/e/$entityId/invoices/withholding.tsx  # 新規: 年間の一覧
└── features/manual/content.ts            # masters・invoices・payments の記事
docs/adr/0015-withholding-at-payment.md, docs/features/013-withholding-tax.md, AGENTS.md の表、docs/requirements.md FR-05、specs/INVARIANTS.md
```

**Structure Decision**: 005 の請求の層（schema → domain → db → server → web）にそのまま足す。テストは 005 の既存ファイル（`packages/domain/test/invoicing/`、`packages/db/test/invoicing-*.test.ts`、`apps/server/test/invoicing.*.api.test.ts`、`apps/web/test/routes/invoice*.test.tsx`）に足し、性質テストは `packages/domain/test/invoicing/withholding.property.test.ts` を新しく作る。

## 実装の順序（tasks の目安）

1. 基盤: 税制の値（正本・マイグレーション・型）、表の列・トリガー、`withholdingTax`・`withholdingBase` と INV-73
2. US1: 取引先の設定 → 計算・案・発行 → 詳細・印刷の画面
3. US2: 消し込み（入力・残額・仕訳）と INV-74 → 入金の画面
4. US3: 年間の一覧（domain・db・server・web）と INV-75
5. 文書: ADR 0015、`docs/features/013`、AGENTS.md、requirements、INVARIANTS、マニュアル（撮影は利用者の端末）
6. 最終の検証（メイン）と quickstart の端末での確認（利用者）

## Complexity Tracking

違反なし。
