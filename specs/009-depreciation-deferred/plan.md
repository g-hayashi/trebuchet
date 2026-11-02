# Implementation Plan: 定額法・一括償却資産・開業費の償却

**Branch**: `009-depreciation-deferred` | **Date**: 2026-11-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/009-depreciation-deferred/spec.md`

## Summary

003 の固定資産台帳と決算整理の仕訳の案（ADR 0005）を、複数年の償却に広げる。償却方法に定額法（2007-04-01 以後の取得、耐用年数 2〜50）と一括償却資産を足し、年度ごとの償却費を資産の属性と税制の値（償却率の表、一括償却の範囲・年数、開業費の月数。適用期間・出典つき）から都度計算する（強制償却。research R6）。開業費は繰延資産として登録し、年度ごとに利用者が決めた額（0 円を含む）を保存する（任意償却、R5）。どれも 003 の `commitAdjustment` で仕訳と出所（`adjustment_journal_refs`、年度つき）を 1 トランザクションで登録し、決算書 3 ページの「減価償却費の計算」に載せて欄 18 と照らす。除却は月割りの償却と、残りの未償却残高（廃棄なら除却損、売却なら事業主貸への振替。譲渡所得の計算は範囲外）を 1 つの案にする（R8）。期首の帳簿残高と台帳の期首の未償却残高を勘定ごとに照合する（R10）。計算・検証・照合はドメイン層の純関数とし、INV-55〜60 をプロパティテストで検証する。

## Technical Context

**Language/Version**: TypeScript 7.0（`strict: true`, ESM）、Node.js 26.9（001〜008 と同じ）

**Primary Dependencies**: 003 と同じ。追加の依存はない

**Storage**: 事業体ごとの SQLite に 3 表を追加（`straight_line_rates`、`deferred_assets`、`deferred_amortizations`）。`fixed_assets` に列を追加し、CHECK を変える 4 表（`fixed_assets`、`adjustment_journal_refs`、`tax_parameters`、`closing_audit_log`）を作り直す。マイグレーション `0011_depreciation`（生成 + 手直し）と `0012_depreciation_integrity`（`--custom`。償却率 49 行・税制の値 4 行の投入、トリガーの作り直し）（data-model.md、research R14）。勘定科目の初期セットに 5300 固定資産除却損

**Testing**: Vitest ＋ fast-check（INV-55〜60）、国税庁の計算例の例のテスト（SC-001）、テンポラリの SQLite での統合テスト（STRICT、トリガー、投入値と seed の一致、確定の全部か無か）、Hono の `app.request()`、Testing Library ＋ jsdom。E2E は足さない（quickstart の手動確認で代える。003 と同じ）

**Target Platform**: macOS（Apple Silicon）上のローカル Web アプリ（001 と同じ）

**Project Type**: Web アプリケーション（001 の pnpm monorepo に追加）

**Performance Goals**: 資産 50 件・開業費 1 件の事業体で、決算書の画面の表示が 2 秒以内（SC-005。`bench:reports` に足す）。償却の計算は資産ごとに `startYear` から年度を積み上げる（最大 50 年 × 50 件）

**Constraints**: 金額は整数、割合は万分率、償却率は千分率の整数（R2・R3。積は 6×10^15 未満で安全な整数）。償却の額・決算書の値を保存しない（開業費の決定は利用者の判断なので保存する、R5）。実データとその金額・資産名・按分率をリポジトリに含めない。001 の仕訳・締め・監査ログの規則と、003 の API の形（追加の項目を除く）を変えない

**Scale/Scope**: 年に 1 回の決算。資産は数件〜数十件、開業費は 1 件。画面の変更は固定資産台帳（方法の選択と入力、開業費の欄と年度の決定）、決算書 3 ページの列、決算整理の案の一覧の表示

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | ✅ | 償却は決算整理の仕訳として 001 の `createJournal`（`validateJournal`）を通して登録する（INV-23、INV-57）。各年度の償却費は保存せず資産の属性から導出する（R6）。決算書は仕訳から導出したまま。金額・率は整数（R2・R3）。締め済みの年度の案を作らない（FR-021、R12）。INV-55〜60 をプロパティテストで検証 |
| II. 監査可能性 | ✅ | 償却の仕訳は 001 の `audit_log` に残り、出所を `adjustment_journal_refs`（削除禁止）で持つ。資産・開業費・年度の決定の変更は追記のみの `closing_audit_log`（`deferred_asset`、`deferred_amortization` を追加）。登録済みの仕訳と食い違う変更は、仕訳を取り消してからに限る（R12） |
| III. ローカルファースト | ✅ | 外部への送信はない。実データでの確認は利用者の端末で行い、値をリポジトリに書かない（quickstart §3） |
| IV. AIは提案 | N/A | AI は使わない。仕訳の案は規則による提案で、利用者が登録するまで帳簿に入らない |
| V. テストファースト | ✅ | tasks でテストを先に置く。INV-55〜60 は fast-check。国税庁の計算例は合成の値で例のテストにする。実データはフィクスチャにしない |
| VI. 税制ルールはデータ | ✅ | 定額法の償却率（49 行）、一括償却の範囲・年数、開業費の月数を、適用開始日・終了日・出典 URL つきの表に持つ（R2・R13）。seed とマイグレーションの両方に書き、db のテストで一致を確かめる。率を ⌈1000/年数⌉ の式で代えない |
| VII. シンプルさと境界 | ✅ | 依存を追加しない。年度ごとの結びつきは既存の `adjustment_journal_refs`（年度の列あり）を広げ、新しい結びつきの表を作らない（R7）。確定の経路は 003 の `commitAdjustment` を共有する（R5）。方法の表や差し替えの仕組みは作らず、`depreciate` を方法で分ける（ADR 0005 の定めた足し方）。開業費以外の繰延資産・定率法・中古の簡便法は作らない。表の作り直しは CHECK の列挙を変えるためで、007 の `0009` と同じ手順（R14） |

**Post-design re-check（Phase 1 後）**: ✅ 違反なし。Complexity Tracking は空。利用者の確認（research R16 の Q1〜Q4）は 2026-11-01 に推奨どおり決まり、spec・data-model・contracts に反映した。原則に反する点はない。

## Project Structure

### Documentation (this feature)

```text
specs/009-depreciation-deferred/
├── plan.md              # 本ファイル
├── research.md          # Phase 0（R1〜R16。R16 は利用者の確認の結果と spec の修正）
├── data-model.md        # Phase 1（表、型、計算の規則、INV-55〜60）
├── quickstart.md        # Phase 1
├── contracts/
│   ├── http-api.md      # 追加・変更する API とエラーコード
│   └── domain-module.md # 追加・変更する関数・ユースケース・ポート
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks で作成
```

設計判断の記録: [docs/adr/0012-multi-year-depreciation.md](../../docs/adr/0012-multi-year-depreciation.md)。不変条件の索引: `specs/INVARIANTS.md`（009 の節）。

### Source Code (repository root)

003 の構成に、次を追加・変更する。

```text
packages/
├── schema/src/
│   └── blue-return.ts                 # DepreciationMethod に straight_line・lump_sum、FixedAssetInput の項目、
│                                      # DeferredAssetInput・DeferredAmortizationInput、AdjustmentKind に deferred_amortization、
│                                      # breakdown の union、DepreciationRow の列、BlueReturnWarningCode に 2 つ
├── domain/
│   ├── src/
│   │   ├── blue-return/
│   │   │   ├── tax-parameters.ts      # resolveStraightLineRate（R2）
│   │   │   ├── straight-line.ts       # 新規: serviceMonths, straightLineYear（R3, R8）
│   │   │   ├── lump-sum.ts            # 新規: lumpSumYear（R4）
│   │   │   ├── depreciation.ts        # validateFixedAsset, depreciate, isDepreciationRow,
│   │   │   │                          # proposeDepreciationAdjustment を方法で分ける（R1, R8, R11）
│   │   │   ├── deferred-asset.ts      # 新規: validateDeferredAsset, deferredAmortizationYear,
│   │   │   │                          # validateDeferredDecision, proposeDeferredAmortization, deferredRows（R5）
│   │   │   ├── asset-register.ts      # 新規: checkAssetRegister（R10）
│   │   │   ├── balance-sheet.ts       # DEFERRED_ASSET_NOT_AMORTIZED を決定があれば出さない（R10）
│   │   │   ├── build.ts               # 3 ページの行・警告（R10, R11）
│   │   │   └── csv.ts                 # 3 ページの列（R11）
│   │   ├── seed/
│   │   │   ├── depreciation-rates.ts  # 新規: STRAIGHT_LINE_RATES（R2）
│   │   │   ├── tax-parameters.ts      # 4 行（R13）
│   │   │   └── accounts.individual.ts # 5300 固定資産除却損（R9）
│   │   ├── types.ts                   # FixedAsset の列、StraightLineRate、DeferredAsset、DeferredAmortization、
│   │   │                              # AdjustmentRef.deferredAssetId、TaxParameterKey
│   │   ├── ports.ts                   # ClosingStore に 6 メソッド
│   │   └── usecases/
│   │       ├── blue-return.ts         # 台帳・除却の変更の制限、案の一覧・確定の拡張（R12）
│   │       └── deferred-assets.ts     # 新規: listDeferredAssets, saveDeferredAsset, decideDeferredAmortization
│   └── test/
│       ├── blue-return-arbitraries.ts # 資産・開業費・決定のジェネレーター（R15）
│       ├── fakes/closing.ts           # FakeClosingStore の追加メソッド
│       └── blue-return/*.test.ts / *.property.test.ts   # straight-line, lump-sum, deferred-asset, asset-register など
└── db/
    ├── src/
    │   ├── schema/tenant.ts           # 3 表、列、CHECK
    │   └── closing-repository.ts      # ClosingStore の追加メソッド
    ├── drizzle/tenant/0011_depreciation.sql             # 生成 + STRICT + 作り直し（0009 と同じ手順）
    ├── drizzle/tenant/0012_depreciation_integrity.sql   # --custom: 投入、トリガー
    └── test/closing-*.test.ts / tenant-store.test.ts

apps/
├── server/src/routes/
│   ├── fixed-assets.ts                # 入力の項目、409
│   ├── deferred-assets.ts             # 新規: 開業費の登録・一覧・年度の決定
│   └── blue-return.ts                 # adjustments の kind（入力の Zod が変わるだけ）
└── web/src/
    ├── features/fixed-assets/         # FixedAssetForm（方法・供用日・耐用年数・累計）、DisposeDialog（廃棄・売却）、api.ts
    ├── features/deferred-assets/      # 新規: DeferredAssetForm、AmortizationDecision、api.ts
    ├── features/blue-return/          # FormPage3（償却率・期間の列、方法の表示）、AdjustmentPanel（開業費の案）
    └── routes/e/$entityId/fixed-assets/index.tsx  # 開業費の欄を同じ画面に置く

scripts/bench-reports.ts               # 資産 50 件・開業費 1 件（SC-005）
docs/adr/0012-multi-year-depreciation.md
```

**Structure Decision**: 001 の monorepo と依存の向き（`apps/server → packages/db → packages/domain → packages/schema`、`apps/web → packages/schema`）を変えない。償却の計算は `packages/domain/src/blue-return/` に純関数として置き、Biome の `noRestrictedImports` をそのまま適用する。開業費の画面は新しいルートを作らず、固定資産台帳の画面（`?year=`）に置く（ルートを足すと `routeTree.gen.ts` の再生成が要る）。

## Phase の進め方（tasks への入力）

1. **Setup**: research R13 の要確認（2026 年度の改正で範囲・月数が変わっていないこと）を大綱で確かめる
2. **Foundational**: Zod スキーマ、`types.ts`・`ports.ts`、seed（率・税制の値・科目）、マイグレーション `0011`・`0012`（作り直しとトリガー、`) STRICT;`）、`ClosingStore` の実装と `FakeClosingStore`、`resolveStraightLineRate`、arbitraries。エラーコード・`DepreciationRow`・`AdjustmentKind` を変えるので、`grep -rn` で参照するテストを domain・db・server・web で直す
3. **US1**（定額法: 計算・登録の検証・案・除却・3 ページ・照合・変更の制限・締め）→ **US2**（一括償却）→ **US3**（開業費: 登録・決定・案・3 ページ・`DEFERRED_ASSET_NOT_AMORTIZED` の抑止）
4. 各ユーザーストーリーで「プロパティ／例のテスト → ドメイン → リポジトリ → API → 画面」の順。テストと実装の対を 1 体の部下に渡す。INV-59・60（台帳と帳簿の一致、登録は 1 回）は整合性の難所
5. **Polish**: `bench:reports` に資産 50 件・開業費 1 件（SC-005）、AGENTS.md の「決算書（003）」の節に 009 の場所と規則（償却率の足し方、強制償却の計算、変更の制限）を足す、`docs/requirements.md` の FR-10 の状態、quickstart の手動確認（文言・金額を合わせる）、実データでの照合（メインが行う）、最終の全体検証

## Complexity Tracking

違反なし。
