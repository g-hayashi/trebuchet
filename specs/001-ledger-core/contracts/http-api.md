# Contract: HTTP API（001-ledger-core）

- ベースパス: `/api`
- 形式: JSON（UTF-8）。CSV 出力のみ `text/csv; charset=utf-8`（BOM 付き, Excel 互換）
- テナントの指定: パスに `/entities/:entityId` を含める。サーバーは `entityId` から該当の DB ファイルだけを開く
- 入出力のスキーマは `packages/schema` の Zod 定義が正本。このファイルはその要約
- クライアントは Hono RPC（`hc<AppType>`）で型を共有する（[research.md](../research.md) R3）
- 認証は 003 で追加する。001 ではローカルホストからのアクセスのみ受け付ける

## エラー形式

```json
{ "error": { "code": "UNBALANCED", "message": "借方と貸方が一致しません", "details": { "debit": 500000, "credit": 495000, "diff": 5000 } } }
```

| HTTP | code | 発生条件 | 要件 |
|---|---|---|---|
| 400 | `VALIDATION` | スキーマ違反（金額が整数でない、必須項目なし） | FR-013, FR-014 |
| 422 | `UNBALANCED` | 借方合計 ≠ 貸方合計 | FR-015 |
| 422 | `ACCOUNT_INACTIVE` / `ACCOUNT_NOT_FOUND` | 使用停止・存在しない科目 | FR-015 |
| 422 | `OUT_OF_PERIOD` | 日付に対応する会計期間がない | FR-015 |
| 409 | `PERIOD_CLOSED` | 締め済み年度への登録・訂正・取消。`details.suggest = "correcting_entry"` | FR-015, FR-019a, FR-024 |
| 422 | `REASON_REQUIRED` | 理由のない訂正・取消・締めの解除 | FR-019, FR-024 |
| 409 | `VERSION_CONFLICT` | 楽観ロックの不一致 | — |
| 409 | `ACCOUNT_IN_USE` | 使用中の科目の削除 | FR-005 |
| 422 | `TAX_SETTING_GAP` | 消費税の設定期間の空白・重複 | FR-009 |
| 404 | `ENTITY_NOT_FOUND` | 事業体がない | FR-002 |

成功時の警告（登録は成功）は `warnings: [{ code: "POSSIBLE_DUPLICATE" }]` で返す（FR-018）。

## 事業体

| メソッド | パス | 説明 | 要件 |
|---|---|---|---|
| GET | `/entities` | 事業体の一覧 | FR-003 |
| POST | `/entities` | `{ name, kind, fiscalStartMonth, firstFiscalYear }` → 作成し、初期の勘定科目・会計期間・消費税の設定（免税・税込）を投入 | FR-001, FR-004 |
| PATCH | `/entities/:entityId` | 名称の変更 | FR-001 |

## マスタ

| メソッド | パス | 説明 | 要件 |
|---|---|---|---|
| GET / POST | `/entities/:id/accounts` | 科目の一覧・追加 | FR-004, FR-005 |
| PATCH | `/entities/:id/accounts/:accountId` | `{ name?, isActive? }` | FR-005 |
| DELETE | `/entities/:id/accounts/:accountId` | 未使用のときのみ | FR-005 |
| GET / POST | `/entities/:id/accounts/:accountId/sub-accounts` | 補助科目 | FR-006 |
| GET / POST / PATCH | `/entities/:id/partners[/:partnerId]` | 取引先 | FR-007 |
| GET / POST | `/entities/:id/tags` | メモタグ | FR-008 |
| GET | `/entities/:id/tax-categories` | 税区分の一覧 | FR-010 |
| GET / PUT | `/entities/:id/tax-settings` | 消費税の設定の一覧・一括置換 | FR-009 |

## 会計期間・期首残高

| メソッド | パス | 説明 | 要件 |
|---|---|---|---|
| GET / POST | `/entities/:id/fiscal-periods` | 一覧・翌年度の作成 | FR-012 |
| POST | `/entities/:id/fiscal-periods/:year/close` | 締め | FR-024 |
| POST | `/entities/:id/fiscal-periods/:year/reopen` | `{ reason }` 締めの解除 | FR-024, FR-025 |
| GET / PUT | `/entities/:id/fiscal-periods/:year/opening-balances` | 期首残高の取得・一括置換（貸借一致が必須） | FR-011 |

## 仕訳

### 入力スキーマ（JournalInput）

```ts
{
  date: "2026-10-31",            // YYYY-MM-DD
  memo?: string,
  correctsJournalId?: string,    // 締め済み年度の仕訳への訂正仕訳のとき
  lines: Array<{
    side: "debit" | "credit",
    accountId: string,
    subAccountId?: string,
    amount: number,              // 正の整数, < 1e12
    taxCategory?: TaxCategoryCode, // 省略時は日付の消費税の設定から既定値
    partnerId?: string,
    description?: string,
    tagIds?: string[]
  }>                             // 2行以上、借方・貸方とも1行以上
}
```

| メソッド | パス | 説明 | 要件 |
|---|---|---|---|
| POST | `/entities/:id/journals` | JournalInput → `{ journal, warnings }` | FR-013〜018 |
| GET | `/entities/:id/journals/:journalId` | 仕訳と行、訂正元・訂正仕訳への参照 | FR-019a |
| PUT | `/entities/:id/journals/:journalId` | `{ ...JournalInput, reason, version }` 訂正 | FR-019, FR-020 |
| POST | `/entities/:id/journals/:journalId/void` | `{ reason, version }` 取消 | FR-019, FR-021 |
| GET | `/entities/:id/journals/:journalId/history` | 変更履歴（変更前後・日時・理由） | FR-020, SC-005 |
| GET | `/entities/:id/journals?…` | 検索（下記） | FR-023 |

検索パラメータ: `dateFrom`, `dateTo`, `amountMin`, `amountMax`, `partnerId`, `accountId`, `q`（摘要・メモの部分一致）, `tagId`, `includeVoided`（既定 false）, `cursor`, `limit`。金額の範囲は、仕訳のいずれかの行の金額が範囲に入れば一致とする。

## 帳票

すべて `?format=csv` で CSV を返す（FR-032）。

| メソッド | パス | パラメータ | 要件 |
|---|---|---|---|
| GET | `/entities/:id/reports/journal-book` | `from`, `to` | FR-026 |
| GET | `/entities/:id/reports/general-ledger` | `from`, `to`, `accountId`, `subAccountId?` | FR-027 |
| GET | `/entities/:id/reports/trial-balance` | `from`, `to` | FR-028 |
| GET | `/entities/:id/reports/profit-and-loss` | `from`, `to`, `compare=previous-year?` | FR-029, FR-030 |
| GET | `/entities/:id/reports/balance-sheet` | `asOf`, `compare=previous-year?` | FR-029, FR-030 |

各帳票のレスポンスには `warnings`（例: `NEGATIVE_BALANCE` で科目と金額, `OPENING_BALANCE_MISSING`）を含める（FR-033, Edge Cases）。
