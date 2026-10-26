# Research: 汎用の明細取込

006 の番号は `006/R3` の形で指す。007 の番号は R1〜R14。

## R1. 入力の運び方（貼り付けとファイルを同じ道に）

- **Decision**: 貼り付けもファイルも、web から multipart の `file`（貼り付けは web が UTF-8 の Blob にする）と `options`（JSON 文字列）で送る。server は 002 の `readUpload`（`apps/server/src/lib/upload.ts`、上限 5 MB）でバイト列を受け、domain の `decodeText`（`packages/domain/src/import/csv.ts`。UTF-8 を厳密に読めなければ Shift_JIS＝CP932）で文字列にする。出所（`paste` / `file`）は `options.origin` で受ける。`options.encoding`（`utf-8` / `shift_jis`）があれば自動の判定を使わずその文字コードで読む（利用者の選び直し。FR-002。文字化けしたときに使う）
- **Rationale**: 読み取りの道が 1 本になり、文字コードの判定も 1 か所で済む。002 のファイルの受け取りと上限をそのまま使える。web は文字コードを判定しない（業務ルールを持たない）
- **Alternatives**: 貼り付けは JSON・ファイルは multipart の 2 本（読み取りの入口が 2 つになる）。web の `TextDecoder` で文字列にしてから送る（文字コードの判定が web に漏れる）

## R2. 区切り文字と見出しの行の判定

- **Decision**: `detectTableLayout(text)`（domain の純関数）。
  1. 区切り文字の候補はタブ・カンマ・セミコロン。候補ごとに引用つきで分割し（R3）、空でない先頭 50 行の列数の最頻値（2 以上）と、その列数の行の割合で採点する。同点はタブ → カンマ → セミコロンの順
  2. 見出しの行: 最頻値の列数を持つ先頭 30 行のうち、セルが列の役割の辞書（R4）に 1 つでも当たる最初の行。当たらなければ、すべてのセルが空でなく日付・金額として読めず、次の行に日付として読めるセルがある最初の行。どちらもなければ「見出しなし」（列の名前は「列 1」「列 2」…）
  3. 見出しより前の行は説明の行（前置き）とし、読まない・AI に渡さない・保存しない（FR-017）
- 利用者は区切り文字と見出しの行（行の番号、または「見出しなし」）を選び直せる。選び直したら判定の 2・3 だけをやり直す
- **Rationale**: 銀行の CSV は先頭に口座番号・期間の行を持つものが多い。列数の最頻値と辞書で、決め打ちなしに見出しを見つけられる
- **Alternatives**: 先頭の行を常に見出しとする（006。前置きのある CSV を読めない）。AI に判定させる（遅い。値を誤らせたくない）

## R3. 区切り文字つきの分割

- **Decision**: 002 の `parseCsv` を `parseDelimited(text, delimiter)` に一般化し、`parseCsv(text)` は `parseDelimited(text, ",")` として残す。引用（`"`）、`""`、引用の中の区切り・改行はどの区切り文字でも同じに扱う。行の番号（元のテキストの何行目か）を返す版 `parseDelimitedLines` を足し、「読めない行」の番号に使う
- **Rationale**: 002 の実装と性質テストを使い回せる。貼り付け（タブ）でも引用が来ることがある（表計算から写したとき）
- **Alternatives**: 区切りごとに別の解析器（重複）

## R4. 列の役割と見出しの辞書

- **Decision**: 役割は `date`・`content`・`amount`・`outflow`・`inflow`・`accountName`・`categoryMajor`・`categoryMinor`・`memo`・`externalId`・`transferFlag`。辞書 `COLUMN_ROLE_NAMES`（`packages/domain/src/statements/columns.ts`）に、役割ごとの見出しの名前を持つ。比べるときは NFKC・空白の除去・括弧書き（`（円）` など）の除去をした完全一致。例:
  - date: 日付, 利用日, ご利用日, 取引日, お取引日, 年月日, 取扱日, 計上日, Date
  - content: 内容, 摘要, 取引内容, お取引内容, 利用店名, ご利用店名, ご利用先, 利用先, 明細, Description
  - amount: 金額, 利用金額, ご利用金額, 支払金額, お支払金額, 取引金額, Amount
  - outflow: 出金, 出金額, お引出し, お引出金額, 支払, お支払, 引出額, Debit, Withdrawal
  - inflow: 入金, 入金額, お預入れ, お預入金額, お預り金額, 預入額, Credit, Deposit
  - accountName: 保有金融機関, 口座, 口座名, 金融機関, カード名
  - categoryMajor: 大項目 / categoryMinor: 中項目 / memo: メモ, 備考 / externalId: ID, 取引ID, 明細ID / transferFlag: 振替
- MF ME の見出し（日付・内容・金額（円）・保有金融機関・大項目・中項目・メモ・振替・ID）はすべて辞書に入れ、MF ME の表は列を選ばずに案がそろう
- 同じ役割に 2 列が当たれば、左の列だけを案にする。案は案であり、利用者が確かめて確定する（FR-004）
- 残高（「残高」「差引残高」）は役割に持たない（読まない）
- **Rationale**: 辞書は 1 か所の一覧なので、新しい銀行の見出しに出会ったらここだけを足せばよい（006/R2 の `MFME_COLUMNS` と同じ考え）
- **Alternatives**: 部分一致（「お支払金額」と「お支払」の取り違えが起きる）

## R5. 金額の読み方と符号の向き

- **Decision**:
  - 金額 1 列: 利用者が `amountSign` に `inflow_positive`（正が入金。MF ME・銀行の符号つき）か `outflow_positive`（正が出金。カードの利用明細）を選ぶ。自動では決めない（spec の Edge Cases）。保存した対応は覚える
  - 出金・入金の 2 列: どちらかに 0 でない値がある行だけを読む。出金の値 v は金額 −v、入金の値 v は金額 +v（出金の列の負の値は入金になる）。両方に 0 でない値 → 「出金と入金の両方に値があります」、両方が空か 0 → 「金額が空です」
  - 書き方: NFKC の後、`,`・`¥`・`円`・空白を除き、`−‐‑–—` を `-` にする。先頭の `△`・`▲` と全体の括弧 `(1,234)` は負。整数でなければ「金額を読めません」（小数を含む外貨など）。`|金額| >= 1e12` は「金額が大きすぎます」（006 と同じ）
- **Rationale**: 符号の向きは取込元ごとに違い、値からは決められない（返金の行があるため）。誤った向きで取り込むと全件の入出金が逆になるので、利用者に一度だけ選ばせる
- **Alternatives**: 見出しの名前（「ご利用金額」）から向きを推定する（同じ名前で向きの違う取込元がある）

## R6. 日付の読み方

- **Decision**: 行ごとに次の書き方を自動で読む: `YYYY/MM/DD`・`YYYY-MM-DD`・`YYYY.MM.DD`・`YYYY年M月D日`・`YYYYMMDD`・`MM/DD`（`(曜)` つき可）・和暦（`令和N年M月D日`・`R N.M.D`・`RN/M/D`、平成も同じ。`元年` を読む）。時刻（`2026/10/01 12:34`）は日付の部分だけを読む。年のない書き方は、取込のときに利用者が選ぶ年（既定は今年。006 と同じ）を使う。layout の判定で年のない日付が見つかったときだけ、画面に年の選択を出す（`needsYear`）
- 日付の書き方は保存しない（行ごとに読むので、対応に持つ必要がない）
- **Rationale**: 銀行（ゆうちょなど）の CSV に和暦がある。書き方の数は限られ、行ごとの判定で足りる。`DD/MM/YYYY` のような日本の取込元にない並びは読まない（`MM/DD` との取り違えを避ける）
- **Alternatives**: 書き方を利用者に選ばせる（手間が増える）

## R7. 取込元と列の対応の保存

- **Decision**: tenant に `statement_sources` を足す（data-model §1.1）。列の対応は `StatementColumnMapping`（Zod。区切り文字、見出しの有無、各役割の列の番号、`amountSign`）を JSON で持ち、見出しの署名（正規化した見出しのセルの配列）を別の列に持つ。取込元は 2 種類:
  - 1 つの口座の取込元: `fixed_account_name` に口座の名前（006 の `statement_accounts.name`）を持ち、対応は `accountName` の役割を持たない。読み取りでは全行の口座をこの名前にする
  - まとめの取込元: `fixed_account_name` が NULL で、対応は `accountName` の役割を持つ
- 保存は取込の確定（`commitStatementImport`）と同じ `StatementUnitOfWork` の中で行う（取込を確定しなければ保存しない）。取込の回に、使った取込元の名前の写し `source_name` を持たせる（取込の回は更新・削除をトリガーで止めているので、外部キーにしない）
- **Rationale**: 2 種類を 1 つの表で持ち、違いは `fixed_account_name` の有無だけにする。口座ごとの対応（spec の「取込元ごと」）と MF ME のようなまとめの両方を扱える（Clarifications）
- **Alternatives**: `statement_accounts` に対応の列を足す（まとめの取込元を表せない）

## R8. 保存した対応の当てはめ

- **Decision**: layout の判定の後、見出しの署名が一致する取込元を探す（`matchStatementSources`）。
  - 署名は、今回の判定（R2）で見つけた見出しの行で作る。当てはめるときの見出しの行は今回の判定の行で、保存した `headerRow` は使わない（前置きの行数は月ごとに変わりうる）。区切り文字・列の役割・符号の向きは保存した値を使う
  - 1 件: その対応を当てはめ、列の選択を飛ばして preview へ進める（SC-003）
  - 2 件以上（同じ会社の 2 枚のカードなど）: どれかを利用者が選ぶ（列は選ばない）
  - 0 件: 列の選択の画面。辞書（R4）で案を入れる
  - 利用者が取込元を手で選び、その署名が今の見出しと違えば、違い（足された列・なくなった列）を返し、見出しの名前が同じ列は前の役割を引き継いだ案にする（FR-011）
  - 見出しのない取込元は署名で探せないので、列数が同じ取込元を手で選んだときだけ当てはめる
- **Rationale**: 2 回目からは操作 0 回。見出しが変われば列の番号がずれるおそれがあるので、自動では当てはめない
- **Alternatives**: 列数だけで当てはめる（並べ替えに気づけない）

## R9. 口座の対応の推定

- **Decision**: `inferStatementAccount(name, categoryMajors, accounts)`（domain の純関数、`packages/domain/src/statements/account-inference.ts`）。語の表 `ACCOUNT_CUES`（同じファイル）で種類と科目のコードを決める。NFKC と大文字・小文字を無視した部分一致:
  - card（科目 2020 未払金）: カード, クレジット, CARD, VISA, MASTER, JCB, AMEX, ダイナース
  - bank（科目 1020 普通預金）: 銀行, 信用金庫, 信金, 信用組合, 労働金庫, ゆうちょ, 普通, 預金, BANK
  - cash（科目 1010 現金）: 現金, 財布, サイフ
  - 2 つ以上の種類の語が当たる（「〇〇銀行デビットカード」）・どれも当たらない・電子マネー（Suica, PASMO, PayPay など。科目を決められない）: 推定しない（種類だけ `other` の案にもしない）
  - 大項目（その口座の行の大項目の一覧）は、名前で決まらないときだけ同じ表で見る
  - 補助科目: 決めた科目の有効な補助科目のうち、名前が口座の名前に含まれる（または口座の名前が補助科目の名前に含まれる）ものが 1 つだけなら案にする（002 の `freee-aliases.ts` のカードの扱いと同じ考え）
  - 用途: 「事業」「ビジネス」「法人」「BUSINESS」→ business、「個人用」「家計」「私用」→ private。どれもなければ推定しない
  - 科目は、コードの科目が事業体にあって有効なときだけ案にする
- preview の `unmappedAccounts` を `[{ name, suggestion }]` にし、案と手がかり（当たった語）を返す。commit の入力に、未対応の口座の対応（`accounts`）を足し、取込と同じ UnitOfWork で保存する（spec US3-4。案は確定まで保存しない）。用途が推定されない口座は、利用者が用途を選ぶまで確定できない
- **Rationale**: 規則なので説明でき（手がかりを示せる）、AI を待たない（FR-015）。科目はコードで引く（005/R10 と同じ）
- **Alternatives**: AI で推定（遅い、説明しにくい）。PUT `/statement-accounts/:name` を口座ごとに先に呼ぶ（006 の形。確定前に保存されてしまう）

## R10. 端末内の AI による列の対応の案

- **Decision**:
  - domain: `buildColumnPrompt(layout)` が、見出しのセルと先頭の明細の行 5 件（`COLUMN_PROMPT_ROWS = 5`）だけでプロンプトを作る。前置きの行と 6 行目以降は入らない（INV-48）。出力は `AiColumnSuggestion`（Zod、`packages/schema/src/ai.ts`）: 役割ごとの列の番号（または null）、`amountSign`（任意）、`confidence`（0〜100）、`reason`（200 字以内）。`parseColumnSuggestion(raw, columnCount)` が、形・列の番号の範囲・役割の重複・必須の役割（日付・内容と、金額か出金・入金）を確かめ、外れれば「案なし」にする
  - ポート: `ColumnSuggestionProvider { available(): Promise<boolean>; suggestColumns(prompt: ColumnPrompt): Promise<Result<unknown>> }`（`packages/domain/src/ports.ts`）。ユースケース `suggestStatementColumns(deps, layout)`（`usecases/statement-columns.ts`）は、辞書の案で必須の役割がそろっているか、保存した対応が当てはまるなら呼ばない（FR-016）
  - server: `ai-client.ts` の Chat Completions の呼び出し（JSON・SSE の読み取り、`response_format` の 400 での再試行、タイムアウト）を、`AiPayload` に結びつかない `chatCompletion(options, messages, schema)` に切り出し、006 の `createOpenAiProvider` と新しい `createColumnProvider` が共有する。`createColumnProvider` には `ai-runtime` の `providers.local`（端末内）の endpoint だけを渡し、外部の endpoint を受け取る口を持たない（FR-018）。AI の設定で端末内を無効にしていれば `available()` は false（006 と同じ）。待ち時間は 20 秒（`COLUMN_TIMEOUT_MS`）
  - web: preview の前の列の選択の画面で、辞書の案で必須がそろわないときだけ、案の要求を出す（画面は待たずに使える。spec US4-2）
- **Rationale**: 値は AI に読ませない（FR-006）。外部へ送らない制約を、型と配線（外部の endpoint を渡さない）で守る。006/T035 のとおり端末内の AI は遅いので、短い待ち時間で切り、案なしで進める
- **Alternatives**: 006 の `createAiSuggester` を通す（外部へ回る経路を持ってしまう）。数字を伏せて渡す（端末内で外へ出ないので不要。列の役割の判定には値の形が要る）

## R11. 入力のハッシュと計画の変化

- **Decision**: `inputSha256 = sha256Hex(JSON.stringify({ text, year, mapping, fixedAccountName }))`（キーの順を固定した正規の JSON。server の `statements.ts` の `inputSha256` を直す）。commit は 006 と同じく `expected.inputSha256`・`countNew` で preview との違いを 409 `STATEMENT_PLAN_CHANGED` にする
- **Rationale**: 同じテキストでも対応が違えば別の計画になる
- **Alternatives**: テキストだけのハッシュ（対応を変えた後の取り違えを見逃す）

## R12. 上限

- **Decision**: バイト数は 5 MB（002 と同じ `readUpload`）。読む行数は 20,000 行まで（超えれば 422 `STATEMENT_TABLE_TOO_LARGE`、details に上限）。列数は 50 まで。layout の応答の見本の行は 10 行
- **Rationale**: 1 年分の個人事業の明細（数千行）に十分。SC-006 の 500 件は余裕がある
- **Alternatives**: 上限なし（巨大な貼り付けで server が固まる）

## R13. 名前と出所の値の見直し

- **Decision**:
  - `STATEMENT_ORIGINS = ["paste", "file"]`（`mfme_fetch` を消す）。表示は「貼り付け」「ファイル」
  - `packages/domain/src/statements/paste.ts` を削除し、`table.ts`（`detectTableLayout`・`readStatementTable`）と `columns.ts`（辞書と役割）に置き換える。`PastedRow` → `StatementRow`、`MfmePaste` → `StatementTable`、`parseMfmePaste` は廃止
  - エラーコード `STATEMENT_PASTE_UNREADABLE` → `STATEMENT_TABLE_UNREADABLE`（文言から「MF ME の入出金の表」を消す）
  - テストの部品: `formatMfmePaste`・`MFME_HEADER`・`mfmeDate` を、R14 の汎用の生成器に置き換える。フィクスチャ `packages/domain/test/fixtures/mfme/` → `fixtures/statements/`
  - 画面の文言（`import.tsx`・`index.tsx`・`PasteImport.tsx`・`api-errors.ts`・`labels.ts`）から MF ME を前提とした説明を消す
  - マイグレーション: `statement_sources` を足し、`statement_batches` に `source_name` を足して origin の CHECK を直す。`statement_audit_log` の target・action の CHECK にも取込元の値を足す。SQLite は CHECK を変えられないので、drizzle-kit の再作成（`__new_` の表への写し）を使い、0008 の両方の表のトリガーを `--custom` の SQL で作り直す（data-model §2）。既存の `mfme_fetch` の行はない（取得は実装していない）ので、写しで落ちる行はない
  - `006-mfme-ai-journal` の機能の名前を指すコメント（`// 006-mfme-ai-journal（...）`）は、機能の記録としてそのまま残す
- **Rationale**: 開発中で利用者がいないので、互換の別名を残さない（spec の Assumptions）
- **Alternatives**: 古い名前を別名として残す（使われない名前が残る）

## R14. テスト

- **Decision**:
  - 性質テスト（INV-49）: `packages/domain/test/statement-table-arbitraries.ts` が、明細の行（日付・内容・符号つきの金額・口座）から、区切り文字・引用・前置きの行・見出しの有無・列の並び・金額 1 列（符号の向き 2 通り）か 2 列・金額と日付の書き方を変えたテキストと、正しい対応を作る。`readStatementTable(テキスト, 対応)` が元の行（件数、各行の値、入金・出金の合計）を返すことを確かめる。layout の判定は、内容に日付・金額に見える値を入れない生成器の上で、区切り文字と見出しの行を当てることを確かめる
  - 例のテスト: `fixtures/statements/` に合成の明細を置く（MF ME の形のタブ区切り、出金・入金 2 列で前置きのある銀行の CP932 の CSV、正が出金のカードの CSV、和暦の CSV、見出しのない CSV）。README に作り方と検算（件数・入金と出金の合計）を書き、`expected.ts` に期待値を置く（002 のフィクスチャと同じ方針）
  - AI: 偽の `ColumnSuggestionProvider`。server のテストは偽の `fetch` で、端末内の endpoint だけに要求が行き、外部の設定があっても外部へ行かないことを確かめる
  - 006 の既存のテストは、`PastedRow` → `StatementRow` などの名前を直し、貼り付けの入力を multipart に直す
- **Rationale**: SC-001（金額の誤り 0 件）は具体例だけでは保証できない（Constitution V）

## R15. 列の案の評価（Constitution IV の Evals）

- **Decision**: 列の案（R10）にも評価を持たせる。
  - 評価の例: `packages/domain/test/fixtures/statements/column-evals.ts` に、合成の見出しと先頭の行（R10 の入力と同じ形）と正しい対応の組を 20 件以上置く（T001 の各形、独自の見出し、英語の見出し、見出しなし）。実データから作らない
  - `evaluateColumnSuggestions(cases, provider)`（`usecases/statement-columns.ts`）が、例ごとに `suggestStatementColumns` と同じ経路で案を作り、必須の役割（日付・内容・金額か出金・入金）がすべて正しい割合、役割ごとの一致率、案なしの割合を返す
  - `pnpm eval:columns`（`scripts/eval-column-suggestions.ts`）が端末内の AI で評価を実行し、結果（件数と割合だけ）を `.tmp/eval-columns/` に日時つきの JSON で残して前回と比べる。CI は偽の provider で `evaluateColumnSuggestions` の集計だけを確かめ、AI は呼ばない
  - プロンプト・`COLUMN_PROMPT_ROWS`・待ち時間を変えるときは、変更の前と後の `pnpm eval:columns` の結果を比べる（AGENTS.md に書く）
- **Rationale**: 憲法 IV は「AI機能の変更は MUST 評価データセットでの精度比較を伴う」とする。列の案は帳簿の値を作らないが、AI 機能なので例外にしない。006 の評価（`evals.ts`）は承認の結果を正解にする仕組みで、列の対応には正解の材料がないため、合成の例で別に持つ
- **Alternatives**: 006 の評価の表に混ぜる（正解の作り方と保存の形が違う）。評価なし（憲法に反する）
