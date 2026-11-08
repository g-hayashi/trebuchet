# Data Model: デモ事業の作成（014）

## 1. registry `entities`（変更）

| 列 | 型 | 変更 | 説明 |
|---|---|---|---|
| `status` | TEXT | 値に `preparing` を足す（`active`・`archived`・`deleting`・`preparing`） | デモの投入中。一覧・取得・バックアップの対象外（R2） |
| `is_demo` | INTEGER（0/1）NOT NULL DEFAULT 0 | 追加 | デモ事業の印（R3）。作成後に変えない |

- マイグレーションは `drizzle-kit generate`（`packages/db/drizzle/registry/`）。`status` の CHECK を変えるため表の作り直しになる場合は、生成の後に `) STRICT;` へ置き換える（AGENTS.md）。
- バックアップ: `preparing` の行と、そのテナントのファイルはバックアップに含めない（snapshot の対象を `active`・`archived` に限る）。`is_demo` はそのまま写す。

## 2. 型（domain・schema）

- `EntitySummary`（`packages/domain/src/types.ts:83`）に `demo: boolean` を足す。`EntityProfile` も継ぐ。
- `EntityStatus` に `"preparing"` を足す。`createEntity` の入力に `status?: "active" | "preparing" | undefined` と `demo?: boolean | undefined` を足す（既定は `active`・`false`。通常の作成のルートからは渡さない）。
- registry のポートに `activateEntity(id)`（`preparing` → `active`）と `listPreparingEntities()` を足す。

## 3. デモの計画（`buildDemoPlan(today)` の出力。純粋なデータ）

| 項目 | 内容 |
|---|---|
| `fiscalYear` | 作成日の月が 3 以上なら作成日の年、1・2 なら前の年（R5） |
| `name` | 既定「デモ事業（サンプル）」。`active`・`archived` に同名があれば「デモ事業（サンプル 2）」… |
| `openingBalances` | 現金・普通預金・元入金（貸借一致） |
| `subAccounts` | 普通預金の銀行 2 つ |
| `partners` | 3 件。1 件は源泉徴収あり（013）、時間単価の請求条件を持つ |
| `journals` | 年度内の月・日・摘要・明細行。作成日より後は含めない。訂正・取消の対象を各 1 件指す |
| `homeUse` | 地代家賃・水道光熱費・通信費の事業専用割合 |
| `fixedAssets` | 定額法・少額の特例（仕訳に結びつける）・一括償却資産を各 1 件 |
| `deferredAssets` | 開業費 1 件 |
| `recurring` | 家賃の毎月の定期仕訳。開始は年度の 1 月、期日の分を計上 |
| `invoicing` | 請求設定、工数（月ごと）、発行する請求書 2 件（1 件は入金・源泉徴収あり、1 件は未入金） |
| `receipts` | 素材のキー（`receipt-01` など）・日付・金額・取引先・結びつける仕訳 |
| `statement` | CSV の文字列と列の対応（未処理のまま残す） |

- 金額はすべて整数（`0 < amount < 1e12`）。各仕訳は借方合計 = 貸方合計。
- 日付は `dates.ts` の関数で作る。

## 4. 不変条件（`specs/INVARIANTS.md` に足す）

- **INV-76**: 任意の作成日 `today`（2000〜2100 年の任意の日）について、`buildDemoPlan(today)` のすべての日付（仕訳・期首を除く取引・請求書の発行・入金・工数の月末・証憑・明細・資産の取得）は `today` 以下で、`fiscalYear` の年に収まり、spec US1 の 3 の 11 種がそれぞれ 1 件以上ある。各仕訳の借方合計 = 貸方合計
- **INV-77**: デモの作成は全部か無か。途中のどの段階で失敗させても、作成後の registry に `preparing` の行も新しい `active` の行も残らず、そのテナントの DB ファイル・証憑のディレクトリも残らない。成功したときは、`is_demo = 1` の `active` の行がちょうど 1 つ増える

## 5. 状態の遷移（registry `entities.status`）

```
（なし）──createDemoEntity──▶ preparing ──投入がすべて成功──▶ active ──archive──▶ archived ──purge──▶（なし）
                                  │
                                  └─投入の失敗・起動時の残り──▶ purgeEntityData ──▶（なし）
```

通常の作成は従来どおり `（なし）→ active`。
