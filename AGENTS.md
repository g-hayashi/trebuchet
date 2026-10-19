# AGENTS.md

このリポジトリで作業するエージェント（および人間の開発者）向けの手順と規約。
個人事業主向けの会計アプリ（ローカル専用、Mac）。pnpm モノレポ。

## 構成と依存の向き

```
apps/web ──────────────→ packages/schema
apps/server ──→ packages/db ──→ packages/domain ──→ packages/schema
apps/server ──→ packages/domain
apps/server ──→ packages/schema
```

| パッケージ | 役割 | 制約 |
|---|---|---|
| `packages/schema` | Zod スキーマ（API と入力の形）、共有の定数 | 他のパッケージに依存しない |
| `packages/domain` | 業務ルール（仕訳の検証、締め、帳票、ユースケース） | **純粋関数のみ**。`node:fs` / `node:sqlite`、DB、Hono、React を import しない。Biome の `noRestrictedImports` で機械的に止める |
| `packages/db` | SQLite（better-sqlite3 + Drizzle）、マイグレーション、リポジトリ実装 | DB へのアクセスはここに閉じる |
| `apps/server` | Hono の API サーバー（`127.0.0.1:8787`） | HTTP の入出力と DI の組み立て。業務ルールは書かない |
| `apps/web` | React + Vite の画面（`127.0.0.1:5173`、`/api` は 8787 へ proxy） | 業務ルールを持たない。`@trebuchet/schema` に依存する |

- `packages/domain` の禁止は Biome が止めるのは次の import だけ: `hono`、`react`、`drizzle-orm`、`better-sqlite3`、`node:fs`、`node:sqlite`。`node:` の他のモジュールや `zod` の直接 import は Biome では止まらない。レビューで確認する。
- `packages/domain` は `@trebuchet/schema` に依存する。`schema` は Zod に依存する。
- `apps/web` は `@trebuchet/server` を devDependency に持つ。`hc<AppType>` のために型だけを import する（`import type`）。実行時のコードは参照しない。

## コマンド

| 目的 | コマンド |
|---|---|
| 開発サーバー（server 8787 と web 5173） | `pnpm dev` |
| 全テスト（Vitest の全プロジェクト） | `pnpm test` |
| 1 プロジェクトのテスト | `pnpm vitest run --project <domain\|db\|server\|web\|schema>` |
| 型チェック（全パッケージ + scripts） | `pnpm typecheck` |
| Lint（Biome） | `pnpm lint` |
| 整形（Biome で書き換え） | `pnpm format` |
| 性能計測（SC-004 の仕訳 2,000 件） | `pnpm bench:reports` |
| E2E（Playwright、Chromium） | `pnpm --filter @trebuchet/web e2e` |
| web のビルド（`routeTree.gen.ts` を再生成する） | `pnpm --filter @trebuchet/web build` |

- CI（`.github/workflows/ci.yml`）は `pnpm typecheck`、`pnpm lint`、`pnpm test` を実行する。E2E と bench は CI に含まれない。
- 変更を終える前に、少なくとも `pnpm typecheck`、`pnpm lint`、`pnpm test` を通す。

## 開発の進め方

- **テストを先に書く（TDD）**（Constitution V）。失敗するテストを確認してから実装する。
- **不変条件（INV-1〜INV-10）**は `specs/001-ledger-core/data-model.md` §4 にある。対応するテストは fast-check の性質テストで書く。`fc.assert(fc.property(...))` を直接呼ぶ（`@fast-check/vitest` は使わない。research R6）。
- **web のテストはコンポーネントテスト**（Testing Library + jsdom）。テストのためだけに node 専用のロジックを別ファイルに切り出さない。
- **Node 26 の型の除去で直接実行する**（`tsx` は使わない）。次を守る:
  - 相対 import は `.ts` を付ける（`allowImportingTsExtensions`）
  - `enum`、パラメーター・プロパティ、`namespace` を使わない（`erasableSyntaxOnly`）
  - 型だけの import は `import type` と書く（`verbatimModuleSyntax`）
- **マイグレーションの再生成**: `drizzle-kit generate` は `STRICT` を出力しない。生成後、`0000_init.sql` の `);` を `) STRICT;` に置き換える（research R2 / T024）。再生成のたびに同じ置き換えが必要。`tenant-store` のテストが `STRICT` を確認する。
- **トリガー・ビュー**は `drizzle-kit generate --custom` で手書きの SQL として追加する（research R2）。

## データと一時ファイル

- **実データを読まない、コミットしない**。`work/` と `data/` は実データを含む。中身を開く・要約する・テストの入力にする・コミットすることをしない。`.gitignore` で除外済み。
- 既定のデータ位置はリポジトリ直下の `data/`。`TREBUCHET_DATA_DIR` で変更できる。テストでは実データに触れないよう、一時のデータ場所を使う。
- **一時ファイルは `.tmp/` の下だけに作る**（`/tmp` や `os.tmpdir()` は使わない）。`packages/db/src/testing.ts` の `useTempDataDir` を使う。E2E と bench も `.tmp/` を使う。

## 仕様と文書

- Spec Kit の成果物は `specs/<feature>/`（現在は `specs/001-ledger-core/`）に置く: `spec.md`、`plan.md`、`research.md`、`data-model.md`、`quickstart.md`、`tasks.md`。
- Spec Kit のテンプレート、スクリプト、憲法（`.specify/memory/constitution.md`）は `.specify/` に置く。
- 設計判断は `docs/adr/` に ADR として書く（`NNNN-短い名前.md`、番号は連番）。書式は `docs/adr/0001-sqlite-driver.md` に合わせる。
- AGENTS.md は憲法と矛盾させない。
- コミットメッセージは Conventional Commits に従う。

## 参照

- 仕様: `specs/001-ledger-core/spec.md`
- 設計: `specs/001-ledger-core/plan.md`、`data-model.md`、`research.md`
- 手順: `specs/001-ledger-core/quickstart.md`
- 憲法: `.specify/memory/constitution.md`
- ADR: `docs/adr/`
