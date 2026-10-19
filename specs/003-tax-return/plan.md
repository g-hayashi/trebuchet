# Implementation Plan: 決算処理と確定申告の支援（青色申告決算書の作成）

**Branch**: `003-tax-return` | **Date**: 2026-10-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-tax-return/spec.md`

## Summary

001 の帳簿と 002 で取り込んだ仕訳から、青色申告決算書（一般用）の1〜4ページの各欄を都度導出し、画面・印刷・CSV で示す。家事按分と少額減価償却資産は、ドメインが決算整理の仕訳の案を作り、利用者が確かめてから 001 の仕訳として登録する（research R4）。青色申告特別控除は要件の回答と税制の値（適用開始日・出典つき、R3）から決める。前の年度の期末から元入金を繰り越して期首と比べ、食い違いと負の残高を知らせる。事業所得以外の控えと提出書類の場所を年度ごとに記録する。002 の取込では、免税の期間の税区分の警告を1件にまとめる。様式・計算・検査はドメイン層の純関数とし、INV-18〜24 をプロパティテストで検証する。実データでの R7 との一致は、ローカル専用のスクリプトで確かめる。

## Technical Context

**Language/Version**: TypeScript 7.0（`strict: true`, ESM）、Node.js 26.9（001・002 と同じ）

**Primary Dependencies**: 001 と同じ。追加の依存はない（印刷はブラウザの印刷と CSS、CSV は既存の書き方、ファイルの有無は `node:fs`。research R13, R14）

**Storage**: 事業体ごとの SQLite に10表を追加（`tax_parameters`、`home_use_allocations`、`rent_details`、`fixed_assets`、`adjustment_journal_refs`、`blue_deduction_answers`、`closing_notes`、`tax_return_memos`、`filed_documents`、`closing_audit_log`）。マイグレーション `0003_tax_return`（data-model.md）。既存の表は変えない

**Testing**: Vitest ＋ fast-check（INV-18〜24）、テンポラリの SQLite での統合テスト（案の登録の全部か無か、トリガー、投入値）、Hono の `app.request()`、Testing Library ＋ jsdom。E2E は足さない（spec の Assumptions。quickstart の手動確認で代える）

**Target Platform**: macOS（Apple Silicon）上のローカル Web アプリ（001 と同じ）

**Project Type**: Web アプリケーション（001 の pnpm monorepo に追加）

**Performance Goals**: 約500仕訳の年度で、決算書の全ページの表示が2秒以内（SC-006。`bench:reports` に足す）

**Constraints**: 金額は整数、割合は万分率の整数（R5）。決算書の値を保存しない（Constitution I）。実データとその金額・取引先名・按分率をリポジトリに含めない。001 の仕訳・締め・監査ログの規則と、002 の取込の API の形を変えない

**Scale/Scope**: 年に1回の決算。按分の登録は数件、資産は年に数件、控え・書類は年に十数件。画面は5つ（決算書、按分と地代家賃の内訳、固定資産台帳、控除の回答、申告の控え）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | ✅ | 決算書は仕訳・期首残高から都度導出し、保存しない（R1）。按分と償却は決算整理の仕訳として 001 の `createJournal`（`validateJournal`）を通して登録する（R4, INV-23）。金額・割合は整数（R5）。INV-18〜24 をプロパティテストで検証 |
| II. 監査可能性 | ✅ | 決算整理の仕訳は 001 の監査ログに残り、出所を `adjustment_journal_refs` で持つ（削除禁止のトリガー）。按分・資産・内訳・回答・メモの変更は追記のみの `closing_audit_log`（R12） |
| III. ローカルファースト | ✅ | 書類はパスを記録するだけで中身を読まない（R13）。実データでの照合はローカル専用のスクリプトで、決算書の値は `work/` の JSON から読み、出力をコミットしない（R15） |
| IV. AIは提案 | N/A | AI は使わない。仕訳の案は規則による提案で、利用者が登録するまで帳簿に入らない |
| V. テストファースト | ✅ | tasks でテストを先に置く。INV-18〜24 は fast-check。実データはフィクスチャにしない |
| VI. 税制ルールはデータ | ✅ | 少額減価償却資産の基準額・年間の上限・適用期間、控除の上限額を `tax_parameters`（適用開始日・終了日・出典 URL）に持つ（R3）。消費税の区分は 001 の設定を使う（R11） |
| VII. シンプルさと境界 | ✅ | 依存を追加しない。様式はコードの定数（R2）。既存の表（`journals.source`、`audit_log`）の CHECK を変えず、参照の表と専用の履歴の表で足りる（R4, R12）。償却の方法は表の形にするが、実装は1つだけ（R7）。新しいポートは `ClosingStore` と `ClosingUnitOfWork` |

**Post-design re-check（Phase 1 後）**: ✅ 違反なし。Complexity Tracking は空。

## Project Structure

### Documentation (this feature)

```text
specs/003-tax-return/
├── plan.md              # 本ファイル
├── research.md          # Phase 0（R1〜R16）
├── data-model.md        # Phase 1（表、型、INV-18〜24）
├── quickstart.md        # Phase 1
├── contracts/
│   ├── http-api.md      # 追加する API とエラーコード
│   └── domain-module.md # 追加する関数・ユースケース・ポート
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks で作成
```

### Source Code (repository root)

001・002 の構成に、次を追加・変更する。

```text
packages/
├── schema/src/
│   ├── blue-return.ts             # BlueReturn, AdjustmentProposal, HomeUseAllocationInput, FixedAssetInput, DeductionAnswersInput, TaxReturnMemoInput, FiledDocumentInput など
│   └── import.ts                  # ImportWarningCode に TAX_CATEGORY_SUSPICIOUS_EXEMPT（R11）
├── domain/
│   ├── src/
│   │   ├── blue-return/
│   │   │   ├── form.ts            # BLUE_RETURN_FORMS, formForYear（R2）
│   │   │   ├── tax-parameters.ts  # resolveTaxParameter（R3）
│   │   │   ├── home-use.ts        # computeHomeUse, validateHomeUseAllocation, proposeHomeUseAdjustment（R4〜R6）
│   │   │   ├── depreciation.ts    # DEPRECIATION_METHODS, validateFixedAsset, depreciate, proposeDepreciationAdjustment（R7）
│   │   │   ├── deduction.ts       # blueDeductionCap, blueDeduction（R9）
│   │   │   ├── sales.ts           # summarizeMonthlySales, summarizeSalesPartners（R10）
│   │   │   ├── opening-check.ts   # checkOpeningCarryForward（R8）
│   │   │   ├── build.ts           # buildBlueReturn
│   │   │   └── csv.ts             # blueReturnToCsv（R14）
│   │   ├── seed/tax-parameters.ts
│   │   ├── import/freee/plan.ts   # 免税の期間の警告のまとめ（R11）
│   │   ├── ports.ts               # ClosingStore, ClosingUnitOfWork を追加
│   │   └── usecases/blue-return.ts
│   └── test/
│       ├── blue-return-arbitraries.ts
│       └── blue-return-*.test.ts / *.property.test.ts
└── db/
    ├── src/
    │   ├── schema/tenant.ts       # 10表
    │   └── closing-repository.ts  # ClosingStore, ClosingUnitOfWork の実装
    ├── drizzle/tenant/0003_tax_return.sql   # 生成 ＋ STRICT ＋ 投入 ＋ トリガー（--custom）
    └── test/closing-*.test.ts

apps/
├── server/src/routes/
│   ├── blue-return.ts             # 決算書、CSV、案、按分、内訳、控除の回答、メモ
│   ├── fixed-assets.ts
│   └── tax-return.ts              # 控え、書類（fileExists は node:fs）
└── web/src/
    ├── routes/e/$entityId/blue-return/{index,$year/index,$year/home-use,$year/deduction}.tsx
    ├── routes/e/$entityId/fixed-assets/index.tsx
    ├── routes/e/$entityId/tax-return/$year.tsx
    └── features/blue-return/      # FormPage1〜4, AdjustmentPanel, WarningList, print.css など

scripts/
└── verify-tax-return.ts           # 実データでの照合（ローカル専用, R15）。package.json に verify:tax-return
```

**Structure Decision**: 001 の monorepo と依存の向き（`apps/server → packages/db → packages/domain → packages/schema`、`apps/web → packages/schema`）を変えない。決算書のロジックは `packages/domain/src/blue-return/` に置き、Biome の `noRestrictedImports` をそのまま適用する。ファイルの有無の確認（`node:fs`）はサーバーで行う。

## Phase の進め方（tasks への入力）

1. **Setup**: 様式の値の確認（R2 のゲート。利用者が原本と照らす）、`verify-tax-return.ts` の骨組み（`work/` の JSON の形をコメントに書く。値は書かない）
2. **Foundational**: Zod スキーマ、マイグレーション `0003_tax_return`（10表、投入、トリガー）、`ClosingStore`・`ClosingUnitOfWork`、`resolveTaxParameter`、様式の定数、arbitraries、`buildBlueReturn` の骨組み（1ページだけ）
3. **US1**（損益計算書・控除・CSV・印刷）→ **US2**（家事按分・地代家賃の内訳・案の登録）→ **US3**（固定資産台帳）→ **US4**（貸借対照表・元入金の繰越）→ **US5**（月別売上・売上先）→ **US6**（控え・書類）→ **US7**（免税の期間の警告）
4. 各ユーザーストーリーで「プロパティ／ユニットテスト → ドメイン → リポジトリ → API → 画面」の順。テストと実装の対を1体の部下に渡す
5. US7 は警告のコードを足すため、`TAX_CATEGORY_SUSPICIOUS` を参照するテストを domain・server・web で grep して直す
6. **Polish**: `bench:reports` に決算書を足す（SC-006）、AGENTS.md・README の更新、quickstart の手動確認（文言・件数を合わせる）、実データでの照合（SC-001・SC-002、ローカル専用。メインが行う）、最終の全体検証

## Complexity Tracking

違反なし。
