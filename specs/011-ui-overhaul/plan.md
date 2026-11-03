# Implementation Plan: 画面の作り直し（日々の使いやすさ）

**Branch**: `011-ui-overhaul` | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/011-ui-overhaul/spec.md`

## Summary

001〜010 の機能を変えずに、画面の骨組み（ヘッダー・メニュー・ホーム・知らせ・ボタンの見た目・スマホの幅）と、仕訳・明細・証憑・請求・帳票・決算・マスタ・設定の各画面の導線を作り直す。大半は `apps/web` だけで済む（下の「US ごとの変更の層」）。domain・db・server に手が入るのは FR-062 の一覧に限り、次の 10 個: ホームの要約の読み取り（R3）、仕訳の下書き（R6）、過去の仕訳からの候補（R5）、仕訳の一覧の件数・合計（R7）、ルールの自動の作成と利用者の管理の区別（R9）、評価と申告の控えの削除（R10・R14）、仕訳帳の並び（R12）、最初からある科目の保護と取引先の使用停止（R15）、バックアップの既定の置き場所と記録の書き出し（R16・R17）、仕訳の入力の AI の候補（R19）。依存（npm）は足さない。combobox・知らせ・横のパネルは自前の部品と既存の `radix-ui` の Dialog で作る（R2）。

帳簿の不変条件（INV-1〜68）は変えない。新しい不変条件を INV-69〜72 として足す（data-model §4）: 下書きは帳簿に入らない、最初からある科目の名前と削除の保護、利用者が管理するルールを自動で上書きしない、ホームの数字 = 損益計算書・貸借対照表。

## Technical Context

**Language/Version**: TypeScript 7.0（`strict: true`, ESM）、Node.js 26.9（001〜010 と同じ）

**Primary Dependencies**: 追加の npm の依存はない。画面は React + Vite + TanStack Router/Query + Tailwind v4 + 既存の `components/ui/`（shadcn の new-york 風、`radix-ui` は Dialog だけ）。combobox・知らせ（toast）・横のパネル（Sheet）・ステップの表示は自前の部品（R2）。印刷はブラウザの `window.print()` と `@media print`（R13）

**Storage**: 事業体の SQLite: 表 `journal_drafts` を足す（R6）、`inference_rules` に列 `managed_by` を足す（R9）、表 `eval_runs`・`tax_return_memos`・`filed_documents` を消す（R10・R14）。registry・`auth.sqlite` は変えない。バックアップの既定の置き場所はリポジトリ直下の `bak/`（R16。`.gitignore` に足す）。ブラウザの `localStorage` に、最後に開いた事業体（既存）・証憑の区分の既定・入金先の既定を置く（帳簿のデータではない。R4）

**Testing**: Vitest + fast-check（INV-69〜72）、テンポラリの SQLite の統合テスト（下書き・ルール・科目の保護・表の削除）、Hono の `app.request()`（新しい API、INV-29 の網羅）、Testing Library + jsdom（画面。`mock-api.ts` に既定の応答を足す）。E2E は既存の 5 本をメニューの変更に合わせて直す（`e2e/helpers/nav.ts`）。スマホの幅は jsdom で測れないので、E2E（Playwright の 390 px のビューポート）1 本と quickstart の実機の確認で確かめる（R11）。AI の精度は `pnpm eval:statements`（新設、CI の外。R10・R19）

**Target Platform**: macOS（Apple Silicon）のローカル Web アプリ。スマホは iPhone の Safari（004 の US4 の ts.net、ホーム画面のアプリ）

**Project Type**: Web アプリケーション（既存の pnpm monorepo）

**Performance Goals**: 約 500 仕訳でホームが 2 秒以内（SC-003。`bench:reports` に足す）。仕訳の一覧の条件の変更から表示まで体感で即時（入力の 300 ms の待ち合わせ。R7）

**Constraints**: web は業務ルールを持たない（AGENTS.md）。税区分の既定は schema の 1 か所に寄せる（R5）。金額は整数。AI に送るのは `buildAiPayload` と同じマスクを通した摘要・金額・日付だけで、取引先の一覧・口座名は送らない（R19、INV-45）。新しい帳簿の API は認証と解錠を要求する（FR-063、INV-29）。施錠の動作（全セッションを消す）は変えない

**Scale/Scope**: 個人の事業体 1〜2 件、年に数千仕訳。画面のルートは約 50（足す・消す・移すものは R1 の表）。web のテスト 55 ファイルの多くが画面の文言・メニューに依存するので、US ごとに直す

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | ✅ | 仕訳の登録・訂正・取消は 001 の API のまま（かんたん入力も 2 行の `JournalInput` を送るだけ、R5）。下書きは別の表で、帳票・試算表・ホームの数字・監査の記録の対象外（INV-69）。ホームの数字は帳票と同じ関数から出す（INV-72、R3）。集計値を保存しない |
| II. 監査可能性 | ✅ | 訂正・取消の理由は必須のまま（定型の理由は文の選択肢にすぎない、R8）。下書きは仕訳ではないので監査の記録の対象外。ルールの変更は今の `inference_rule_history` に残す（R9） |
| III. ローカルファーストとプライバシー | ✅ | 新しく外部へ送る情報の経路を作らない（FR-061）。仕訳の入力の AI の候補は 006 の経路（`createAiSuggester`）に新しい場面の payload を足すだけで、同じ `maskContent` を通した摘要・金額・日付だけを送る（R19）。取引先の一覧は送らない（spec の US11 の「取引先の候補」は AI からではなく過去の仕訳から出す。下の D1）。記録の書き出し（CSV）に秘密・トークン・鍵を含めない（R17）。既定の置き場所 `bak/` は Git の管理外 |
| IV. AIは提案、確定は人 | ✅ | AI の候補は入力欄に入れるだけで、登録は利用者の操作（R19）。出力は `AiSuggestion`（Zod）で検証する。アプリの中の評価をなくす代わりに `pnpm eval:statements` で精度を比べる（R10）。仕訳の入力の場面を足すのは AI の機能の変更なので、同じスクリプトに場面の評価を入れ、足す前と後で比べる |
| V. テストファースト | ✅ | tasks でテストを先に置く。INV-69〜72 は fast-check の性質テスト。画面はコンポーネントテストを先に直す・書く |
| VI. 税制ルールはデータ | ✅ | 税制の値は変えない。消費税の説明（FR-050）は画面の文で、計算は変えない |
| VII. シンプルさと境界 | ✅ | 依存を足さない（R2）。web の税区分の既定の複製を schema の 1 か所にまとめる（R5。今の AGENTS.md の違反を解消する）。domain に新しい純関数（ホームの要約、履歴からの候補、仕訳帳の並び）を置き、db・server は読むだけ。下書きは事業体に 1 件（R6。複数の下書きの管理は作らない） |

**Post-design re-check（Phase 1 後）**: ✅。Complexity Tracking はない。

## spec への差し戻し（spec はこの段階では直さない）

| ID | 対象 | 内容 | 根拠 |
|---|---|---|---|
| D1 | US11 の本文と受け入れ 1、FR-060 | AI の候補は「科目・税区分」だけにする。取引先の候補は過去の仕訳から出す（AI ではない）。AI に取引先の一覧を送ると 006 の規則（取引先の一覧は送らない）に反し、`AiSuggestion` も取引先を持たない | R19、AGENTS.md 006 |
| D2 | FR-015、Key Entities | 下書きは事業体ごとに 1 件（入力の画面の 1 つの枠）。訂正の途中は下書きにしない | R6 |
| D3 | FR-013 | 「読み」で絞り込めるのは最初からある科目（読みの表を schema に持つ）と、利用者が足した科目の名前・コード。利用者の科目に読みの欄は足さない | R5 |
| D4 | FR-006 | 「登録できなかった定期仕訳」は保存されていないので、今の判定（`blocked`）の件数を出す | R3 |
| D5 | FR-033 | 「発行済み」の判定は画面で、請求書の一覧（未取消）から取引先・対象月で行う（API は変えない） | R13 |

## 利用者の判断が要る点

| ID | 問い | 推奨 | 答え（2026-11-03 利用者） |
|---|---|---|---|
| Q1 | 下書きは事業体に 1 件でよいか（D2） | 1 件（毎日 1 人が入力する。複数の下書きの一覧は作らない） | **1 件** |
| Q2 | メニューの並び（R1）: ホーム / 仕訳 / 明細 / 証憑 / 請求 / 帳票 / 決算・申告 / 事業体の設定。定期仕訳は「仕訳」の中、freee の取込は「事業体の設定 > 会計期間と移行」 | この並び | **この並び** |
| Q3 | アプリの中の明細の評価を消し、`pnpm eval:statements`（合成の明細、CI の外）に置き換える（FR-025） | 置き換える | **置き換える** |

**spec への反映（2026-11-03）**: D1〜D5 を `spec.md` に反映した（US11、FR-006・013・015・033・060、Key Entities）。

## US ごとの変更の層

「web だけ」は `apps/web` だけで終わる（`mock-api.ts` と web のテストを含む）。「下の層」は FR-062 の一覧の変更で、schema・domain・db・server に及ぶ。tasks では US ごとに、下の層 → web の順に並べる。

| US | web だけ | 下の層（FR-062） |
|---|---|---|
| US1 骨組み・ホーム | ヘッダー、メニュー、トップの移動、知らせ、ボタンの見た目、ホームの画面（R1・R2・R4） | ホームの要約 `GET /home`（R3、INV-72） |
| US2 仕訳 | かんたん入力、科目の combobox、Enter の移動、横のパネル、複製、定型の理由（R5・R8） | 税区分の既定を schema へ移す、履歴からの候補 `GET /journals/suggestions`、下書き `journal_drafts`、一覧の件数・合計（R5〜R7、INV-69） |
| US3 明細 | ステップ、取込の後の候補の自動の連鎖、1 件ずつの確認、しきい値を設定へ（R9） | ルールの自動の作成と `managed_by`（R9、INV-71）、評価の削除と `eval:statements`（R10） |
| US4 証憑 | 追加・一覧・詳細の分離、複数ファイル（既存の API を 1 件ずつ呼ぶ）、区分の既定、次の未入力へ、折りたたみ（R11） | なし |
| US5 請求 | 流れの画面、発行済みの表示、入金の行の操作、印刷を詳細から（R13） | 取引先と請求の条件を 1 回で保存 `PUT /partners/:id/profile`（R15） |
| US6 帳票 | 科目名から元帳、期間のプリセット、前年の案内（R12） | 仕訳帳の並び `sort`・`order`、比較の応答の `previousHasData`（R12） |
| US7 決算・申告 | 今の年度を開く、要件のダイアログ、使わない欄を隠す、開業費の画面（R14） | 申告の控えの削除（R14） |
| US8 マスタ・期間 | 検索、使用停止の位置、消費税の説明、会計期間の段階、事業体の設定（R15） | 最初からある科目の保護（INV-70）、取引先の `isActive`（R15） |
| US9 設定 | 設定のレイアウト、5 件の表示、施錠の文言、復元を上へ（R16・R17） | 既定の置き場所 `bak/`、記録の CSV の書き出し（R16・R17） |
| US10 スマホ | 幅の対応、スマホのメニュー、PC の推奨（R11） | なし |
| US11 AI | AI の候補の部品（場面を足せる形）（R19） | 仕訳の入力の payload と `POST /journals/ai-suggestion`、`eval:statements` の場面（R19） |

## Project Structure

### Documentation (this feature)

```text
specs/011-ui-overhaul/
├── plan.md              # 本ファイル
├── research.md          # Phase 0（R1〜R20）
├── data-model.md        # Phase 1（表の変更、画面の状態、INV-69〜72）
├── quickstart.md        # Phase 1（自動の検証と手動の確認。SC-011 の要望ごとの確認表）
├── contracts/
│   ├── http-api.md      # 足す・変える・消す API
│   └── ui-shell.md      # ヘッダー・メニュー・ルート・部品の契約（テストが参照する名前）
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks で作る
```

### Source Code (repository root)

```text
packages/schema/src/
├── journals.ts          # JournalDraft、JournalSuggestion、一覧の summary、JournalBookQuery の sort/order
├── tax-defaults.ts      # 新設: defaultTaxCategory（web と domain の共通。R5）
├── account-readings.ts  # 新設: 最初からある科目の読み（R5）
├── home.ts              # 新設: HomeSummary（R3）
├── masters.ts           # PartnerInput.isActive、PartnerProfileInput
└── errors.ts            # ACCOUNT_SYSTEM_PROTECTED

packages/domain/src/
├── home/summary.ts      # 新設: 要約の組み立て（純関数、R3）
├── journals/suggest.ts  # 新設: 履歴からの候補（R5）
├── reports/journal-book.ts  # 並び（R12）
├── statements/rules.ts、usecases/inference-rules.ts  # managed_by（R9）
├── statements/mask.ts、prompt.ts  # 仕訳の入力の payload（R19）
├── usecases/            # home.ts、journal-drafts.ts（新設）、masters.ts（保護・isActive・profile）、evals.ts と blue-return.ts の控えの部分を消す
└── ports.ts

packages/db/src/         # journal_drafts、managed_by、表の削除（マイグレーション 0016・0017）、repositories
apps/server/src/routes/  # home.ts（新設）、journals.ts、statements.ts、masters.ts、reports.ts、auth.ts、backup.ts、tax-return.ts（削除）
apps/server/src/lib/backup-scheduler.ts、backup-run.ts  # 既定の置き場所
apps/web/src/
├── routes/__root.tsx、e/$entityId/route.tsx  # 骨組み（R1）
├── components/ui/       # combobox.tsx、toast.tsx、sheet.tsx、steps.tsx（新設）、button.tsx
├── components/layout/   # 新設: AppHeader、EntityNav、MobileNav、PcRecommended、SettingsLayout
└── features/            # home/（新設）、journals/、statements/、receipts/、invoicing/、reports/、blue-return/、deferred-assets/、entities/、settings/
scripts/eval-statements.ts  # 新設（R10）
```

**Structure Decision**: 既存の構成のまま。web の部品は `components/ui/`（見た目の部品）と `components/layout/`（骨組み）に分け、機能の画面は `features/<機能>/` に置く。

## Complexity Tracking

なし。
