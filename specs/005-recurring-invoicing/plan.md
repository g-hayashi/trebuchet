# Implementation Plan: 定期仕訳と工数・請求（日常業務）

**Branch**: `005-recurring-invoicing` | **Date**: 2026-10-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-recurring-invoicing/spec.md`

## Summary

取引先ごとの請求の条件（時間単価型・月額定額型、支払期限の規則）と、事業体の発行者の設定を持ち、月末に入れた工数（半時間の整数）から請求書の案を純関数で作る（research R3〜R8）。発行で、通し番号を進め、発行時点の写しを持つ請求書・明細と、売掛金／売上高の仕訳を1つのトランザクションで登録する（R6・R9〜R11）。請求書は印刷用の画面とブラウザの「PDF に保存」で出す（依存を足さない。R2）。入金の消し込みは手数料の差額を含む複合仕訳を登録し、状態と残額は消し込みから導く（R14）。取消は 001 の規則（未締めは取消、締め済みは当年度の訂正仕訳）に従い、請求・入金の仕訳は通常の訂正・取消から守る（R12・R13）。定期仕訳は、どの回を登録するかを純関数で決め、server の起動時と1時間ごとに全事業体で判定し、「定期仕訳 × 対象月」の UNIQUE と同じトランザクションで重複を防ぐ（R16〜R21）。

## Technical Context

**Language/Version**: TypeScript 7.0（`strict: true`, ESM）、Node.js 26.9（型の除去で直接実行）

**Primary Dependencies**: 追加なし。既存の Hono、Drizzle ＋ better-sqlite3、Zod、React ＋ TanStack Router、Vitest ＋ fast-check、Playwright

**Storage**: 事業体の DB（tenant）に 10 表（data-model §1）。マイグレーション `packages/db/drizzle/tenant/0005_invoicing.sql`（STRICT に置き換え）と `0006_invoicing_integrity.sql`（`--custom`、トリガー。data-model §2）。`journals` は作り直さず、`source` の値をトリガーで検査する（R15）。registry は変えない。バックアップは tenant の DB ごと含まれる（004 のアプリの版の数が 1 つ増える）

**Testing**: Vitest ＋ fast-check（INV-30〜39。`fc.assert(fc.property(...))` を直接）、一時のデータ場所での db のテスト（トリガー・UNIQUE・障害の注入）、Hono の `app.request()`（`createTestSession`・`testHeaders`、偽の時計）、Testing Library ＋ jsdom、Playwright（発行 → 印刷 → 消し込みの1本。利用者の端末）

**Target Platform**: macOS（Apple Silicon）上のローカル Web アプリ（`http://localhost:5173`）

**Project Type**: Web アプリケーション（pnpm monorepo の既存のパッケージに追加）

**Performance Goals**: 特になし（請求は月に 10 件前後、定期仕訳は月に数件）。SC-001（8 社で 15 分以内）は利用者の操作の時間で確かめる

**Constraints**: 金額・工数は整数（浮動小数を使わない。R7）。発行と仕訳、消し込みと仕訳、定期仕訳の回と仕訳は全部か無か（R9・R19）。drizzle のトランザクションは `err` を返しても確定するので、最初の書き込みを 001 の仕訳の関数にし、以降の失敗は例外で巻き戻す（R9）。「今日」は Mac のローカルの暦日（R22）。実データを読まない・書かない

**Scale/Scope**: 取引先 10 社前後、請求書 約 100 件/年、定期仕訳 10 件前後、事業体は数個

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | ✅ | 金額・工数は整数（R7）。仕訳はすべて 001 の `createJournal`・`voidJournal` を通る（貸借の一致、締め済みの年度は訂正仕訳。R9・R12）。請求の合計と仕訳の一致、売掛金と未回収の一致、番号の一意、定期仕訳の重複なしを INV-30〜35 の性質テストで検証する。請求・入金・回は物理削除しない（トリガー） |
| II. 監査可能性 | ✅ | 請求・入金・定期仕訳の操作を追記のみの `invoicing_audit_log` に残す（R23）。仕訳の変更は 001 の `audit_log`。仕訳と請求書・入金・定期仕訳は相互に参照できる（契約 §6）。発行後の写しは変えない（INV-38） |
| III. ローカルファーストとプライバシー | ✅ | 設定・請求書はテナントの DB（バックアップに含まれる）。PDF はブラウザの印刷で Mac の中に保存し、外部のサービスに送らない（R2）。テストは合成のデータだけ |
| IV. AIは提案 | N/A | AI は使わない |
| V. テストファースト | ✅ | 純関数（金額、税額、期限、番号、回の計画）と INV-30〜39 を先に書く。障害の注入で全部か無かを確かめる（R25） |
| VI. 税制ルールはデータ | ✅ | 税率は 001 の `tax_rates`、課税区分は事業体 × 期間の `consumption_tax_settings` から計上日で決める（R10）。新しい税制の値は足さない。端数の扱い（税率ごとに1回の切り捨て）は INV-10 と同じ式 |
| VII. シンプルさと境界 | ✅ | 依存を足さない（PDF はブラウザの印刷。R2）。案・状態・`blocked` の回を保存しない（R3・R14・R17）。科目はコードで引き、設定を増やさない（R10）。判定と計算は domain の純関数、トランザクションは db の UnitOfWork、タイマーは server |

**Post-design re-check（Phase 1 後）**: ✅ 違反なし。001 の仕訳のユースケースへの変更は、省略可の引数の追加（`source`、`linked`）と訂正元の条件の追加にとどめる（R9・R13）。

## Project Structure

### Documentation (this feature)

```text
specs/005-recurring-invoicing/
├── plan.md              # 本ファイル
├── research.md          # Phase 0（R1〜R26）
├── data-model.md        # Phase 1（tenant の10表、トリガー、状態遷移、INV-30〜39、関数とポートの名前）
├── quickstart.md        # Phase 1
├── contracts/
│   └── http-api.md      # §1 エラーコード14種、§2〜§6 のエンドポイント
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks で作成
```

### Source Code (repository root)

```text
packages/
├── schema/src/
│   ├── invoicing.ts               # InvoiceSettings, BillingTerms, WorkHours, InvoiceDraft, InvoiceInput, InvoiceDetail, PaymentInput など（契約 §2〜§4、§6）
│   ├── recurring.ts               # RecurringInput, RecurringView, BlockedRun など（契約 §5）
│   └── errors.ts                  # エラーコード14種（契約 §1）
├── domain/src/
│   ├── invoicing/                 # amounts.ts（itemAmount, taxBreakdown）、due-date.ts（clampDay, dueDate）、number.ts（formatInvoiceNo）、draft.ts（buildInvoiceDraft）、journal-drafts.ts（invoiceJournalDraft, paymentJournalDraft, reversalDraft）、status.ts（invoiceStatus）
│   ├── recurring/                 # schedule.ts（scheduledDate）、due.ts（planRecurringRuns）
│   ├── usecases/invoicing.ts      # 設定・条件・工数・案・発行・取消・消し込み・一覧（data-model §5）
│   ├── usecases/recurring.ts      # 作成・変更・停止・再開・飛ばす・postDueRecurring・status・acknowledge
│   ├── usecases/create-journal.ts # options.source、checkCorrectsTarget の source の条件（R9・R13）
│   ├── usecases/void-journal.ts / correct-journal.ts / journal-edit.ts  # options.linked、JOURNAL_LINKED（R13）
│   ├── types.ts                   # JournalSource、請求・定期仕訳の型
│   └── ports.ts                   # InvoicingStore, InvoicingUnitOfWork, RecurringStore, RecurringUnitOfWork
├── domain/test/
│   ├── invoicing/*.test.ts, invoicing-*.property.test.ts, recurring-*.property.test.ts
│   ├── invoicing-arbitraries.ts, recurring-arbitraries.ts
│   └── fakes.ts                   # FakeInvoicingUnitOfWork, FakeRecurringUnitOfWork
├── db/
│   ├── src/schema/tenant.ts       # 10表、journals.source の enum
│   ├── src/invoicing-repository.ts  # DrizzleInvoicingStore, DrizzleInvoicingUnitOfWork
│   ├── src/recurring-repository.ts  # DrizzleRecurringStore, DrizzleRecurringUnitOfWork
│   ├── drizzle/tenant/0005_invoicing.sql, 0006_invoicing_integrity.sql
│   └── test/invoicing-*.test.ts, recurring-*.test.ts
apps/
├── server/src/
│   ├── routes/invoicing.ts        # invoicingRoutes({ clock })（契約 §2〜§4、§6）
│   ├── routes/recurring.ts        # recurringRoutes({ clock })（契約 §5）
│   ├── routes/journals.ts         # JOURNAL_LINKED の変換（エラーの表）
│   ├── lib/today.ts               # todayOf(clock)（R22）
│   ├── lib/recurring-scheduler.ts # 起動時と1時間ごとの判定（R18）
│   ├── lib/startup.ts             # startBackgroundServices に定期仕訳を足す
│   ├── app.ts                     # tenantRoutes を createApp の中で組み立て、clock を渡す
│   ├── deps.ts                    # invoicingDeps, recurringDeps
│   └── errors.ts                  # ERROR_STATUS に14種
└── web/src/
    ├── features/invoicing/        # BillingTermsForm, IssuerSettingsForm, WorkHoursTable, InvoiceDraftList, InvoiceDraftEditor, InvoiceList, InvoiceDetail, InvoicePrint, print.css, PaymentForm, api.ts
    ├── features/recurring/        # RecurringList, RecurringForm, RecurringNotice（自動の登録と blocked の知らせ）, api.ts
    └── routes/e/$entityId/        # journals/ の仕訳の詳細に出所（契約 §6）へのリンク、invoices/{index,new,$invoiceId,$invoiceId.print}.tsx, work-hours.tsx, invoice-settings.tsx, recurring/{index,new,$recurringId}.tsx, partners.tsx（請求の条件）
apps/web/e2e/invoicing.spec.ts     # 発行 → 印刷 → 消し込み
```

**Structure Decision**: 依存の向き（`apps/server → packages/db → packages/domain → packages/schema`、`apps/web → packages/schema`）を変えない。計算と判定（金額、税額、期限、番号、状態、回の計画）は domain の純関数、トランザクション（仕訳と請求・回の記録を同じ接続で）は db の UnitOfWork（003 の `DrizzleClosingUnitOfWork` と同じ形）、今日の日付とタイマーは server に置く。

## Phase の進め方（tasks への入力）

1. **Setup**: なし（依存の追加なし）。AGENTS.md に「請求と定期仕訳（005）」の表を足すのは Polish
2. **Foundational**: Zod スキーマとエラーコード14種、`JournalSource` の追加、tenant の 0005（10表、STRICT）と 0006（トリガー）、ポートと偽物の UnitOfWork、001 の変更（`createJournal` の `source`、`JOURNAL_LINKED`。R9・R13）、`todayOf` と `createApp` の clock の配線（R22）
3. **US4**（設定・条件・期限・番号の純関数）→ **US1**（工数、案、発行、写し、印刷、取消）→ **US2**（消し込み、手数料、状態、一覧、取消）→ **US3**（定義、回の計画、スケジューラー、知らせ）
4. 各ストーリーで「性質／ユニットテスト → domain → db → server → web」の順。INV は US4: INV-36・37、US1: INV-30・31・32・38・39、US2: INV-33・34、US3: INV-35
5. **Polish**: E2E（発行 → 印刷 → 消し込み）、AGENTS.md の更新（005 の層の表）、ADR 0008（請求と仕訳の結びつけ方: 請求・入金の仕訳の保護と取消の規則）、quickstart の手動確認（利用者の端末、SC-001・SC-005）、最終の全体検証

## 決定事項（2026-10-24、利用者が tasks に進めた）

- 停止の間の回は、再開で登録しない（R20）。spec は書いていない
- 免税の期間は、設定が「別記」でも請求書の写しを「税込のみ」にする（R10）
- 明細の金額は正の整数だけ（値引きの行は範囲外。R7）

## Complexity Tracking

違反なし（依存の追加なし）。
