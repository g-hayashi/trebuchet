# Implementation Plan: デモ事業の作成

**Branch**: `014-demo-entity` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/014-demo-entity/spec.md`

## Summary

事業体の一覧が空のときにボタンを出し、押すと架空のデータが入ったデモ事業を作る。domain のユースケース `createDemoEntity` が、作成日から決めた計画（`buildDemoPlan(today)`）に沿って既存のユースケースを順に呼ぶ（R1・R5）。registry に `preparing` の状態と `is_demo` の列を足し、投入中は一覧から隠し、失敗したら事業体ごと消して全部か無かにする（R2・R3）。画面は空の状態のボタン、骨組みの目印の帯、請求書の印刷の表示を足す（R8）。開発用の `pnpm demo:seed` は取り込まずに消す（R10）。

## Technical Context

**Language/Version**: TypeScript（strict、ESM）、Node.js 26.5.1 以上（型の除去で直接実行）

**Primary Dependencies**: 既存のみ（Hono、React + Vite + TanStack Router/Query、Drizzle + better-sqlite3-multiple-ciphers、Zod）。新しい依存は足さない

**Storage**: SQLite。registry の `entities` に列と状態を足す（data-model §1）。事業体ごとの tenant DB と証憑のファイルは既存のまま

**Testing**: Vitest（domain・db・server・web の各プロジェクト）、fast-check（INV-76・77）、Testing Library

**Target Platform**: macOS（Apple silicon）のローカル。server は `127.0.0.1:8787`

**Project Type**: pnpm モノレポの Web アプリ（apps/server、apps/web、packages/*）

**Performance Goals**: ボタンを押してからホームが開くまで 10 秒以内（SC-001）。試作では仕訳 49 件・証憑 3 件の投入が数秒で済んだ

**Constraints**: AI を呼ばない（R7）。全部か無か（R2）。日付は作成日以下（R5）。テストの素材を実行時に読まない（R4）

**Scale/Scope**: 仕訳 40 件程度、請求書 2、資産 3、開業費 1、定期仕訳 1、証憑 3、明細 10 行

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | 適合 | 仕訳は既存の `createJournal` などを通り、貸借一致の検査を受ける。金額は整数。INV-76 で計画の貸借一致を性質テストする |
| II. 監査可能性 | 適合 | 既存のユースケースが監査の記録を残す。訂正・取消も既存の経路 |
| III. ローカルファースト | 適合 | 外部へ送らない（R7）。事業体はファイルで分離したまま。失敗時は事業体ごと消す |
| IV. AI は提案 | 適合 | AI を呼ばない。明細は未処理で残し、候補は利用者が開いたときの既存の経路 |
| V. テストファースト | 適合 | INV-76・77 の性質テスト、ルート・画面のテストを先に書く |
| VI. 税制ルールはデータ | 適合 | 源泉徴収・償却は既存の税制の表を使う。デモの計画に税率を書かない |
| VII. シンプルさ | 適合（注記あり） | 新しい抽象は `DemoAssets` のポート 1 つ（domain が `node:fs` を使えないため）。registry の状態を 1 つ足すのは、全部か無かを補償で作るための最小の変更（R2） |

設計の後の再確認: data-model と contracts は上の判定を変えない。違反はなく、Complexity Tracking は空。

## Project Structure

### Documentation (this feature)

```text
specs/014-demo-entity/
├── plan.md
├── research.md          # R1〜R10
├── data-model.md        # registry の変更、計画の形、INV-76・77
├── quickstart.md
├── contracts/http-api.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks で作る
```

### Source Code (repository root)

```text
packages/domain/src/
├── demo/plan.ts                     # buildDemoPlan(today)（純関数、R4・R5）
├── usecases/demo-entity.ts          # createDemoEntity・cleanupPreparingEntities（R1・R2・R7）
├── usecases/create-entity.ts        # status・demo の入力を足す
├── types.ts / ports.ts              # EntitySummary.demo、EntityStatus、registry のポート、DemoAssets
packages/domain/test/demo/           # INV-76（plan）、INV-77（偽物のポートで失敗を注入）
packages/db/src/schema/registry.ts   # is_demo、status の preparing
packages/db/drizzle/registry/        # マイグレーション
packages/db/src/registry-repository.ts  # activateEntity、listPreparingEntities、demo の読み書き
packages/db/src/backup/snapshot.ts   # preparing を除く
apps/server/assets/demo/             # 合成の証憑の画像 3 枚（R4）
apps/server/src/demo-assets.ts       # DemoAssets の実装（画像を読む）
apps/server/src/routes/entities.ts   # POST /entities/demo、排他（R6）
apps/server/src/deps.ts              # createDemoEntity の deps の組み立て、起動時の後片づけ
apps/web/src/features/entities/      # api.ts（createDemoEntity）、EntityListPage の空の状態
apps/web/src/components/layout/      # DemoBanner（骨組みの帯）
apps/web/src/features/invoicing/InvoicePrint.tsx  # 印刷の表示
apps/web/src/features/manual/content.ts           # 記事の節（R9）
apps/web/test/mock-api.ts            # 既定の応答に demo: false
docs/features/014-demo-entity.md     # 置き場所と固有の規則。AGENTS.md の表に 1 行
specs/INVARIANTS.md                  # INV-76・77
```

**Structure Decision**: 既存のモノレポの層（schema → domain → db → server、web）に沿って足す。新しいパッケージは作らない。

## Complexity Tracking

違反なし。
