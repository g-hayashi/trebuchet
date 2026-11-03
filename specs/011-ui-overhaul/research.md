# Research: 画面の作り直し（011）

各項は Decision（決めたこと）・Rationale（理由）・Alternatives（退けた案）。今のコードの場所は 2026-11-03 の調査による。

## R1. ルートとメニュー

**Decision**:
- ヘッダー（`components/layout/AppHeader.tsx`）: 左にロゴ「Trebuchet」と今の事業体の名前（どちらも最後に開いた事業体のホーム `/e/<id>` へ。なければ `/`）、事業体の切替（2 件以上のとき）。右に「設定」（`/settings/security`）と「施錠してサインアウト」（確認のダイアログ → `POST /api/auth/sign-out`）だけ。今の「バックアップ」「AI の設定」「リモート」の 3 つのリンクを消す（FR-002）。施錠中・未サインインでは右の 2 つを出さない。
- 事業体のメニュー（`components/layout/EntityNav.tsx`、`route.tsx` の `NAV` を置き換える）。項目が 1 つのグループは作らず直接のリンクにする（FR-003）:

| 1 段目 | 2 段目 |
|---|---|
| ホーム | — |
| 仕訳 | 入力する（`journals/new`）・一覧（`journals`）・定期仕訳（`recurring`） |
| 明細 | 取り込む（`statements/import`）・一覧と確認（`statements`）・ルール（`statements/rules`）・明細の設定（`statements/settings`） |
| 証憑 | 追加する（`receipts/new`）・一覧（`receipts`） |
| 請求 | 請求の流れ（`invoices`）・工数（`work-hours`）・請求の設定（`invoice-settings`） |
| 帳票 | 直接のリンク（`reports/profit-and-loss`）。帳票の画面の中のタブで仕訳帳・元帳・試算表・損益計算書・貸借対照表を行き来する |
| 決算・申告 | 決算書（`blue-return`）・固定資産台帳（`fixed-assets`）・開業費（`deferred-assets`） |
| 事業体の設定 | 基本（`settings`、名前の変更）・勘定科目・取引先・タグ・消費税・会計期間と移行（`periods`。freee の取込はこの画面から） |

- ルートの増減: 足す `e/$entityId/settings.tsx`、`receipts/new.tsx`、`deferred-assets/index.tsx`。消す `invoices/$invoiceId_.print.tsx`、`tax-return/$year.tsx`、`statements/evals.tsx`、`blue-return/$year/deduction.tsx`（ダイアログに移す）、`receipts/capture.tsx`（`receipts/new` にまとめる）。旧 URL の転送は作らない（spec の Assumptions）。
- `reports/index.tsx` の転送先を損益計算書に変える。

**Rationale**: 毎日の作業（仕訳・明細・証憑）を 1 段目に出し、入力と一覧に 1 回で届く（SC-001）。グループの名前とメニューの `aria-label` は E2E の `openNav` が参照するので、contracts/ui-shell.md に名前を固定する。

**Alternatives**: 「記帳」のグループに仕訳・明細・証憑・定期仕訳をまとめる今の形 → 入力まで 2 回かかる（U3）。左の縦のサイドバー → スマホのメニューと別の部品が要り、今の上の横のメニューで足りる。

## R2. 共通の部品（依存を足さない）

**Decision**: `components/ui/` に自前で作る。
- `combobox.tsx`: WAI-ARIA の combobox（`input` + `listbox`、`aria-activedescendant`）。↑↓ で選び、Enter で決めて次の欄へ移る。絞り込みは呼ぶ側が渡す `match(option, query)`。科目と取引先で使う。
- `toast.tsx`: `ToastProvider` と `useToast()`。画面の上の固定の位置に出し、`role="status"`・`aria-live="polite"`（失敗は `role="alert"`）。5 秒で消える。今の `SaveNotice`（26 ファイル）は中で `useToast` を呼ぶ形に置き換え、呼び出し側は直さない（FR-005）。
- `sheet.tsx`: 既存の `radix-ui` の Dialog を右から出す横のパネル（スマホは全画面）。仕訳の一覧の中身（R8）、請求の入金（R13）で使う。
- `steps.tsx`: ①〜④ の段階と今の段階（`aria-current="step"`）。明細の取込（R9）と請求（R13）。
- ボタン（FR-004）: 各画面の主な操作 1 つだけ `variant="default"`、ほかは `outline`・`ghost`・`link`。危ない操作は `destructive`。web のテストで、主な操作のボタンが画面に 1 つだけあることを主要な画面で確かめる（`data-primary` ではなく variant の class を見ない。主な操作の名前で `getByRole` する）。

**Rationale**: 必要な部品は 4 つで、どれも数十〜百数十行。UI のライブラリを足すと依存の承認とバンドルの増加がいる（憲法 VII）。

**Alternatives**: `cmdk`・`sonner`・`vaul` を足す → 依存の追加。`<datalist>` → Safari で絞り込みと選択の表示が不安定で、コードと名前の両方を出せない。

## R3. ホームの要約

**Decision**: `GET /api/entities/:id/home`（新設）が `HomeSummary`（contracts/http-api.md §1）を返す。domain のユースケース `getHomeSummary` が、項目ごとに既存のユースケース・ストアを呼んで組み立て、項目ごとに例外・`err` を捕まえて `{ status: "error" }` にする（FR-009。1 つの失敗で応答全体を失敗にしない）。
- 今日やること: 未処理の明細（`listStatements` の `status=unprocessed` の件数）、仕訳のない証憑（`ReceiptStore` に `count(query)` を足し、`link=none`・削除済みを除く）、未入金の請求書（`unpaid|partial` の件数）とそのうち期限切れ（`overdue`）、登録できなかった定期仕訳（今の `blocked` の判定の件数。保存されていない。D4）、今の年度の決算書の警告（`buildBlueReturn` の `warnings` の件数。今の年度の会計期間がなければ 0）。
- 今期の数字: 今日を含む会計期間の損益計算書（`from` = 期首、`to` = 期末）の売上高（`PL_SALES` の合計）、経費（`PL_COGS` + `PL_EXPENSE` の合計）、利益（`netIncome`。青色申告特別控除の前）。今日時点の貸借対照表の現金と預金（最初からある科目の現金・預金のコードの行の合計。コードの一覧は schema の定数 `CASH_AND_DEPOSIT_CODES`。tasks で seed のコードを確かめて決める）。未回収の合計（`outstandingByPartner` の `outstanding` の合計）。帳票と同じ関数（`buildProfitAndLoss`・`buildBalanceSheet`）を同じ引数で呼ぶので一致する（INV-72）。
- 最近の仕訳 5 件: 取消を除き、登録日時（`journals.created_at`）の新しい順。
- 最後の明細の取込の日時: 取込の回の `createdAt` の最大。
- 前回の成功したバックアップは端末の情報なので、web が既存の `GET /api/backup/status` を別に読む。
- 各項目の押し先は絞り込みの検索の引数つきの URL（contracts/ui-shell.md §3）。

**Rationale**: 1 回の要求で済み（SC-003）、件数の数え方を domain の 1 か所に置ける。帳票と同じ関数を通すので SC-002 を構造で満たす。

**Alternatives**: web が既存の一覧の API を 6 本読んで数える → 証憑は 200 件のページ送りで数えられず、web に件数の規則が散る。要約を保存する → 憲法 I（集計値を保存しない）に反する。

## R4. ブラウザに覚える値

**Decision**: `localStorage` に置く（帳簿のデータではない）。
- 最後に開いた事業体: 既存の `EntitySwitcher.tsx` の `entityToRestore` の鍵をそのまま使う。トップ（`/`）は事業体が 1 件ならそのホーム、2 件以上なら一覧（最後に開いたものを上に、目立たせる）、0 件なら作成（FR-010）。今の「タブの最初の表示なら前回の事業体へ」は、件数による分岐に置き換える。
- 証憑の区分の既定（FR-027）: `trebuchet.receiptCategory.<entityId>`。
- 入金先の既定（FR-035）: `trebuchet.depositAccount.<entityId>`。

**Rationale**: どれも端末の好みで、別の端末と共有する必要がない。DB に置くとバックアップと API が要る。

**Alternatives**: 入金先を前回の入金の記録から server が引く → API の変更が要る割に得るものが少ない。

## R5. 仕訳のかんたん入力・税区分の既定・科目の読み・履歴からの候補

**Decision**:
- かんたん入力（`features/journals/QuickEntryForm.tsx`）: 日付・借方の科目・貸方の科目・金額・摘要（任意で取引先・税区分・タグ）。送るときは 2 行の `JournalInput`（借方 1 行・貸方 1 行、同じ金額）にして 001 の `POST /journals` を呼ぶ。API は変えない。「詳細」は今の `JournalForm`（複数行）を使い、最後の行の金額を差額で埋める（入力されていない最後の行だけ。利用者が入れた値は上書きしない）。
- 税区分の既定: `JournalForm.tsx:62-80` の web の複製と `packages/domain/src/journal.ts:49-60` を、`packages/schema/src/tax-defaults.ts` の `defaultTaxCategory` 1 つにする。domain はそれを import する（domain → schema の向き）。web は表示の「自動（○○）」だけに使い、送るときは今どおり省いて server に決めさせる。
- 科目の読み: `packages/schema/src/account-readings.ts` に、最初からある科目のコード → ひらがなの表 `ACCOUNT_READINGS` を置く（seed の全科目）。最初からある科目は名前を変えられなくなる（R15）ので、コードで引いてずれない。絞り込みは名前・コード・読みの NFKC の部分一致（`lib/account-search.ts`）。利用者の科目は名前とコードだけ（D3）。
- 入力の順と Enter: 最初の欄（日付）に `autoFocus`。Enter は送信せず次の欄へ移り、最後の欄で Enter を押すと登録する（combobox の中の Enter は選択の確定）。登録の後は日付を残して他を空にし、借方の科目へ移る（FR-013）。
- 履歴からの候補（FR-014）: `GET /api/entities/:id/journals/suggestions?memo=&partnerId=`（新設）。domain の純関数 `suggestFromHistory(journals, query)` が、取消を除く過去の仕訳のうち、摘要の正規化（`normalize.ts` の明細の内容と同じ NFKC・空白の正規化）が一致するもの、または取引先が一致するものを、新しい順に最大 3 件、借方・貸方の科目・税区分・取引先の組で重ねずに返す。2 行の仕訳だけを候補にする（3 行以上は形を表せない）。摘要の入力から 300 ms 待って呼ぶ。
- 複製: 一覧の中身と詳細から「複製して入力」→ `journals/new?from=<journalId>`。日付を今日にし、行・摘要・取引先・タグを写す。2 行ならかんたん入力、3 行以上なら詳細で開く。

**Rationale**: かんたん入力は画面だけの形で、帳簿の規則は 001 のまま（憲法 I）。税区分の既定を 1 か所にすることで、web に業務ルールを持たない規則（AGENTS.md）を守る。

**Alternatives**: 科目に読みの列を足す → マイグレーションと編集の欄が要り、利用者の科目は名前で十分。履歴の候補に 006 のルールを使う → ルールは明細の内容と口座が鍵で、仕訳の摘要とは鍵が違う。

## R6. 仕訳の下書き

**Decision**: 事業体の DB に表 `journal_drafts`（data-model §1.1）を足し、行は 1 件だけ（`id = 1`）。中身は `JournalDraft`（Zod、未完成を許す形: 行の科目・金額は空を許す）の JSON。API は `GET/PUT/DELETE /api/entities/:id/journal-draft`（contracts §2）。入力の画面（新規だけ。訂正は対象外）が、変更から 1 秒待って `PUT` する。登録に成功したら `DELETE`。画面を開いたとき下書きがあれば「続ける」「捨てる」を出す。下書きは仕訳の表・監査の記録・帳票の関数のどれも読まない（INV-69）。施錠中は読めない（他の帳簿の API と同じ）。

**Rationale**: spec は「暗号化した DB に残す」（FR-015）。1 人で毎日 1 か所で入力するので 1 件で足りる（D2、Q1）。

**Alternatives**: `localStorage` → 平文で端末に残り、帳簿の内容（摘要・金額）が暗号化の外に出る（008 の INV-51 の趣旨に反する）。複数の下書きの一覧 → YAGNI。

## R7. 仕訳の一覧の自動の絞り込みと件数・合計

**Decision**: `GET /journals` の応答に `summary: { count, amount }` を足す（条件に合う全件の件数と、各仕訳の借方合計の和。ページ送りとは別に数える）。web は条件の変更から 300 ms 待って再読み込みし、検索のボタンをなくす（FR-018）。期間の初期値は今の会計期間。

**Rationale**: 件数・合計はページ送りの外の値なので server でしか出せない。

**Alternatives**: web が全ページを読んで足す → 件数が多いと遅く、ページ送りの意味がない。

## R8. 一覧のその場の中身・訂正・取消・定型の理由

**Decision**: 仕訳の一覧の行（行全体がボタン）を押すと `Sheet`（R2）に中身（`GET /journals/:id` と履歴）を出し、「訂正」（Sheet の中で `JournalForm` を訂正の形で開く）・「取消」（理由のダイアログ）・「複製して入力」を置く。可否は今の規則（締めた年度・`JOURNAL_LINKED`）を server の応答で判断し、締めた年度は今の「当年度に訂正仕訳を起票」を出す。`journals/$journalId.tsx` は直接のリンク（証憑・明細から）用に残し、同じ中身の部品を使う。定型の理由は `features/journals/reasons.ts` の一覧（誤記の訂正、金額の誤り、科目の誤り、二重の登録、取引の取消）を `ReasonDialog` の選択肢にし、選ぶと理由の欄に入る（編集できる。FR-017）。

**Rationale**: SC-005（一覧から訂正の開始まで 2 回: 行 → 訂正）。

**Alternatives**: 行の展開 → 訂正のフォームが表の中に入り、横幅が足りない。

## R9. 明細のステップ・自動の候補・ルールの自動の作成

**Decision**:
- 取込の画面に `Steps`（①入力 → ②列と口座 → ③取込 → ④確認・承認）。今の `ImportWorkspace` の段階（取込元・列の対応・プレビュー）を ①〜③ に当てる。
- 取込の確定（`POST /statements/imports`）が成功したら、web が続けて `POST /inference-rules/seed`（過去の仕訳からのルール。自動で作るルールだけを作り・更新する）→ `POST /statements/candidates`（ルール）→ `POST /statements/infer`（AI。設定が無効なら飛ばす）を順に呼び、進みを `Steps` に出す。AI の失敗は知らせて確認へ進む（Edge Cases）。API は変えない。一覧の画面には「候補をもう一度作る」を控えめに残す（途中で画面を離れたとき用）。
- 確認（`features/statements/ReviewQueue.tsx`）: 未処理の明細を 1 件ずつ、明細と候補の仕訳を並べて出し、「承認して次へ」（主な操作）・「飛ばす」・「除外」。最後の後は完了の知らせとホーム・一覧へのボタン。まとめての承認（`BulkApprove`）は今のしきい値の規則のまま確認の上に置く。
- ルールの自動の作成（FR-022）: 承認の入力から `learn` をなくし、承認のたびに今の学ぶ条件（`inference-rules.ts:98-107`）で `learnRule` する。`inference_rules` に列 `managed_by`（`auto` | `user`）を足す（data-model §1.2）。ルールの一覧で利用者が科目・税区分を直すか止めた（`paused`）ルールは `user` になり、承認・`seedRulesFromJournals` の自動の作成・更新はそれを変えない（INV-71）。一覧は「自動」「利用者が直した」を区別して出す（FR-023）。`seedRulesFromJournals` は同じ鍵の `auto` のルールを更新してよく、`user` のものは飛ばす。
- しきい値は `statements/settings`（明細の設定）にだけ置き、一覧・確認から消す（FR-024）。

**Rationale**: 取込の後の連鎖は既存の 3 つの API で足りる（006 の 3 段の規則 R8 を変えない）。server で連鎖させると取込の確定が AI を待つことになる。

**Alternatives**: `origin` の値を足して利用者の管理を表す → `origin` は作られ方の記録で、管理の主体とは別の軸。

## R10. アプリの中の評価の削除と `eval:statements`

**Decision**: 表 `eval_runs`、`usecases/evals.ts` のうち実行と保存、`POST/GET /statements/evals`、`statements/evals.tsx`・`EvalRuns.tsx` を消す。評価の採点の純関数（`statements/evals.ts`）は残し、`scripts/eval-statements.ts`（`pnpm eval:statements`）から使う。データは合成の明細（`packages/domain/test/fixtures/statements/` の README の方針で作る）と、R19 の仕訳の入力の場面の合成の例。結果は `.tmp/eval-statements/` に件数と割合だけを残して前回と比べる（007 の `eval:columns` と同じ形）。CI に含めない。`lib/jobs.ts` の評価のジョブは、ほかに使う所がなければ消す（tasks で grep する）。

**Rationale**: 日々の画面に要らない（U11）。憲法 IV の評価は 007・010 と同じくスクリプトで満たす（FR-025）。

**Alternatives**: 画面だけ消して API と表を残す → 使われない保存が残る。

## R11. 証憑の画面とスマホ

**Decision**:
- 証憑: `receipts/new`（追加）・`receipts`（一覧）・`receipts/$receiptId`（詳細）。追加は `<input type="file" multiple accept=...>`（スマホは `capture` なしの複数選択で、写真の撮影もカメラの選択肢に出る）。既存の `POST /receipts`（1 ファイル）を 1 件ずつ順に呼び、結果（追加・重複・エラー）を 1 件ずつ出す（FR-026。API は変えない）。区分の既定は R4。追加の後、追加した証憑のうち未入力のものの値の入力（取引年月日・金額・取引先、AI の読み取りが有効なら「読み取る」）を同じ画面で開き、「次の未入力の証憑へ」で進む（FR-028）。一覧の上に「未入力」（`missing=true`）・「仕訳なし」（`link=none`）の切替（FR-029）。詳細は上に原本・値・結びつき、下に `<details>` で情報・履歴・差し替え・削除（FR-030）。
- スマホ（FR-058・059）: Tailwind の `md`（768 px）未満をスマホの幅とする。ヘッダーはロゴ・事業体の名前・メニューのボタンだけにし、メニューは `Sheet` の中に、スマホの対象の項目（ホーム・証憑・仕訳の一覧・帳票）と設定・施錠してサインアウトを出す。対象の外のルートでは `PcRecommended`（「PC での操作を推奨」）を上に出す（`useMediaQuery("(max-width: 767px)")` とルートの一覧 `MOBILE_ROUTES`。contracts/ui-shell.md §4）。表は `overflow-x-auto` の枠に入れ、ページの `body` に横のはみ出しを出さない。
- 確かめ方: jsdom は配置を計算しないので、E2E `apps/web/e2e/mobile.spec.ts`（390 × 844）で FR-058 の各画面の `document.documentElement.scrollWidth <= clientWidth` を確かめる（SC-010）。web のテストはメニューの項目の絞り込みと PC の推奨の表示だけを確かめる（`matchMedia` の偽物）。

**Rationale**: 複数の追加は画面の繰り返しで足り、010 の全部か無かの規則（1 件ずつ）をそのまま使える。

**Alternatives**: 複数ファイルの API → 1 件の失敗の扱い（全体を止めるか）を決め直す必要があり、得るものが少ない。

## R12. 帳票

**Decision**:
- 仕訳帳の並び（FR-038）: `JournalBookQuery` に `sort`（`date` | `created`、既定 `date`）と `order`（`asc` | `desc`、既定 `asc`）を足す。`date` は今の並び（日付 → 仕訳番号 → 行）、`created` は `journals.created_at` → 仕訳番号 → 行。行は仕訳の中で常に今の順。domain の仕訳帳の組み立てで並べ、CSV も同じ並び。
- 科目名から元帳（FR-039）: 試算表・損益計算書・貸借対照表の科目名をリンクにし、`general-ledger?accountId=&from=&to=`（貸借対照表は期首から `asOf`）。
- 期間のプリセット（FR-040）: `PeriodPicker` に今月・先月・今四半期・今年・昨年。計算は web の `lib/dates.ts`（暦の計算だけで業務ルールではない）。
- 前年の案内（FR-041）: 比較つきの応答に `previousHasData: boolean` を足す（損益計算書は前年の同じ範囲に取消を除く仕訳の行があるか、貸借対照表は前年の会計期間があるか）。false なら比較の欄の近くに理由と、freee の取込（会計期間と移行の画面）への案内を出す。

**Rationale**: 0 の理由（データがないのか、本当に 0 か）は server でしか判断できない。

**Alternatives**: web が前年の列が全部 0 かで判断する → 本当に 0 の場合と区別できない。

## R13. 請求と印刷

**Decision**:
- `invoices`（請求の流れ）: `Steps`（①工数 → ②請求書を作る → ③入金）と、各段階の入口、取引先（請求先）の一覧と「取引先を登録」、請求書の一覧（既定の絞り込みは未入金・期限切れ）。言葉は「請求書を作る」に統一し、作る画面に「ここでは保存しません。発行すると請求書と仕訳ができます」と出す（FR-032）。
- 発行済みの月（FR-033、D5）: 作る画面で取引先と月を選ぶと、一覧（未取消）にその取引先・対象月の請求書があれば「発行済み（番号）」と示し、「取り消す」（詳細へ）か「追加で作る」（`confirmDuplicate: true`）を選ぶまで作るボタンを押せない。server の `INVOICE_DUPLICATE_MONTH` の規則は変えない。
- 取引先の登録・編集（FR-034）: R15 の `PUT /partners/:id/profile` を使う 1 つの欄（名前・敬称・メモ・請求の条件・使用停止）。
- 入金（FR-035）: 一覧の行の「入金」で `Sheet` に `PaymentForm`。入金先の既定は R4。
- 印刷（FR-036・037）: `$invoiceId_.print.tsx` を消し、詳細に `InvoicePrint` を `data-print-root` の要素として置く（画面では詳細の中のプレビュー）。「印刷・PDF に保存」は `window.print()`。`print.css` を全体の `@media print` で、`[data-print-root]` 以外（ヘッダー・メニュー・知らせ・事業体の名前・バナー）を `display: none` にする。`@page { margin: 0 }` にして、余白は請求書の要素の `padding` で取る（Chrome・Safari は余白 0 でブラウザのヘッダー・フッターを出さない）。屋号と氏名が同じなら 1 回だけ出す（`InvoicePrint` の表示の分岐。発行時の写しの値で比べる）。画面に「ブラウザの印刷の設定でヘッダーとフッターを消せます」と小さく出す（Edge Cases）。

**Rationale**: 印刷の重なり（U18〜U20）は、印刷用のページが事業体のレイアウトの子であることが原因。印刷の範囲を 1 つの要素に絞れば、ページを分ける必要がない。

**Alternatives**: PDF をアプリで作る → 依存が要る。印刷用のルートをレイアウトの外に出す → 別のページへ移る（FR-036 に反する）。

## R14. 決算・申告

**Decision**:
- 申告の控えの削除（FR-042）: 表 `tax_return_memos`・`filed_documents`（マイグレーションで `DROP TABLE`）、`closing-repository.ts:177-223`、`ports.ts:286-` の該当部分、`usecases/blue-return.ts:1102-1200`、`routes/tax-return.ts`、web の `features/tax-return/` と `routes/tax-return/`、関連のテスト（`tax-return.api.test.ts`、`tax-return.test.tsx`、`usecase-tax-return.test.ts`、`closing-repository.test.ts:240` 付近、`closing-schema.test.ts` の該当、`fakes/closing.ts`）。バックアップ・復元の表の一覧に名前があれば直す（tasks で grep）。
- 決算書（FR-043）: `blue-return/index.tsx` を、今日を含む会計期間の年（なければ最新）へ転送する。年度の切替は `$year` の画面の上の select。
- 控除の要件（FR-044）: `deduction.tsx` の回答の欄を `DeductionAnswersDialog` に移し、決算書の欄 44 の近くに「要件を直す」を置く。回答がなければ欄の近くに「要件に回答すると控除額が出ます」。保存の後、決算書を読み直す。
- 使わない欄（FR-045）: 画面の切替をなくし、常に隠す。CSV は今の `blankUnused=true` を常に付ける。
- 開業費（FR-046）: `fixed-assets/index.tsx:194` 以降の開業費の節を `deferred-assets/index.tsx` に移す。API・規則は変えない。

**Rationale**: 控えは計算に使われていない（引き継ぎの調査）。消すだけで決算書は変わらない。

**Alternatives**: 画面だけ消す → 使わない表と API が残る。

## R15. マスタ・期間

**Decision**:
- 最初からある科目の保護（FR-047、INV-70）: `renameAccount`・`updateAccount`（`name` を変えるとき）・`deleteAccount` で `isSystem` なら 409 `ACCOUNT_SYSTEM_PROTECTED`。使用停止・再開と `reportLine` の変更は通る。画面は `isSystem` の科目に名前の変更・削除を出さず「最初からある科目」の印を出す。
- 科目の一覧（FR-048）: 各行の右端に「使用停止」「使用再開」を `outline` のボタンで置き、上に検索と「使用停止を隠す」（既定 ON）。取引先も検索。
- 取引先（FR-049）: `PartnerInput` に `isActive?: boolean | undefined` を足す。新設の `PUT /partners/:id/profile`（と新規の `POST /partners/profile`）が、取引先と請求の条件（`BillingTermsInput | null`、null は条件を消す）を 1 つの `TenantUnitOfWork` で保存する（ユースケース `savePartnerProfile`）。使用停止の取引先は、請求書を作る対象・仕訳の入力の候補・取引先の combobox に出さない（一覧の API に `active=true` の絞り込みはせず、web が `isActive` で絞る。今の請求の規則は server の `PARTNER_INACTIVE` で守られている）。
- 消費税の説明（FR-050）: `tax-settings.tsx` に、課税区分ごと・経理方式ごとの説明の文（既定の税区分、税額の計算、税抜は登録できない `TAX_METHOD_UNSUPPORTED`、簡易課税・2 割特例は帳簿の計算では本則と同じ）。文は `features/entities/tax-help.ts` の 1 か所。
- 会計期間（FR-051）: `periods/index.tsx` を年度ごとのカードにし、「期首残高 → 記帳 → 決算整理 → 締め」の 4 段の状態（期首残高: 登録の有無。記帳: 仕訳の件数。決算整理: 決算書の画面へのリンクだけで状態は出さない。締め: 締めの有無）と入口。freee の取込（`imports`）への入口をこの画面に置き、取込の画面からは期首残高（元帳から作る）と照合（`imports/reconcile`）へのリンクを上に出す。状態は既存の API（期首残高、仕訳の一覧の `summary.count`、会計期間）で足りる。
- 事業体の名前の変更（FR-052）: `e/$entityId/settings.tsx` に移す。

**Rationale**: 科目の保護は帳簿と決算書の欄の対応（seed の `reportLine`）を守るための業務ルールなので domain に置く。

**Alternatives**: 画面で隠すだけ → API から変えられ、FR-047 の「API でも拒む」を満たさない。

## R16. バックアップの既定の置き場所 `bak/`

**Decision**: 置き場所（registry の `backup_folder`）が未設定なら、server は `<リポジトリ直下>/bak` を使う。リポジトリ直下は、既定のデータ場所（`<リポジトリ直下>/data`）を決める今の関数と同じ求め方で決める（`TREBUCHET_DATA_DIR` があっても `bak/` はリポジトリ直下。環境変数 `TREBUCHET_DEFAULT_BACKUP_DIR` で変えられる。テストは一時のディレクトリを渡す）。`BackupStatus` に `folderSource: "configured" | "default"` を足し、`configured` は「実行できる」の意味で常に true にする（既定があるので）。自動の実行（`backup-scheduler.ts:34`）と手動の実行は既定でも動く。書けなければ今の失敗の警告（`LAST_RUN_FAILED`）。画面は既定のとき「この Mac の中（`bak/`）にあります。Mac を失うとバックアップも失われます。同期フォルダなどに変えられます」を出す。証憑の写し（`trebuchet-receipts/`）も同じ置き場所の下（010 のまま）。`.gitignore` に `bak/` を足す。

**Rationale**: SC-009（何も設定せずに最初のバックアップ）。

**Alternatives**: 初回の設定で置き場所の入力を必須にする → 要望 10・12 の手間がそのまま。

## R17. 設定の画面・記録の書き出し・施錠の文言

**Decision**:
- `routes/settings/route.tsx`（新設のレイアウト）: 左（スマホは上）にサブメニュー「セキュリティ」「バックアップ」「AI」「リモート」、各ページの `h1` はサブメニューの名前と同じ。幅は `max-w-4xl`（全ページ同じ。FR-053）。
- 認証の記録とバックアップの履歴（FR-054）: 画面は `limit=5`。書き出しは `GET /api/auth/events?format=csv` と `GET /api/backup/runs?format=csv`（全件。列は日時・種類・結果・端末の種類など、表に保存してある表示用の列だけ。`detail` は秘密を含まないことを tasks で確かめ、資格情報の ID・トークン・鍵の列は出さない）。0 件なら書き出しのボタンを無効にする。CSV は帳票と同じ書き方（UTF-8、BOM の扱いは `domain/src/reports/csv.ts` に合わせる）。
- 施錠（FR-055）: ヘッダーの「施錠してサインアウト」の確認の文「すべての端末でサインアウトし、帳簿を閉じます。もう一度開くにはパスキーか回復キーが要ります」。セキュリティの画面の `LockCard` も同じ文と同じ操作。「Mac で施錠」などの語を grep で消し、端末は「この Mac」「スマホ・リモート」にそろえる。
- バックアップの画面（FR-057）: 状態 → 復元（`InspectBackup`）→ 履歴の順。見出しの重なりはレイアウトの直しで解く。

**Rationale**: 書き出しを server の CSV にすれば、全件を画面に持たずに済む。

**Alternatives**: web が 500 件を読んで CSV を作る → 上限を超えると欠ける。

## R18. テストの直し方

**Decision**: メニューの名前・グループ・`aria-label` を contracts/ui-shell.md に固定し、US1 で `e2e/helpers/nav.ts` の `openNav` と `test/routes/entity-nav.test.tsx` を先に直す。各 US の画面の変更では、その画面の web のテスト（`test/routes/<画面>.test.tsx`）を先に新しい形に直して赤を確かめる。消す画面のテストは消す。E2E は利用者の端末で最後に 1 回実行する（サンドボックスはポートを開けない）。

## R19. 仕訳の入力の AI の候補

**Decision**:
- payload: `statements/mask.ts` に `buildJournalEntryPayload({ date, amount, memo })` を足し、`maskContent` を通した摘要・金額・日付だけの `JournalEntryPayload`（`scene: "journal_entry"`）を返す。既存の `AiPayload` に `scene: "statement"` を足し、`SuggestionPayload = AiPayload | JournalEntryPayload` にする。`prompt.ts` は `scene` で指示文を分ける。取引先の一覧・口座名・メモの他の欄は送らない（INV-45 の性質テストに `JournalEntryPayload` を足す）。
- 呼び出し: `POST /api/entities/:id/journals/ai-suggestion`（`{ date, amount, memo }`）→ `createAiSuggester` を今の順序（ルールは使わない。端末内 → 外部）で呼び、`AiSuggestion` で検証して、一覧にない科目・税区分は「候補なし」（INV-46）。外部の AI が無効なら 422 `AI_NOT_CONFIGURED`（画面はボタンを出さない）。3 段（読む → AI → 書く）の「書く」はない（候補を保存しない）。
- 画面: `features/ai-assist/AiSuggestionPanel.tsx`（`scene` を受け取る。011 は `journal_entry` だけ。FR-061 の案 B は場面を足す）。候補と根拠・確信度を出し、「入れる」で借方・貸方の一方（経費なら借方、売上なら貸方。`AiSuggestion.purpose` と科目の区分から web が欄を決める。決められなければ借方）と税区分を埋める。取引先の候補は R5 の履歴から（D1）。
- 評価: `eval:statements` に `journal_entry` の場面の合成の例（摘要・金額 → 期待の科目）を 30 件ほど置き、足す前（場面なし）と後で比べる（憲法 IV）。

**Rationale**: 006 の経路の中に場面を足すだけで、新しい種類の送る情報を作らない（FR-061）。

**Alternatives**: 別の AI の経路を作る → INV-45 の守りが 2 か所になる。

## R20. 性能

**Decision**: `scripts/bench-reports.ts` に `GET /home` を足す（約 500 仕訳、2 秒以内。SC-003）。仕訳の一覧の `summary` は同じ条件の `COUNT`・`SUM` の 1 回の問い合わせ。
