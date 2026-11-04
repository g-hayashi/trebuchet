# 請求と定期仕訳（005）

仕様: `specs/005-recurring-invoicing/`。請求・入金と仕訳の結びつき、トランザクション、取消の規則: [ADR 0008](../adr/0008-invoice-journal-linkage.md)。

| 層 | 場所 |
|---|---|
| 業務ルール（請求の金額と税、請求番号、支払期限、状態、仕訳の案、定期仕訳の予定日と登録する回の選び方） | `packages/domain/src/invoicing/`（`amounts.ts`、`tax.ts`、`number.ts`、`due-date.ts`、`status.ts`、`draft.ts`、`detail.ts`、`journal-drafts.ts`）、`packages/domain/src/recurring/`（`due.ts`。予定日・月の計算は `dates.ts`） |
| ユースケース | `packages/domain/src/usecases/invoicing.ts`、`recurring.ts` |
| 永続化（設定・条件・工数・請求書・消し込み・定期仕訳・操作の記録） | `packages/db/src/invoicing-repository.ts`、`recurring-repository.ts` |
| HTTP | `apps/server/src/routes/invoicing.ts`、`recurring.ts` |
| server の部品 | `apps/server/src/lib/today.ts`（`todayOf`）、`recurring-scheduler.ts` |
| 画面 | `apps/web/src/features/invoicing/`、`features/recurring/`、`apps/web/src/routes/e/$entityId/` の `invoice-settings.tsx`・`work-hours.tsx`・`invoices/`・`recurring/` |
| E2E | `apps/web/e2e/invoicing.spec.ts`（対象月・発行日・入金日は固定の日付で、実行日に依存しない） |

- **発行・入金・取消は 1 つの `InvoicingUnitOfWork` の中で書く**（ADR 0008）。複数回書くユースケースの一般の規則（AGENTS.md の「開発の進め方」）のとおり、`err` を返せば仕訳も請求の記録も巻き戻る。
- **請求書・入金の仕訳は `JOURNAL_LINKED` で守る**（005/R13）。`source` が `invoice` / `payment` の仕訳は、001 の通常の訂正・取消を 409 で拒否する。請求・入金の取消だけが `{ linked: true }` で仕訳を取り消す。`recurring` の仕訳は通常どおり訂正・取消できる。消し込みのある請求書は取消せない（`INVOICE_HAS_PAYMENTS`）。
- **請求書は発行時の写しを持つ**。写しの列と明細は DB のトリガーで更新を止め、取消で書けるのは取消の列だけ。物理削除しない。
- **「今日」は `today: string`（`YYYY-MM-DD`）で domain に渡す**。server は `todayOf(clock)` で作る（005/R22）。ルートは `invoicingRoutes({ clock })`・`recurringRoutes({ clock })`（ほかのルートも同じ形）。server のテストは偽の時計を渡し、時刻を日付の境目から離す。
- **仕訳の科目はコードで引く**（005/R10）。定数 `INVOICING_ACCOUNT_CODES`（`journal-drafts.ts`）が売掛金・売上高・支払手数料のコードを持つ。科目の選択の設定は増やさない。
- **工数は半時間の整数**、明細の金額は `Math.floor(quantityHalves * unitPrice / 2)`。請求の `priceMode` は税込/税抜入力を表し、内訳表示 `taxDisplay` と分ける。税込の内訳は `computeInclusiveTax`、税抜の加算は税率ごとの小計に対し一度だけ切り捨てる（005/R27）。免税でも消費税相当額を請求でき、帳簿は加算後の全額を対象外の売上とする。
- 請求・入金の操作は `invoicing_audit_log`（追記のみ）に記録する。仕訳そのものの記録は 001 の `audit_log`。

