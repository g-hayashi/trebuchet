# 汎用の明細取込（007）

仕様: `specs/007-generic-statement-import/`。列の対応の保存と当てはめ、AI を列の案だけに使う理由: [ADR 0010](../adr/0010-generic-statement-import.md)。006 の取込（MF ME の貼り付けに決め打ち）を、取込元を問わない読み取りに置き換えた。読み取りの後（候補・承認・ルール・評価）は 006 のまま。

| 層 | 場所 |
|---|---|
| 入出力の型（列の役割・対応、layout、取込元、口座の案、AI の列の案 `AiColumnSuggestion`） | `packages/schema/src/statements.ts`、`ai.ts` |
| 業務ルール（区切り文字と見出しの行の判定・値の読み取り、見出しの辞書と列の案、取込元の照合、口座の推定、列の案のプロンプトと出力の検証） | `packages/domain/src/statements/`（`table.ts`、`columns.ts`、`sources.ts`、`account-inference.ts`、`column-prompt.ts`）、区切りつきの分割は `packages/domain/src/import/csv.ts` の `parseDelimited` |
| ユースケース | `packages/domain/src/usecases/statements.ts`、`statement-sources.ts`、`statement-columns.ts`（`suggestStatementColumns`、`evaluateColumnSuggestions`） |
| 永続化（取込元 `statement_sources`、取込の確定と同じ UnitOfWork での保存） | `packages/db/src/statement-repository.ts` |
| HTTP | `apps/server/src/routes/statements.ts`（`/statements/imports/layout`・`column-suggestion`・`preview`・commit、`/statement-sources`）、受け取りは `apps/server/src/lib/upload.ts`・`statement-input.ts` |
| 端末内の AI の列の案 | `apps/server/src/lib/ai-client.ts`（`createColumnProvider`、`COLUMN_TIMEOUT_MS`） |
| 画面 | `apps/web/src/features/statements/`（`StatementInput.tsx`、`ColumnMappingEditor.tsx`、`ColumnSuggestionNote.tsx`、`SourcePicker.tsx`、`SourceList.tsx`、`AccountMappingForm.tsx`、`ImportWorkspace.tsx`）、`apps/web/src/routes/e/$entityId/statements/import.tsx` |
| フィクスチャ・評価・性能 | `packages/domain/test/fixtures/statements/`（`README.md`、`expected.ts`、`column-evals.ts`）、`scripts/eval-column-suggestions.ts`、`scripts/bench-statements.ts` |

- **値（日付・金額・内容）の読み取りはプログラムだけ**（FR-006、INV-49）。AI の出力から値を作らない。読み取りは利用者が確かめた列の対応（`readStatementTable`）だけに基づく。金額 1 列の符号の向き（`amountSign`）は自動で決めず利用者が選ぶ。
- **列の案の AI は端末内だけ**（FR-018、INV-48）。`createColumnProvider` に渡すのは端末内の endpoint だけで、外部の endpoint を受け取る口を持たない。外部の AI の設定にかかわらず外部へ送らず、006 の `createAiSuggester` も通さない。渡すのは見出しと先頭の明細の行 `COLUMN_PROMPT_ROWS`（5）件だけ（`buildColumnPrompt`）で、前置きの行（口座番号など）は渡さず保存もしない。AI を呼ぶのは、辞書の案で必須の役割がそろわず、保存した対応も当てはまらないときだけ。出力は `AiColumnSuggestion`（Zod）で検証し、外れたら案なし。通った案は、見本の行の値で確かめてから返す（日付・金額に合わない役割は捨て、案のない日付・金額・内容は中身から推定。`column-content.ts`、`suggestStatementColumns`。007/R16）。AI を使えない・失敗したときも、辞書にない役割だけの推定を案（`confidence` 0、`unavailable` つき）として返し、画面は「列の中身から推定した案」と示す。
- **貼り付けの表のセル内の改行**（007/R16）。ブラウザの表のコピーは、セルの中の改行が引用符なしの改行になる。タブ区切りでは `table.ts` の `foldCellNewlines` が、日付で始まる行を件としてまとめ（年だけの行は次の日付の行に足す）、見出しの物理行も 1 行にする。`detectTableLayout` と `readStatementTable` は同じまとめを通す（行の番号は件の最初の物理行）。カードの金額の見出し「ご利用額」などは符号の案が出金が正（`suggestedAmountSign`。利用者が変えられる）。
- **見出しの辞書と口座の語の表は 1 か所の一覧**。新しい銀行・カードの見出しは `columns.ts` の `COLUMN_ROLE_NAMES`、口座の種類・用途を決める語は `account-inference.ts` の `ACCOUNT_CUES`・`USAGE_CUES` にだけ足す（比べるときは NFKC。辞書は完全一致、語の表は部分一致）。足したら同じ値を使うテストと `fixtures/statements/` の README を合わせる。
- **取込元の保存は取込の確定と同じ `StatementUnitOfWork`**（INV-47）。確定しなければ保存しない。`fixed_account_name` が NULL ⇔ 対応が `accountName` の役割を持つ（INV-50）。見出しの署名が 1 件だけ一致すれば次回から列の選択を飛ばす。見出しが変われば自動では当てはめない（007/R8）。
- **フィクスチャは合成**（`packages/domain/test/fixtures/statements/`。作り方・匿名化・検算は同じ場所の `README.md`）。実データから写してよいのは列名と書式だけ。銀行の CSV は UTF-8 の元（`bank-two-columns.utf8.csv`）から CP932 の `bank-two-columns.csv` を `iconv` で作る。変えたら README の「検算」をして `expected.ts` を直す。
- **プロンプト・`COLUMN_PROMPT_ROWS`・`COLUMN_TIMEOUT_MS` を変えるときは、変更の前と後で `pnpm eval:columns` を実行して結果を比べる**（Constitution IV、007/R15）。`fm` を呼ぶので CI に含まれない。結果は `.tmp/eval-columns/` に件数と割合だけを残し、見出し・値を書かない。CI のテストは偽の `ColumnSuggestionProvider` で集計だけを確かめる。
- **互換の別名を残さない**（007/R13）。`PastedRow`・`MfmePaste`・`parseMfmePaste`・`MFME_COLUMNS`・`mfme_fetch`・`STATEMENT_PASTE_UNREADABLE` は消した。入力は貼り付けもファイルも multipart の `file` と `options`。上限は 5 MB・20,000 行・50 列。

