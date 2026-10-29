# Implementation Plan: 明細の取込と AI 仕訳

**Branch**: `006-mfme-ai-journal` | **Date**: 2026-10-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-mfme-ai-journal/spec.md`

## Summary

MF ME の入出金の表を貼り付けて（または server が開くブラウザから自動で取得して）明細を取り込み、口座・日付・金額・内容と出現の順から作るキーで重複を防ぐ（research R2・R3・R13・R14）。取込元の口座ごとに用途（事業用・混在・私用）と帳簿の科目を対応づけ、用途と事業／私用の判定から仕訳の形（事業主貸・事業主借を含む）を純関数で決める（R4・R5）。候補は「既存の仕訳との照合 → 振替の対 → 承認から育てたルール → 端末内の AI（`fm serve`）→ 外部の AI」の順で作り、AI は両方とも OpenAI 互換の Chat Completions で呼び、出力は Zod で検証し、送る内容はマスクする（R6〜R11）。利用者が承認したものだけを、001 の `createJournal`（`source = statement`）で登録するか既存の仕訳に結びつけ、同じトランザクションでルールを学習する（R15・R16）。明細の状態は結びつきと仕訳から導き、仕訳の取消で未処理に戻る。評価は時点で分けて一致率を測り、帳簿の中に残す（R17）。

## Technical Context

**Language/Version**: TypeScript 7.0（`strict: true`, ESM）、Node.js 26.9（型の除去で直接実行）

**Primary Dependencies**: 既存の Hono、Drizzle ＋ better-sqlite3、Zod、React ＋ TanStack Router、Vitest ＋ fast-check。**追加: `playwright`（`apps/server` の dependencies。US4 の取得。2026-10-25 に利用者が承認。R13）**。AI の呼び出しは `fetch`（依存なし。R10）。外部のツール: `/usr/bin/fm`（macOS 標準。なければ端末内の段を飛ばす）

**Storage**: tenant に 10 表（data-model §1）。マイグレーション `0007_statements.sql`（STRICT に置き換え）と `0008_statements_integrity.sql`（`--custom`。トリガー・部分 UNIQUE・`journals.source` のトリガーの作り直し）。registry に `ai_settings`（`0003_ai_settings.sql`。バックアップから除外）。API キーはキーチェーン

**Testing**: Vitest ＋ fast-check（INV-40〜47。`fc.assert(fc.property(...))` を直接）、一時のデータ場所での db のテスト（トリガー・部分 UNIQUE・障害の注入）、Hono の `app.request()`（偽の AI の `fetch`、偽の取得器）、Testing Library ＋ jsdom、Playwright の E2E（貼り付け → 承認 → 取消の1本。利用者の端末）。`fm`・外部の AI・MF ME は CI で呼ばない

**Target Platform**: macOS（Apple Silicon）上のローカル Web アプリ（`http://localhost:5173`）。`fm` は Apple Intelligence の有効な Mac だけ

**Project Type**: Web アプリケーション（pnpm monorepo の既存のパッケージに追加）

**Performance Goals**: 500 件の貼り付けから候補の一覧まで 5 秒以内（AI を除く。SC-006）。AI は明細 1 件ずつ、10 件ごとの要求で進捗を出す（R8）

**Constraints**: 金額は整数。承認前の候補は帳簿に影響しない（INV-41）。取込と承認は全部か無か（INV-47）。外部へ送る内容は許可した項目だけでマスク（INV-45）。MF ME のパスワード・クッキーを保存しない（FR-009）。API キーを平文で置かない（FR-027a）。実データを読まない・書かない（§3 の確認は利用者が行い、値を残さない）

**Scale/Scope**: 明細 約 100 件/月（口座・カード 5〜10）、ルール 数百、事業体は数個

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | ✅ | 仕訳はすべて 001 の `createJournal` を通る（貸借の一致、締め済みの年度は不可）。仕訳の形は R5 の表の純関数で、明細の口座の行の金額 = 明細の金額（INV-42）。明細・結びつきは物理削除しない（トリガー）。既存の仕訳との照合で二重計上を防ぐ（R7、INV-43） |
| II. 監査可能性 | ✅ | 取込・除外・結びつき・ルール・口座の対応の変更を `statement_audit_log`（追記のみ）に、ルールの変更を `inference_rule_history` に残す（R18）。明細 ⇔ 仕訳を相互にたどれる（契約 §4） |
| III. ローカルファーストとプライバシー | ✅ | 明細は tenant の DB。外部の AI は利用者が有効にした場合だけ、確信度の低い明細だけを、許可した項目とマスクで送る（R10・R11、INV-45）。API キーはキーチェーン、接続の設定は端末の表でバックアップに含めない（R12）。MF ME の認証情報を保存しない（R13） |
| IV. AIは提案、確定は人 | ✅ | AI の出力は候補で、承認まで帳簿に入らない（INV-41）。Zod で検証し、確信度と根拠を持つ（INV-46）。呼び出しは `SuggestionProvider` のポートで抽象化し、順序はルール → 端末内（`fm`）→ 外部（R8・R10）。評価（Evals）は時点で分けた一致率を保存して比べる（R17） |
| V. テストファースト | ✅ | 純関数（読み取り、キー、仕訳の形、照合、ルール、マスク、検証、状態）と INV-40〜47 を先に書く。取込は合成の貼り付けのフィクスチャで、件数・金額の照合までテストする（R19） |
| VI. 税制ルールはデータ | ✅ | 税区分は既存のコード（`TaxCategoryCode`）だけを使い、税額は 001 の `computeInclusiveTax`。新しい税制の値は足さない |
| VII. シンプルさと境界 | ✅（依存 1 つ） | `playwright` を足す（下の Complexity Tracking）。AI は `fetch` で、SDK を足さない。判定は domain の純関数、外部とのやりとり（AI・ブラウザ・子プロセス）は server。ルールは完全一致だけ（R9）。状態は導出（R15） |

**Post-design re-check（Phase 1 後）**: ✅ 違反なし。001 への変更は `JOURNAL_SOURCES` に値を1つ足すことと、仕訳の詳細の出力に結びつく明細を足すことだけ（R16、契約 §4）。

## Project Structure

### Documentation (this feature)

```text
specs/006-mfme-ai-journal/
├── plan.md              # 本ファイル
├── research.md          # Phase 0（R1〜R20）
├── data-model.md        # Phase 1（tenant の10表、registry の1表、トリガー、状態遷移、INV-40〜47、関数とポートの名前）
├── quickstart.md        # Phase 1
├── contracts/
│   └── http-api.md      # §1 エラーコード13種、§2〜§7 のエンドポイント
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks で作成
```

### Source Code (repository root)

```text
packages/
├── schema/src/
│   ├── statements.ts              # StatementAccount, StatementImportPreview, StatementView, Candidate, InferenceRuleView, EvalRun など（契約 §2〜§6）
│   ├── ai.ts                      # AiSuggestion、AiSettings（契約 §7、R10）
│   ├── journals.ts                # JOURNAL_SOURCES に statement（R16）
│   └── errors.ts                  # エラーコード13種（契約 §1）
├── domain/src/
│   ├── statements/                # paste.ts, keys.ts, normalize.ts, plan.ts, journal-shape.ts, transfer.ts, match-existing.ts, rules.ts, mask.ts, prompt.ts, evals.ts, status.ts（data-model §6）
│   ├── usecases/statements.ts     # 口座・取込・候補（match/transfer/rule）・承認・除外・ルール
│   ├── usecases/inference.ts      # inferWithAi（端末内 → 外部）、runEvaluation
│   └── ports.ts                   # StatementStore, StatementUnitOfWork, SuggestionProvider
├── domain/test/
│   ├── statements/*.test.ts, statements-*.property.test.ts
│   ├── statements-arbitraries.ts
│   ├── fixtures/mfme/             # paste-*.txt（合成）, README.md
│   └── fakes/statements.ts        # FakeStatementUnitOfWork, FakeSuggestionProvider
├── db/
│   ├── src/schema/tenant.ts, registry.ts
│   ├── src/statement-repository.ts, ai-settings-repository.ts
│   ├── src/backup/snapshot.ts     # EXCLUDED_REGISTRY_TABLES に ai_settings
│   ├── drizzle/tenant/0007_statements.sql, 0008_statements_integrity.sql
│   ├── drizzle/registry/0003_ai_settings.sql
│   └── test/statement-*.test.ts
apps/
├── server/src/
│   ├── routes/statements.ts       # statementRoutes({ clock })（契約 §2〜§6）
│   ├── routes/ai-settings.ts      # 契約 §7
│   ├── routes/journals.ts         # 仕訳の詳細に結びつく明細
│   ├── lib/ai-client.ts           # OpenAI 互換の SuggestionProvider（端末内・外部）
│   ├── lib/fm-server.ts           # fm models・fm serve の起動と停止
│   ├── lib/mfme/fetcher.ts, dom.ts  # Playwright（R13）
│   ├── lib/jobs.ts                # 取得・評価のジョブ（in-memory、同時に1つ）
│   ├── lib/startup.ts             # 終了時に fm serve とブラウザを止める
│   ├── deps.ts, errors.ts
│   └── test/fixtures/mfme/*.html  # 合成の DOM
└── web/src/
    ├── features/statements/       # PasteImport, ImportPreview, AccountMappingForm, StatementList, CandidateEditor, BulkApprove, RuleList, EvalRuns, MfmeFetch, api.ts
    ├── features/ai-settings/      # AiSettingsForm, api.ts
    └── routes/e/$entityId/statements/{index,import,rules,evals}.tsx, routes/settings/ai.tsx
apps/web/e2e/statements.spec.ts    # 貼り付け → 承認 → 取消
```

**Structure Decision**: 依存の向き（`apps/server → packages/db → packages/domain → packages/schema`、`apps/web → packages/schema`）を変えない。判定と計算は domain の純関数、トランザクションは db の `StatementUnitOfWork`（005 の `InvoicingUnitOfWork` と同じ形）、AI・ブラウザ・子プロセス・ジョブは server に置く。domain は AI を `SuggestionProvider` のポートとして受け取る。

## Phase の進め方（tasks への入力）

1. **Setup**: `playwright` を `apps/server` に足す（承認済み）。Chromium の導入手順を quickstart に
2. **Foundational**: Zod スキーマとエラーコード13種、`JOURNAL_SOURCES` に `statement`、tenant の 0007（10表、STRICT）と 0008（トリガー）、registry の 0003、ポートと偽物の UnitOfWork、`normalizeContent`・`stableKey`・`statementStatus`（INV-44）
3. **US1**（貼り付けの読み取り、口座の対応、プレビュー、確定。INV-40・47）→ **US2**（仕訳の形、振替、既存の照合、候補の一覧、承認・修正・分割・除外・まとめて承認、取消で戻る。INV-41・42・43）→ **US3**（ルールの学習・初期作成・編集。確信度）→ **US4**（ジョブ、Playwright の取得器、DOM は合成の HTML。実画面の解析は後）→ **US5**（マスク、プロンプト、出力の検証、`fm serve`、外部、設定と API キー、評価。INV-45・46）
4. 各ストーリーで「性質／ユニットテスト → domain → db → server → web」の順
5. **Polish**: E2E（貼り付け → 承認 → 取消）、AGENTS.md に「明細の取込と AI 仕訳（006）」の表、ADR 0009（AI による仕訳の推定）、`docs/requirements.md` の FR-06・FR-07・NFR-07 の状態、quickstart §3 の実環境の確認（利用者の端末）、最終の全体検証

## 決定事項（2026-10-25）

- MF ME 無料版は CSV を書き出せないため、代わりの取込は画面の表の貼り付け（spec Clarifications）
- 端末内の AI（`fm`）は呼べるときに呼ぶ。外部の AI は OpenAI 互換の呼び出し。`fm serve` も同じ形なので、呼び出しの実装は1つ（R10）
- `playwright` を server の実行時の依存に足す（利用者が承認）。MF ME の DOM の解析は後で行い、セレクターは `dom.ts` の1か所に置く（R13）
- 既存の仕訳（定期仕訳・請求の入金・手入力）と照合して結びつける（spec FR-021a。R7）

## Complexity Tracking

| 違反 | 必要な理由 | より単純な案を退けた理由 |
|---|---|---|
| 依存の追加（`playwright`、実行時） | US4 で MF ME の画面をブラウザで操作し、利用者が手で2段階認証をする | 貼り付け（US1）だけでは毎月口座ごとの手間が残る。`fetch` だけでは2段階認証とスクリプトで描く画面を扱えない。web の devDependency の `@playwright/test` はテスト用で、server の実行時に使えない |
