# freee の取込（002）

仕様: `specs/002-freee-import/`。決算振替の扱い: [ADR 0004](../adr/0004-freee-closing-entries.md)。

| 層 | 場所 |
|---|---|
| CSV の解析、freee 形式の読み取り、対応表、決算振替の判定、期首残高の案、照合、取込の計画 | `packages/domain/src/import/`（`csv.ts`、`freee/` の `columns.ts`、`read.ts`、`mapping.ts`、`closing.ts`、`opening.ts`、`reconcile.ts`、`plan.ts`） |
| ユースケース | `packages/domain/src/usecases/import-freee.ts` |
| 永続化（取込のトランザクション、取消） | `packages/db/src/import-repository.ts` |
| HTTP | `apps/server/src/routes/imports.ts` |
| 画面 | `apps/web/src/features/imports/`、`apps/web/src/routes/e/$entityId/imports/` |

- **実データ（`work/`）を読むのは `scripts/verify-freee-import.ts`（`pnpm verify:freee`）と `scripts/verify-tax-return.ts`（`pnpm verify:tax-return`）だけ**。共通部分は `scripts/lib/freee-import-runner.ts`。出力・実データの数値の扱いは AGENTS.md の「実データ」（正本）のとおり。
- **テストのフィクスチャは合成の CSV**（`packages/domain/test/fixtures/freee/`。作り方と匿名化の方針は同じ場所の `README.md`）。生成スクリプトはリポジトリに置かない（使い捨て）。手で直す場合は全項目をクォートし、LF で終える。元帳は UTF-8 の元（`ledger-2025.utf8.csv`）から CP932 の `ledger-2025.csv` を `iconv` で作る。変えたら README の「検算」をして `expected.ts` を直す。
- 取込のプロパティテスト（INV-14, 16, 17）は `packages/domain/test/freee-arbitraries.ts` のジェネレーターで、貸借一致の仕訳から freee 形式の仕訳帳と元帳を作って検証する。
- 年初付の決算振替は仕訳として取り込まず、期首残高に繰り込む（ADR 0004）。

