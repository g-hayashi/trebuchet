# 決算書（003）

仕様: `specs/003-tax-return/`。青色申告決算書（一般用、個人の事業体だけ）。按分・減価償却を仕訳で登録する理由: [ADR 0005](../adr/0005-closing-adjustments-as-journals.md)。定額法・一括償却資産・開業費は[009](009-depreciation-deferred.md)。

| 層 | 場所 |
|---|---|
| 決算書の組み立て（様式、按分、減価償却、控除の判定、月別売上と売上先、期首の貸借対照表の検査、CSV） | `packages/domain/src/blue-return/`（`form.ts`、`build.ts`、`home-use.ts`、`depreciation.ts`、`deduction.ts`、`sales.ts`、`balance-sheet.ts`、`opening-check.ts`、`tax-parameters.ts`、`csv.ts`） |
| ユースケース | `packages/domain/src/usecases/blue-return.ts` |
| 永続化（按分・資産・控除の回答の保存、決算整理の仕訳との結びつけ。申告の控え `tax_return_memos`・`filed_documents` は 011 で消した） | `packages/db/src/closing-repository.ts` |
| HTTP | `apps/server/src/routes/blue-return.ts`、`fixed-assets.ts` |
| 画面 | `apps/web/src/features/blue-return/`、`fixed-assets/`、`apps/web/src/routes/e/$entityId/` の `blue-return/`・`fixed-assets/` |

- **按分と減価償却（少額の特例のほか、009 の定額法・一括償却・開業費）は、決算整理の「仕訳」として登録する**。ドメインが案を作り、利用者が確かめて 001 の `createJournal` で登録する。決算書は帳簿の損益計算書・貸借対照表と一致する。
- **税制の値の足し方**（基準額、控除額など。Constitution VI）: 次の**両方**に、適用の期間つきの行を足す。出典の URL は必須（国税庁・財務省などの一次資料）。
  1. `packages/domain/src/seed/tax-parameters.ts`（正本）
  2. マイグレーション。`pnpm --filter @trebuchet/db exec drizzle-kit generate --custom --config drizzle.tenant.config.ts` で空の SQL を作り、`INSERT` を手で書く（既存の行は書き換えず、適用の終了日を足すか新しい行を足す）。`packages/db/test/closing-repository.test.ts`（`listTaxParameters`）が、seed とマイグレーションの値の一致を確かめる
  - 新しい `key` を足すときは、`tax_parameters` の CHECK 制約（`key IN (...)`）と型 `TaxParameter` の `key` も直す。
- 様式の値（欄番号、行の定義）は `packages/domain/src/blue-return/form.ts` に置き、国税庁の様式の原本と照らして確かめる（003/R2）。
- 性能は `pnpm bench:reports` が SC-006（約 500 仕訳で決算書の画面が使う API が 2 秒以内）も確かめる。
- 実データでの照合は `pnpm verify:tax-return`（`--closing` の JSON の形はスクリプトの先頭のコメント）。出力は欄の識別子と一致・不一致の件数だけで、金額・取引先名・按分率は出さない。

