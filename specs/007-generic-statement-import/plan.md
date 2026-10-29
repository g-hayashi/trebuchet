# Implementation Plan: 汎用の明細取込

**Branch**: `007-generic-statement-import` | **Date**: 2026-10-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/007-generic-statement-import/spec.md`

## Summary

006 の MF ME の表に決め打ちした読み取り（`paste.ts`）を、取込元を問わない読み取りに置き換える。貼り付けもファイルも multipart で受け、002 の `decodeText` で文字コードを決め（R1）、区切り文字と見出しの行を列数の最頻値と見出しの辞書で判定する（R2〜R4）。利用者が確かめた列の対応（各役割の列、金額の符号の向き）でプログラムが値を読み（R5・R6）、対応は取込元（1 つの口座、またはまとめ）ごとに `statement_sources` に保存し、見出しの署名が一致すれば次から自動で当てはめる（R7・R8）。新しい口座の種類・科目は語の表で推定し、確定のときに取込と同じ UnitOfWork で保存する（R9）。見出しで決まらない表だけ、端末内の AI に見出しと 5 行を渡して列の案を出させる（R10）。読み取りの後は 006 の流れをそのまま使い、`mfme_fetch` と MF ME 前提の名前を消す（R13）。

## Technical Context

**Language/Version**: TypeScript 7.0（`strict: true`, ESM）、Node.js 26.9（型の除去で直接実行）

**Primary Dependencies**: 既存の Hono、Drizzle ＋ better-sqlite3、Zod、React ＋ TanStack Router、Vitest ＋ fast-check。**追加なし**（CSV の分割と文字コードは 002 の `csv.ts`、AI の呼び出しは 006 の `ai-client.ts`・`fm-server.ts`）

**Storage**: tenant に `statement_sources` を足し、`statement_batches`・`statement_audit_log` を作り直す（`0009_statement_sources.sql`・`0010_statement_sources_integrity.sql`。data-model §2）。registry は変えない

**Testing**: Vitest ＋ fast-check（INV-48〜50。`fc.assert(fc.property(...))` を直接）、合成のフィクスチャ（`packages/domain/test/fixtures/statements/`、CP932 の CSV を含む）、db のテスト（作り直し後のトリガー・外部キー）、`app.request()` ＋ 偽の `fetch`（端末内の endpoint だけに行くこと）、Testing Library ＋ jsdom、E2E（利用者の端末）

**Target Platform**: macOS（Apple Silicon）上のローカル Web アプリ（`http://localhost:5173`）

**Project Type**: Web アプリケーション（pnpm monorepo の既存のパッケージを変更）

**Performance Goals**: 500 件の CSV で layout → preview が 5 秒以内（SC-006。`bench:statements` で測る）。列の案の AI は 20 秒で打ち切る

**Constraints**: 金額は整数で、値の読み取りはプログラムだけ（FR-006、INV-49）。列の案は端末内の AI だけに、見出しと 5 行だけを渡す（FR-017・018、INV-48）。取込の確定は全部か無か（INV-47）。上限 5 MB・20,000 行・50 列（R12）。実データを読まない

**Scale/Scope**: 取込元 5〜20、1 回の取込 数十〜数千行

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | ✅ | 値の読み取りは純関数で、生成した表から元の行を復元できることを性質テストで確かめる（INV-49）。符号の向きは利用者が選ぶ（R5）。仕訳の登録は 006 の承認（001 の `createJournal`）のまま |
| II. 監査可能性 | ✅ | 取込元の作成・変更・削除と、確定で保存した口座の対応を `statement_audit_log` に残す。取込の回は取込元の名前の写しを持つ（R7） |
| III. ローカルファーストとプライバシー | ✅ | 列の案は端末内の AI だけ。外部の endpoint を受け取る口を持たない（R10、INV-48）。前置きの行（口座番号など）は AI に渡さず保存もしない（R2）。明細の値は外部へ出ない |
| IV. AIは提案、確定は人 | ✅ | AI は列の役割の案だけで、`AiColumnSuggestion`（Zod）で検証し確信度と根拠を持つ。利用者が確かめるまで読み取りに進まない（FR-019）。口座の推定は規則で、確定まで保存しない（R9）。列の案にも評価を持たせる: 合成の見出しと正しい対応の例で一致率を測り、前回と比べる（`pnpm eval:columns`、R15）。プロンプト・行数・待ち時間の変更は前後の評価の比較を伴う。AI の候補（006）の評価は変えない。読み取りの正しさは INV-49 で保証する |
| V. テストファースト | ✅ | 読み取り・判定・辞書・推定・当てはめ・プロンプトの純関数と INV-48〜50 を先に書く。取込は合成のフィクスチャで件数・金額を照合する（R14） |
| VI. 税制ルールはデータ | ✅ | 税制の値を扱わない |
| VII. シンプルさと境界 | ✅ | 依存を足さない。判定と読み取りは domain、ファイルの受け取りと AI の呼び出しは server。取込元は 1 つの表で 2 種類を表す（R7）。辞書・語の表は 1 か所の一覧 |

**Post-design re-check（Phase 1 後）**: ✅ 違反なし。006 への変更は、取込の入力（multipart と対応）、preview の `unmappedAccounts` の形、commit の `accounts`・`saveSource`、`STATEMENT_ORIGINS` とエラーコードの名前（契約 §1・§2）。候補・承認・ルール・評価は変えない。

## Project Structure

### Documentation (this feature)

```text
specs/007-generic-statement-import/
├── plan.md              # 本ファイル
├── research.md          # Phase 0（R1〜R15）
├── data-model.md        # Phase 1（statement_sources、statement_batches の変更、型、関数、INV-48〜50）
├── quickstart.md        # Phase 1
├── contracts/
│   └── http-api.md      # §1 エラーコード、§2 取込、§3 取込元、§4 列の案
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
packages/schema/src/
├── statements.ts        # StatementColumnMapping・Role・Layout・Source・AccountSuggestion、STATEMENT_ORIGINS、取込の options
├── ai.ts                # AiColumnSuggestion
└── errors.ts            # STATEMENT_TABLE_UNREADABLE ほか（契約 §1）

packages/domain/src/
├── import/csv.ts        # parseDelimited（parseCsv の一般化）
├── statements/
│   ├── columns.ts       # 新規: 役割と見出しの辞書
│   ├── table.ts         # 新規: detectTableLayout・readStatementTable・金額と日付（paste.ts を置き換え）
│   ├── sources.ts       # 新規: 見出しの署名・当てはめ・違い
│   ├── account-inference.ts  # 新規: 口座の推定
│   ├── column-prompt.ts # 新規: 列の案のプロンプトと検証
│   ├── plan.ts          # PastedRow → StatementRow
│   └── paste.ts         # 削除
├── ports.ts             # ColumnSuggestionProvider、StatementStore の取込元
└── usecases/
    ├── statements.ts    # detectStatementLayout、preview・commit の入力
    ├── statement-sources.ts   # 新規: 一覧・名前の変更・削除
    └── statement-columns.ts   # 新規: suggestStatementColumns

packages/db/
├── src/schema/tenant.ts       # statement_sources、statement_batches.source_name・origin
├── src/statement-repository.ts
└── drizzle/tenant/0009_statement_sources.sql, 0010_statement_sources_integrity.sql

apps/server/src/
├── routes/statements.ts       # multipart の layout・preview・commit・column-suggestion、取込元
└── lib/ai-client.ts           # chatCompletion の切り出し、createColumnProvider

apps/web/src/
├── features/statements/
│   ├── api.ts                 # multipart の取込、取込元、列の案
│   ├── StatementInput.tsx     # PasteImport.tsx を置き換え（貼り付け・ファイル）
│   ├── ColumnMappingEditor.tsx  # 新規: 見本の表、役割の選択、符号の向き、区切り・見出しの選び直し、AI の案
│   ├── SourcePicker.tsx       # 新規: 取込元の選択・名前
│   ├── ImportWorkspace.tsx    # 段の流れ（入力 → 列 → 確認 → 確定）、口座の案
│   ├── AccountMappingForm.tsx # 案の受け取り
│   └── labels.ts
└── routes/e/$entityId/statements/   # import.tsx・index.tsx の文言、取込元の一覧（settings.tsx に足す）

scripts/bench-statements.ts    # CSV と multipart に直す
scripts/eval-column-suggestions.ts  # 新規: 列の案の評価（R15、`pnpm eval:columns`）
apps/web/e2e/statements.spec.ts  # CSV の取込と 2 回目の当てはめ
```

**Structure Decision**: 既存のパッケージの構成のまま。006 の `statements/` の下に読み取りの部品を足し、`paste.ts` を削除する。

## Complexity Tracking

なし。
