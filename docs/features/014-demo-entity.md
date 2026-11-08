# デモ事業（014）

仕様: `specs/014-demo-entity/`。事業体の一覧が空のとき、利用者が「デモ事業を作って試す」を押すと、架空のデータの事業体を 1 つ作る。自動では作らない。

| 層 | 場所 |
|---|---|
| 計画（純粋なデータ。`buildDemoPlan(today)`。年度、期首残高、取引先、仕訳、家事按分、資産、請求、証憑、明細） | `packages/domain/src/demo/plan.ts` |
| ユースケース（`createDemoEntity`、後片づけ `cleanupDemoLeftovers`。既存のユースケースを順に呼ぶ） | `packages/domain/src/usecases/demo-entity.ts` |
| 永続化（`entities.is_demo`、`status = 'preparing'`） | `packages/db/src/schema/registry.ts`、`packages/db/src/registry-repository.ts`、`packages/db/drizzle/registry/0005_demo_entity.sql` |
| 素材（証憑の合成の画像）の読み取り | `apps/server/src/demo-assets.ts`、素材は `apps/server/assets/demo/` |
| HTTP | `apps/server/src/routes/entities.ts`（`POST /entities/demo`） |
| 起動時の後片づけ（解錠の後に `cleanupDemoLeftovers`） | `apps/server/src/main.ts` |
| 画面 | `apps/web/src/components/layout/DemoBanner.tsx`（全画面の帯）、`apps/web/src/features/entities/EntityListPage.tsx`（空の一覧のボタン、「デモ」の印）、`apps/web/src/features/invoicing/InvoicePrint.tsx`（印刷の「デモ（架空のデータ）」） |

- **AI を呼ばない**。`fm`・外部の AI・`ReceiptReader` は使わない。証憑は画像を取り込むだけで、読み取りはしない。明細は計画の行をそのまま取り込む。
- **テストのフィクスチャを実行時に読まない**（FR-006）。証憑の画像は製品に同梱する合成の素材 `apps/server/assets/demo/` だけを読む。素材を足すときは `demo-assets.ts` の `FILES` と `DemoPlan.receipts[].asset` のキーを合わせる。知らないキーは例外になり、`DEMO_FAILED` で作成が失敗する。実データ（`work/`）の画像は使わない。
- **全部か無か**（INV-77）。投入の間、事業体は `status = 'preparing'`。一覧・取得・バックアップの対象外。成功すると `activateEntity` で `active` にする。失敗したときは、テナントの DB ファイルと証憑のディレクトリと registry の行を消す。消す途中で落ちたものは、次の解錠の後の `cleanupDemoLeftovers`（`listPreparingEntities`）が片づける。
- **日付は作成日以下で、年度に収まる**（INV-76）。作成日の月が 3 以上なら作成日の年、1〜2 月は前の年を年度にする。作成日より後の日付（仕訳・請求書の発行・入金・工数の月末・証憑・明細・資産の取得）を作らない。
- **既存のユースケースを迂回しない**。仕訳は `createJournal`・`correctJournal`・`voidJournal`、請求は `issueInvoice`・`recordPayment` など、通常の経路で書く。リポジトリへ直接書き込まない。そのため源泉徴収・按分・資産の不変条件は通常と同じに保たれる。
- **名前**は既定「デモ事業（サンプル）」。`active`・`archived` に同名があれば「デモ事業（サンプル 2）」のように番号を付ける。`is_demo` は作成後に変えない。
- **決算整理の登録と締めはデータに含めない**。利用者が試す。
- **消し方**は既存の経路だけ。一覧で「非表示にする」→「非表示の組織」から「完全に削除」（`packages/domain/src/usecases/entity-lifecycle.ts`）。デモ専用の削除は作らない。
- 作れるのは `active`・`preparing` の事業体が 0 件のときだけ（非表示の事業体は数えない）。事業体があるとき、または作成中に再度呼ぶと `DEMO_NOT_AVAILABLE` で拒む（同時に 2 つ作らない）。
- 利用者の操作・表示を変えたら、`entities` の記事を更新して `pnpm manual:check` を通す（AGENTS.md のマニュアルの規則）。
