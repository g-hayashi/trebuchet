# Research: 定期仕訳と工数・請求

**Feature**: [spec.md](./spec.md) | **Date**: 2026-10-24

既存の構成で、方針に関わる事実（コードで確かめた）:

- `journals.source` は TS の enum（`manual` / `import_freee`）だけで、**DB に CHECK はない**（`0000_init.sql` は `DEFAULT 'manual' NOT NULL` だけ）。`createJournal` は `source` を受け取らず、常に `manual` で保存する（`insertJournal` の `NewJournal.source` は省略可）
- `partners` は既に `honorific`（`様` / `御中`、NULL 可）を持つ（001）
- `createJournal`・`voidJournal`・`correctJournal` は自分で `deps.ledger.transaction` を開く。003 の `commitAdjustment` は `ClosingUnitOfWork` の中で `createJournal` を呼んでいる（drizzle の better-sqlite3 では入れ子のトランザクションはセーブポイント）。**drizzle のトランザクションは例外でだけ巻き戻り、`err` を返しても確定する**
- `createApp` の `clock` は auth・backup のルートにだけ渡り、事業体のルート（`tenantRoutes`）は `deps.ts` の `clock` を直接使う
- 日付をローカルの暦日に直す関数はない（`Clock.now()` は ISO 8601 の UTC）
- 初期の科目のコード: 普通預金 `1020`、売掛金 `1030`、売上高 `4010`、支払手数料 `5250`（`seed/accounts.individual.ts`）

## R1. 層の配置

- **Decision**: AGENTS.md の 002〜004 の表に合わせる
  - domain: `packages/domain/src/invoicing/`（`amounts.ts`・`due-date.ts`・`number.ts`・`draft.ts`・`journal-drafts.ts`・`status.ts`）、`packages/domain/src/recurring/`（`schedule.ts`・`due.ts`）、ユースケース `usecases/invoicing.ts`・`usecases/recurring.ts`
  - db: `packages/db/src/invoicing-repository.ts`（`InvoicingStore`・`DrizzleInvoicingUnitOfWork`）、`recurring-repository.ts`（`RecurringStore`・`DrizzleRecurringUnitOfWork`）
  - server: `routes/invoicing.ts`・`routes/recurring.ts`、`lib/today.ts`、`lib/recurring-scheduler.ts`
  - web: `features/invoicing/`・`features/recurring/`、`routes/e/$entityId/` の `invoices/`・`work-hours.tsx`・`invoice-settings.tsx`・`recurring/`
- **Rationale**: 依存の向きを変えない。計算と判定は純関数（Constitution VII）

## R2. 請求書の PDF は印刷用の画面と印刷用の CSS

- **Decision**: 依存を足さない（003 research R14 の前例）。`/e/$entityId/invoices/$invoiceId/print` に A4 縦1枚の印刷用の画面を作り、`features/invoicing/print.css`（`@page { size: A4; margin: … }`、画面だけの要素は `@media print` で隠す）を当てる。開いている間 `document.title` を請求番号にし（Chrome・Safari は「PDF に保存」の既定のファイル名に title を使う）、離れるときに元に戻す
- **Rationale**: PDF の生成の依存（pdfkit、Playwright の `page.pdf` など）は、日本語のフォントの埋め込みと版の管理が要る。ブラウザの印刷で SC-005 を満たせる
- **Alternatives**: server で PDF を作る → 依存とフォントの同梱が要る（VII に反する）。web で `jsPDF` → 同上
- **確認**: A4 1枚に収まること（SC-005）は利用者が目で確かめる（quickstart §2）。明細は最大5行（FR-007）なので収まる

## R3. 請求書の案は保存しない。工数だけ保存する

- **Decision**: 案は `POST /invoices/drafts` が条件と工数から都度作って返す（純関数 `buildInvoiceDraft`）。画面が明細を直し、発行（`POST /invoices`）で明細の全体を送る。工数（`work_hours`）は保存する（月末に入力を分けられる）
- **Rationale**: 番号は発行で初めて付く（FR-008）。下書きの状態を持たないので、状態遷移が「発行済み → 取消」だけで済む（YAGNI）
- **Alternatives**: 下書きを `invoices` の状態として保存 → 番号のない行、下書きの削除の規則が要り、INV が複雑になる

## R4. 取引先の請求の条件は別表、敬称は 001 の列を使う

- **Decision**: `partner_billing_terms`（`partner_id` が PK・FK、1対1。data-model §1.2）を足す。敬称は既存の `partners.honorific` を使い、請求の条件の画面から 001 の `PATCH /partners/:id` で直す。宛名は `billing_name`（任意、既定は取引先名）
- **Rationale**: 取引先の多くは仕入先で、請求の条件を持たない。型ごとの条件（時間単価型は単価、月額定額型は月額）を CHECK で表すには別表が素直。001 の `Partner` 型・取込（002）・テストに影響しない
- **Alternatives**: `partners` に NULL 可の列を6つ足す → `Partner` 型と全テストの fixture に波及し、型ごとの CHECK が「請求しない取引先」の場合分けで読みにくくなる

## R5. 発行者の設定はテナントの DB の1行

- **Decision**: `invoice_settings`（`id = 1` の1行。data-model §1.1）。氏名・屋号・住所・連絡先・振込先・登録番号・消費税の表示・次の通し番号。バックアップに含まれる（テナントの DB）
- **発行の前提**: 氏名・住所・連絡先・振込先が空なら 422 `INVOICE_ISSUER_INCOMPLETE`（画面は設定へ案内）
- **Rationale**: 事業体ごとの設定（FR-003）。registry の `app_settings` は端末に結びつく設定でバックアップに含めない（004 R9）ので使わない

## R6. 請求番号と通し番号

- **Decision**: 番号 = `issueDate の YYYYMMDD` + `-` + `String(seq).padStart(3, "0")`（純関数 `formatInvoiceNo`。1000 以上は桁が増える）。`invoice_settings.next_seq` を、請求書・明細・売上の仕訳と**同じトランザクション**で読み、使い、+1 する。`invoices.seq` と `invoices.invoice_no` に UNIQUE。`next_seq` の変更は「発行済みの最大の `seq` 以下」を拒否する（ドメインで 422 `INVOICE_SEQ_TOO_LOW`、DB のトリガーでも止める。data-model §2）
- **Rationale**: 単一の接続・同期の better-sqlite3 で、1トランザクションの中の読み書きは直列になる。`seq` の UNIQUE が最後の砦（INV-31）
- **Alternatives**: `max(seq) + 1` で採番 → 利用者が引き継ぐ開始値（US4）を表せない

## R7. 金額の計算（整数だけ）

- **Decision**:
  - 工数は**半時間の整数**（`half_hours`、120.5 時間 → 241）で持つ。API の入力は時間の数値（`120.5`）で、Zod で「0 以上・0.5 の倍数」を検査して半時間に直す（FR-005）。0 時間の時間単価型は案を作らない
  - 明細の金額: 数量（`quantity_halves`、半単位の整数）と単価がともにあれば `floor(quantity_halves × unit_price / 2)`。どちらかがなければ利用者が入れた金額。明細の金額は正の整数（値引きの行は範囲外）。品名が空の行は送らない（FR-007）
  - 単価・月額は税込（spec の Assumptions）。「別記」の税額は**税率ごとに1回** `floor(税率ごとの税込の合計 × 税率 / (100 + 税率))`（INV-10 と同じ式、`computeInclusiveTax` を使う）。税抜の小計 = 税込 − 税額
  - 明細の税率は売上の計上日の税区分から決める（R10）。免税の期間は税率なし（対象外）
- **Rationale**: Constitution I（浮動小数を使わない）。明細ごとの切り捨て（spec の Edge Cases）と税率ごとに1回の切り捨て（FR-012）を両立する

## R8. 日付の純関数（支払期限・予定日）

- **Decision**: 日（`day`）は「1〜28 または 31（末日）」の整数で持つ（Zod と CHECK `day BETWEEN 1 AND 28 OR day = 31` で 29・30 を拒否）。**その月の末日を超えたら末日にする**（`clampDay(year, month, day)`。31 → 末日）。画面の選択肢は 1〜28 と「末日」（= 31）。支払期限 = `dueDate(targetMonth, monthsAfter, day)`（`monthsAfter` は 0〜12、既定 1・末日 = 翌月末）。定期仕訳の予定日 = `scheduledDate(month, day)`。どちらも `packages/domain/src/invoicing/due-date.ts`・`recurring/schedule.ts` の純関数（INV-36）
- **Rationale**: FR-002（D は 1〜28 または末日）と US3 の「31 日」→ 末日（Acceptance 3）を1つの表現で満たす

## R9. 発行・入金・取消のトランザクションと書く順序

- **Decision**: `InvoicingUnitOfWork.transaction(fn)` が同じ接続で `{ ledger: LedgerRepository, masters, invoicing: InvoicingStore }` を渡す（003 の `DrizzleClosingUnitOfWork` と同じ形）。001 の `createJournal`・`voidJournal` は**そのまま中で呼べる**（入れ子はセーブポイント）。ただし drizzle は `err` を返しても確定するので、ユースケースは次の順序を守る
  1. 読み取りと検査（状態、重複、残額、期間、設定）をすべて先に行い、違反は `err` で返す（まだ何も書いていない）
  2. 最初の書き込みは 001 の仕訳の関数（`createJournal` / `voidJournal`）。その `err` はそのまま返す（仕訳の関数は検査の後に書くので、何も残らない）
  3. 以降の書き込み（通し番号、請求書、明細、消し込み、記録）は失敗すると例外を投げ、全体を巻き戻す。ドメインの判断で失敗させたいときは `RollbackError`（`DomainError` を持つ）を投げ、ユースケースの外側で `err` に直す
- **最小の変更（001）**: `createJournal(deps, draft, options?: { source?: JournalSource })`（省略時 `manual`）。`voidJournal`・`correctJournal` に `options?: { linked?: boolean }`（R13）
- **Rationale**: 発行と仕訳の片方だけが残らない（FR-009、INV-32）。障害の注入のテスト（明細の保存で例外）で検証する

## R10. 仕訳の科目と税区分

- **Decision**:
  - 売上: 借方 売掛金（`1030`）1行（請求の税込合計）、貸方 売上高（`4010`）を**税区分ごとに1行**。全行に取引先。日付は売上の計上日、摘要は `請求書 <番号>`
  - 入金: 借方 入金先（利用者が選ぶ科目・補助科目）に入金額、手数料があれば借方 支払手数料（`5250`）、貸方 売掛金に入金額 + 手数料。全行に取引先。日付は入金日
  - 科目は**コードで引く**（定数 `INVOICING_ACCOUNT_CODES`）。見つからない・使用停止なら 001 の `ACCOUNT_NOT_FOUND` / `ACCOUNT_INACTIVE`
  - 税区分は明細ごとに省略可。省略なら 001 の `defaultTaxCategory`（計上日の設定。免税は `OUT_OF_SCOPE`、課税は `SALES_10`）。売上の貸方の行の `taxAmount`（`validateJournal` が INV-10 で計算）は請求書の税率ごとの税額と一致する（INV-30）
  - 消費税の表示: 設定が「別記」でも、計上日の課税区分が免税なら写しは「税込のみ」にする（免税事業者の請求書に消費税額を書かない。FR-013）
- **Rationale**: 科目の選択の設定を増やさない（YAGNI）。税区分ごとに1行にすると、仕訳の税額と請求書の税額が同じ式・同じ単位で求まる
- **Alternatives**: 発行者の設定に科目の ID を持つ → 設定の項目と画面が増える。必要になったら足す

## R11. 発行時点の写し

- **Decision**: `invoices` が宛名（`recipient_name`・`recipient_honorific`）、発行者（`issuer_json`: 氏名・屋号・住所・連絡先・振込先・登録番号）、`tax_display`、支払期限を列として持ち、明細は `invoice_items`。発行後は写しの列と明細を変えない（DB のトリガー。INV-38）。取消で書けるのは取消の列だけ
- **Rationale**: FR-010。設定や取引先の変更が発行済みの請求書に及ばない

## R12. 請求・入金の取消

- **Decision**: 理由は 001 の `checkReason`。請求書は入金の消し込み（取消でないもの）があれば 409 `INVOICE_HAS_PAYMENTS`（FR-014）
  - 元の仕訳の日付の期間が**未締め**: 001 の `voidJournal(…, { linked: true })`（ADR 0003）
  - **締め済み**: 今日（R22）付で、元の仕訳の貸借を逆にした訂正仕訳（`corrects_journal_id` = 元の仕訳、`source` は元と同じ、税区分は元の行の値）を `createJournal` で登録する。今日の期間がない・締め済みなら 001 の `OUT_OF_PERIOD` / `PERIOD_CLOSED`
  - 請求書・消し込みに `voided_at`・`void_reason`・`void_journal_id`（訂正仕訳。直接の取消なら NULL）を付ける。番号は再利用しない
- **Rationale**: FR-014・FR-021、US1 Acceptance 7・8。物理削除しない（Constitution I）

## R13. 請求・入金の仕訳を通常の訂正・取消から守る

- **Decision**: `source` が `invoice` / `payment` の仕訳は、001 の `PUT /journals/:id`・`POST /journals/:id/void` で 409 `JOURNAL_LINKED`（`details: { journalId, invoiceId, paymentId? }`。domain の関数は `journalId` だけを返し、server のルート層が `originOfJournal` で `invoiceId`・`paymentId` を補う）。請求・入金の取消（R12）だけが `{ linked: true }` で呼ぶ。訂正仕訳の起票でも、これらの仕訳を訂正元にできるのは `source` が同じ仕訳だけ（`checkCorrectsTarget` に条件を足す）。`recurring` の仕訳は通常の仕訳と同じく訂正・取消できる（FR-026）
- **Rationale**: 請求の合計と売上の仕訳の一致（SC-002、INV-30・34）を構造で守る
- **Alternatives**: 訂正を許して不一致を警告 → SC-002 を満たせない

## R14. 入金の消し込みと状態

- **Decision**: 消し込みの「充当額」= 入金額 + 手数料。`手数料を差額として扱う` を選ぶと、手数料 = 残額 − 入金額（> 0 のときだけ）。充当額の合計（取消でないもの）が請求の合計を超えたら 422 `PAYMENT_EXCEEDS_BALANCE`（FR-019）。入金額は正の整数
  - 状態は保存しない（取消だけ列で持つ）。`invoiceStatus(invoice, payments)` = `voided`（取消）/ `paid`（残額 0）/ `partial`（0 < 充当 < 合計）/ `unpaid`、と残額。期限切れは状態ではなく表示用の判定 `isOverdue(invoice, remaining, today)` = 残額 > 0 かつ `today > due_date`（FR-020）。状態・残額は US1 の一覧・詳細が使い、期限切れの判定は US2 で足す
- **Rationale**: 状態と残額を消し込みから導く（FR-020）。保存した状態と実際の食い違いが起きない

## R15. journals.source の追加

- **Decision**: `tenant.ts` の enum と domain の `JournalSource` 型に `invoice`・`payment`・`recurring` を足す（schema に `source` の定義はない）。DB には CHECK がないので、**列は作り直さず**、`--custom` のマイグレーションでトリガー（INSERT と `UPDATE OF source` で `source IN (...)` を検査）を足す
- **方針からの変更**: メインの方針は「CHECK の変更」だったが、既存の列に CHECK はない。SQLite で CHECK を足すには `journals` の作り直し（`journal_lines` などの FK、既存のトリガーとビューの作り直し）が要るため、トリガーで同じ保証を得る

## R16. 定期仕訳の定義

- **Decision**: `recurring_journals`（名前、摘要、`day_of_month`（1〜28 または 31 = 末日。R8）、`start_month`・`end_month`（`YYYY-MM`、終了は任意）、`status` = `active` / `paused`、`version`）と `recurring_journal_lines`（001 の `LineDraft` と同じ項目。税区分は省略可）。保存のときに 001 の `validateJournal` を開始月の予定日で通し、貸借の不一致などを拒否する（FR-023）。変更は `version` の楽観ロック（001 の `VERSION_CONFLICT`）
- **Rationale**: 登録した仕訳は定義の写しなので、定義の変更は未登録の回にだけ効く（FR-026）。税区分を省略すれば、各回の予定日の設定で決まる（FR-013 と同じ考え方）

## R17. どの回を登録するかは純関数

- **Decision**: `planRecurringRuns({ def, today, doneMonths, ctx })` → `{ post: { month, date, draft }[], blocked: { month, date, reason }[] }`（`recurring/due.ts`）
  - 対象の月: `start_month` 〜 `min(end_month, today の月)` のうち、`scheduledDate(month, day) <= today`、かつ `doneMonths`（登録済み・飛ばした月）にない月。`status = paused` なら空
  - 各月の仕訳の案を 001 の `validateJournal` と `checkPeriod` に通す。`PERIOD_CLOSED`・`OUT_OF_PERIOD`・`ACCOUNT_INACTIVE`・`ACCOUNT_NOT_FOUND`・取引先の使用停止（`PARTNER_INACTIVE`。001 の検証は取引先の使用停止を見ないので、この関数で足す）は `blocked` に入れて登録しない（FR-027）。`validateJournal` が返す `TAX_SETTING_GAP`・`TAX_METHOD_UNSUPPORTED`・補助科目の停止（`VALIDATION`）も、`blocked` の理由 `JOURNAL_INVALID`（元のエラーのコードを `details.code` に持つ）として扱う。これらを例外やエラーとして上に返すと、1つの回の不備で事業体の全定義の判定が止まるため
  - `blocked` は**保存しない**（判定のたびに計算する）。期間の締めの解除や科目の再開、消費税の設定の修正で、次の判定で自動で登録される。利用者が「この回は登録しない」を選んだ月（`blocked` の回と、まだ登録していない回）だけ `skipped` として保存する
- **Rationale**: 時刻と DB に依存しない関数にして、SC-004 を fast-check の操作列（任意の起動の日の列）で検証する（INV-35）

## R18. 判定を走らせる場所

- **Decision**: `apps/server/src/lib/recurring-scheduler.ts` の `startRecurringScheduler({ entities, openUnitOfWork, clock, intervalMs })`（backup-scheduler.ts と同じ形。既定の間隔 1 時間、`timer.unref()`、同時に1回だけ、例外は投げずにログ）。`startBackgroundServices` に足し、起動時に1回すぐ `tick` する。`tick` は registry の全事業体を順に開いて `postDueRecurring` を呼ぶ（1つの事業体の失敗で、ほかを止めない）
  - 定義の保存・再開の直後にも、その事業体だけ同じ関数を呼ぶ（利用者がすぐ結果を見られる）
- **Rationale**: FR-024。OS の常駐の仕組みは使わない（spec の Assumptions）。better-sqlite3 は同期なので、判定は要求の処理の間に割り込まない

## R19. 冪等性

- **Decision**: `recurring_runs` に UNIQUE（`recurring_id`, `target_month`）。1つの回ごとに1トランザクションで「`createJournal`（`source = recurring`）→ `recurring_runs` の挿入」。UNIQUE の違反は例外なので、仕訳も巻き戻る（R9 の順序）。登録した仕訳を利用者が取り消しても `recurring_runs` は残るので、再び登録されない
- **Rationale**: FR-025、INV-35。判定が重なっても（スケジューラーと保存の直後）、2件目は UNIQUE で落ちる

## R20. 停止と再開

- **Decision**: 停止は `status = paused`。再開は `fromMonth`（既定は今日の月）を受け取り、`start_month` を `max(start_month, fromMonth)` に進めて `active` にする。停止の間の未登録の回は登録しない。再開・保存で、今日以前に登録される回が1件以上あれば、件数を示して確認を求める（409 `RECURRING_CONFIRM_REQUIRED`、`details.count`・`months`。`confirm: true` で再送。002 の `CORRECTED_JOURNALS` と同じ形。FR-029）
- **Rationale**: 停止した期間の分を再開でまとめて登録するのは意外な結果になる。spec は停止の間の扱いを書いていない（未決として plan に記す）
- **Alternatives**: 再開で停止の間の分も登録 → 確認の件数で気づけるが、停止の意味が薄れる。停止の期間を表に持つ → 表が増える

## R21. 自動で登録した回の知らせ

- **Decision**: `recurring_runs.acknowledged_at`（NULL 可）。`GET /recurring-journals/status` が未確認の登録の回（件数と仕訳の一覧）と `blocked` の回を返し、web は事業体の画面の上部に知らせる。「確認した」で `acknowledged_at` を付ける（この列だけ更新できる。トリガー）
- **Rationale**: FR-028・US3 Acceptance 7。「前回開いた時刻」を端末ごとに持つより単純で、確かめるまで消えない

## R22. 今日の日付と時計

- **Decision**: `apps/server/src/lib/today.ts` の `todayOf(clock)` が `clock.now()` を server の動く Mac のローカルの暦日（`YYYY-MM-DD`、`Intl.DateTimeFormat` に既定のタイムゾーン）に直す。ドメインは `today: string` を受け取り、タイムゾーンを扱わない。請求・定期仕訳のルートは `invoicingRoutes({ clock })`・`recurringRoutes({ clock })` の関数にし、`createApp` の中で `tenantRoutes` を組み立てて `options.clock` を渡す（今は事業体のルートに `createApp` の clock が届かない）。スケジューラーは `main.ts` から `deps.ts` の `clock` を受け取る
- **Rationale**: 0 時〜9 時（UTC と日付がずれる時間）の判定の誤りを防ぐ。テストは偽の時計で「10 月 26 日に起動」を再現する（US3 の Independent Test）
- **注意**: server のテストは、偽の時計の時刻を日付の境目から離す（CI の `TZ` に依存させない）

## R23. 操作の記録

- **Decision**: `invoicing_audit_log`（003 の `closing_audit_log` と同じ形。追記のみ、トリガーで更新・削除を禁止）。対象は `invoice_settings`・`billing_terms`・`work_hours`・`invoice`・`payment`・`recurring_journal`・`recurring_run`、操作は `create`・`update`・`void`・`pause`・`resume`・`skip`・`acknowledge`（data-model §1.10 と同じ）。追記は `InvoicingStore.appendInvoicingAudit` と `RecurringStore.appendRecurringAudit`。仕訳そのものの記録は 001 の `audit_log`（`createJournal`・`voidJournal` が書く）
- **Rationale**: FR-032。001 の `audit_log` の `target_type` の CHECK を広げるには表の作り直しが要る（R15 と同じ理由で避ける）

## R24. エラーコードと警告

- **Decision**: 14種を足す（contracts/http-api.md §1）。既存の `VALIDATION`・`PERIOD_CLOSED`・`OUT_OF_PERIOD`・`REASON_REQUIRED`・`VERSION_CONFLICT`・`ACCOUNT_*` を再利用する。確認つきの操作は 409 と `confirm` フラグ（002 の `CORRECTED_JOURNALS`）。警告は 001 の `warnings` の形（`INVOICE_DUPLICATE_MONTH` を案に付ける）

## R25. 不変条件とテスト

- **Decision**: data-model §4 の INV-30〜39 を fast-check で書く（`fc.assert(fc.property(...))`。001 research R6）。ジェネレーターは `packages/domain/test/invoicing-arbitraries.ts`（条件・工数・明細・入金の操作列）と `recurring-arbitraries.ts`（定義・起動の日の列・締め）。db は一時のデータ場所（`useTempDataDir`）でトリガー・UNIQUE・障害の注入を確かめる。domain の偽物は `test/fakes.ts` に `FakeInvoicingUnitOfWork`・`FakeRecurringUnitOfWork` を足す（003 の `fake-closing-unit-of-work` と同じ形。セーブポイントと例外での巻き戻しを再現する）
- **E2E**: 請求の発行 → 印刷の画面 → 入金の消し込みの1本（利用者の端末。004 の仮想の認証器の手順を使う）

## R26. 家事按分と範囲外

- 家事按分は 003 のまま（FR-030）。定期仕訳は按分前の全額で登録する
- 範囲外: 源泉徴収、請求書の送付、既存の請求書の取込、銀行の明細の取込（006）、年払いの定期仕訳、性能の計測（件数が小さい。SC-001 は利用者の操作の時間）
