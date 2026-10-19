# Implementation Plan: freee からのデータ取込

**Branch**: `002-freee-import` | **Date**: 2026-10-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-freee-import/spec.md`

## Summary

freee の仕訳帳と総勘定元帳の書き出しファイル（CSV）を読み、001 の帳簿に仕訳と期首残高を移す。取込は「プレビュー → 対応表の確定 → 1トランザクションでの登録」の順に進み、freee の仕訳ID で二重登録を防ぐ。年初付の前年分の決算振替は仕訳としては取り込まず、期首残高の案と照合の側で繰り込む（research R5）。解析・組み立て・照合はドメイン層の純関数とし、匿名化したフィクスチャとプロパティテストで「取込 → 元帳との照合がすべて一致」を検証する。実データでの決算書との一致（SC-004、001 の SC-008）は、ローカル専用のスクリプトで確かめる。

## Technical Context

**Language/Version**: TypeScript 7.0（`strict: true`, ESM）、Node.js 26.9（001 と同じ）

**Primary Dependencies**: 001 と同じ。追加の依存はない（CSV の解析は自作、文字コードは標準の `TextDecoder`、ハッシュは `node:crypto`。research R1, R2, R11）

**Storage**: 事業体ごとの SQLite に4テーブルを追加（`import_batches`、`import_journal_refs`、`import_account_mappings`、`import_tax_mappings`）。マイグレーション `0002_import`（data-model.md）

**Testing**: Vitest ＋ fast-check（解析・組み立て・照合のプロパティテスト）、テンポラリの SQLite での統合テスト（全部か無か、二重登録、取消）、Hono の `app.request()`、Testing Library ＋ jsdom、Playwright（E2E 1本）

**Target Platform**: macOS（Apple Silicon）上のローカル Web アプリ（001 と同じ）

**Project Type**: Web アプリケーション（001 の pnpm monorepo に追加）

**Performance Goals**: 1年分（約500仕訳）のプレビューが5秒以内、確定が10秒以内（SC-002）

**Constraints**: ファイルは 5 MB まで。ファイル本体は保存しない（ハッシュと名前だけ）。実データとその金額をリポジトリ（コード・フィクスチャ・文書）に含めない。001 の会計期間・期首残高・監査ログの規則を変えない

**Scale/Scope**: 1回の取込は数百〜千数百仕訳、年に数回〜月1回。画面は4つ＋期首残高の画面への追加

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | ✅ | 金額は整数のみ（小数・マイナスは取込不可）。取り込む仕訳は必ず 001 の `validateJournal` を通す（INV-13）。物理削除はせず、取込の取消は仕訳の取消（INV-15）。帳票は仕訳から導出し、照合も都度計算。INV-11〜17 をプロパティテスト・統合テストの対象とする |
| II. 監査可能性 | ✅ | 取り込んだ仕訳ごとに監査ログ（`create`、出所・取込の回・freee の仕訳ID）、取消は理由つきの `void`（R12）。取込の回にファイルのハッシュ・名前・日時・件数を残す（FR-018）。取込の記録と参照は物理削除をトリガーで禁止 |
| III. ローカルファースト | ✅ | ファイルはブラウザから 127.0.0.1 のサーバーへ送るだけで、外部に送らない。事業体ごとの DB に保存。実データでの照合はローカル専用のスクリプトで、出力をコミットしない（R18） |
| IV. AIは提案 | N/A | AI は使わない。対応表の初期案は規則による提案で、利用者が確定するまで取り込めない（FR-009） |
| V. テストファースト | ✅ | tasks でテストを先に置く。匿名化した合成のフィクスチャ（仕訳帳・元帳）で、元帳との突合まで自動テストする（R17）。`work/` はフィクスチャにしない |
| VI. 税制ルールはデータ | ✅ | 税額は 001 の `tax_rates` と INV-10 で計算し直す（R14）。freee の税区分名の対応は対応表（データ）で持つ |
| VII. シンプルさと境界 | ✅ | 解析・組み立て・照合はドメイン層の純関数（`TextDecoder` 以外の I/O なし）。依存を追加しない。プレビューは状態を持たない（R11）。期首残高の保存は 001 の API を再利用（R6）。新しいポートは、2つのリポジトリを1トランザクションにまとめる `ImportUnitOfWork` だけ（R10） |

**Post-design re-check（Phase 1 後）**: ✅ 違反なし。Complexity Tracking は空。

## Project Structure

### Documentation (this feature)

```text
specs/002-freee-import/
├── plan.md              # 本ファイル
├── research.md          # Phase 0（R1〜R20）
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── http-api.md      # 追加する API
│   └── domain-module.md # 追加する関数・ユースケース・ポート
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks で作成
```

### Source Code (repository root)

001 の構成に、次を追加・変更する。

```text
packages/
├── schema/src/
│   └── import.ts                  # ImportOptions, ImportPreview, AccountMapping, OpeningProposal, ReconciliationRow など
├── domain/
│   ├── src/
│   │   ├── import/
│   │   │   ├── csv.ts             # decodeText, parseCsv
│   │   │   └── freee/
│   │   │       ├── columns.ts     # 使う列名の定数（R3）
│   │   │       ├── read.ts        # readFreeeFile, groupFreeeJournals, parseFreeeLedger
│   │   │       ├── closing.ts     # isPriorYearClosing（R5）
│   │   │       ├── mapping.ts     # proposeMappings（R13）
│   │   │       ├── plan.ts        # planImport, canonicalSnapshot
│   │   │       ├── opening.ts     # proposeOpeningBalances
│   │   │       └── reconcile.ts   # reconcile
│   │   ├── carry-forward.ts       # carryForward（R6, 決算処理でも再利用）
│   │   ├── seed/freee-aliases.ts  # 科目・税区分の初期案
│   │   ├── ports.ts               # ImportStore, ImportUnitOfWork を追加
│   │   └── usecases/import-freee.ts
│   └── test/
│       ├── fixtures/freee/        # 匿名化した合成のフィクスチャ（README に CP932 への変換手順）
│       ├── freee-arbitraries.ts   # 仕訳の列から freee 形式の仕訳帳・元帳を生成
│       └── import-*.test.ts / *.property.test.ts
└── db/
    ├── src/
    │   ├── schema/tenant.ts       # 4テーブル、journals.source の列挙
    │   └── import-repository.ts   # ImportStore と ImportUnitOfWork の実装
    ├── drizzle/tenant/0002_import.sql  # 生成 ＋ STRICT ＋ 削除禁止のトリガー
    └── test/import-*.test.ts

apps/
├── server/src/routes/imports.ts   # preview, commit, 履歴, 取消, 対応表, 期首残高の案, 照合
└── web/src/
    ├── routes/e/$entityId/imports/{index,new,$batchId,reconcile}.tsx
    ├── routes/e/$entityId/periods/$year/opening-balances.tsx   # 「freee の元帳から読み込む」を追加
    └── features/imports/          # PreviewTable, MappingEditor, ReconcileTable など

scripts/
├── verify-freee-import.ts         # 実データでの照合（ローカル専用, R18）
└── bench-import.ts                # SC-002 の計測
```

**Structure Decision**: 001 の monorepo と依存の向き（`apps/server → packages/db → packages/domain → packages/schema`、`apps/web → packages/schema`）を変えない。取込のロジックは `packages/domain/src/import/` に置き、Biome の `noRestrictedImports`（domain での hono・react・drizzle・better-sqlite3・node:fs・node:sqlite の禁止）をそのまま適用する。ハッシュの計算（`node:crypto`）はサーバーで行う。

## Phase の進め方（tasks への入力）

1. **Setup**: ローカル専用の確認スクリプトの骨組みで、実ファイルのヘッダと列名の定数を照合する（R3 のゲート。結果はコミットしない）。匿名化したフィクスチャの作成（R17）
2. **Foundational**: CSV と文字コード（INV-17）、`readFreeeFile`、Zod スキーマ、マイグレーション `0002_import`、`ImportStore`・`ImportUnitOfWork`、freee 形式の arbitraries
3. **US1**（仕訳の取込: 組み立て → 対応表 → 判定 → 確定）→ **US2**（期首残高の案）→ **US3**（照合）→ **US4**（取消）→ **US5**（差分の取込と変更・削除の警告）
4. 各ユーザーストーリーで「プロパティ／ユニットテスト → ドメイン → リポジトリ → API → 画面」の順
5. **Polish**: E2E、`bench:import`（SC-002）、AGENTS.md・README の更新、quickstart の手動確認、実データでの照合（SC-003・SC-004、ローカル専用）

## Complexity Tracking

違反なし。
