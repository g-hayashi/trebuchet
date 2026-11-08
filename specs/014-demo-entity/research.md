# Research: デモ事業の作成（014）

調査の根拠は既存のコード（ファイル:行は 2026-11-08 時点）と、開発用に作った未コミットの `scripts/lib/demo-seed.ts`（以下「試作」）。

## R1. 組み立ての置き場所: domain のユースケースが既存のユースケースを順に呼ぶ

- **Decision**: `packages/domain/src/usecases/demo-entity.ts` に `createDemoEntity(deps, input)` を置き、既存のユースケース（createEntity、replaceOpeningBalances、addSubAccount、upsertPartner、createJournal、correctJournal、voidJournal、saveHomeUseAllocation、saveFixedAsset、saveDeferredAsset、createRecurring、postDueRecurring、saveInvoiceSettings、saveBillingTerms、saveWorkHours、draftInvoices、issueInvoice、recordPayment、addReceipt、linkReceipt、明細の取込の確定）を順に呼ぶ。データの定義は純関数 `buildDemoPlan(today)`（`packages/domain/src/demo/plan.ts`）。server は deps を組み立てるだけ（`apps/server/src/deps.ts` の既存の `masterDeps`・`journalDeps`・`invoicingDeps`・`recurringDeps`・`closingSettingsDeps`・`receiptDeps`・`statementDeps` を再利用）。
- **Rationale**: 業務ルール・監査の記録を既存の経路で通す（FR-004）。AGENTS.md の「server に業務ルールを書かない」「domain は純粋」を守る。試作は in-process の HTTP（`app.request`）で同じことをしたが、製品の中でセッションを発行して自分の API を呼ぶのは認証の迂回に近く、採らない。
- **Alternatives**: (a) server のルートで HTTP を内部呼び出し — 上の理由で却下。(b) 1 つの UnitOfWork でまとめて書く — 各ユースケースが自分の UoW・transaction を run し、入れ子を禁じている（AGENTS.md）ため不可。(c) SQL で直接投入 — 監査・不変条件の経路を迂回するため却下（憲法 I・II）。

## R2. 全部か無か: 「準備中」の登録と、失敗時の完全削除

- **Decision**: registry の `entities.status` に `preparing` を足す。`createEntity` に `status: "preparing"` を渡せるようにし、デモはその状態で作ってから投入する。全部が成功したら `active` にする。途中で `err` か例外が出たら、`purgeEntityData`（`removeTenantData`: tenant DB・証憑のディレクトリ・registry の行。`packages/db/src/tenant-store.ts:318`）で消して `DEMO_FAILED` を返す。起動時（解錠の後）に `preparing` が残っていれば同じく消す（途中でプロセスが落ちた場合）。一覧（`listEntities`）は `active` だけを返すので、準備中は見えない。
- **Rationale**: 各ユースケースは別々のトランザクションのため、補償（作ったものを消す）しか全部か無かを作れない。ファイル単位でテナントが分かれている（憲法 III）ので、事業体ごと消せば跡は残らない。`preparing` で一覧から隠せば、作成中に他の画面から触られない。
- **Alternatives**: (a) 作成後に失敗したら `archived` にする — 中途半端なデータが残るため却下（SC-006）。(b) テナントを一時のファイルで作って最後に改名 — registry と証憑のディレクトリの改名も要り、既存の `openTenant` の経路と合わない。

## R3. デモの印: registry の列

- **Decision**: registry の `entities` に `is_demo`（INTEGER 0/1、既定 0、STRICT）を足す。`EntitySummary` に `demo: boolean` を足し、`GET /api/entities` で返す。
- **Rationale**: 一覧とすべての画面の目印が、テナントを開かずに一覧の応答だけで判断できる（web の骨組みは `entitiesQuery` を既に読む: `apps/web/src/routes/e/$entityId/route.tsx:15`）。バックアップは registry の写しを含む（`packages/db/src/backup/snapshot.ts:89` の加工の対象外の列）ので、印も復元される。
- **Alternatives**: tenant の `entityProfile` に持つ — 一覧の応答に載せるには全テナントを開く必要があり却下。名前の「デモ」だけで判断 — 名前は変更できるため却下（spec の Assumptions）。

## R4. 素材: 合成の画像は server に同梱、明細は domain で文字列を作る

- **Decision**: 証憑の画像 3 枚を `apps/server/assets/demo/`（`receipt-01.png` など）に置く。中身は既存の合成画像（`packages/domain/test/fixtures/receipts/eval/` の 01・05・06。試作で使用）の写し。server が起動時ではなく作成時に読み、`DemoAssets` のポート（`receiptImage(key): Uint8Array`）で domain に渡す。明細は `buildDemoPlan` が UTF-8 の CSV の文字列（日付・摘要・入金・出金の 4 列）を作り、既存の明細の読み取り → 確定の経路に渡す。列の対応はデモの定義に固定で持つ。
- **Rationale**: FR-006（テストの素材を実行時に読まない）。domain は `node:fs` を使えないため、画像のバイト列は server が読む。CSV は日付を作成日に合わせる必要がある（R5）ので、ファイルではなく生成する。
- **Alternatives**: 画像を実行時に描画する — 依存が増え、証憑の画面での見え方が試作と変わる。テストのフィクスチャを直接読む — FR-006 に反する。

## R5. 日付: 作成日から会計年度と各データの日付を決める

- **Decision**: `buildDemoPlan(today)`: 作成日の月が 3 月以降なら会計年度 = 作成日の年、1・2 月なら前の年（spec US3）。各データは「年度内の月・日」で定義し、作成日より後の日付は計画に入れない。すべての種類（spec US1 の 3 の 11 種）の最低 1 件を 1〜2 月に置き、3 月以降は量を足す（例: 1 月の工数 → 2 月 1 日に発行・2 月末に源泉徴収ありで入金、2 月の工数 → 3 月 1 日に発行・未入金。前の年度のときは 11・12 月分を同じ形で置く）。月と日付の計算は `packages/domain/src/dates.ts` の関数だけを使う。
- **Rationale**: SC-002・SC-003 を、どの作成日でも満たす。性質テスト（fast-check で作成日を年内の任意の日にする）で確かめられる。
- **Alternatives**: 年度を常に前の年にする — 3 月以降に試すと「今年」が空になり、ホームの表示が乏しい。

## R6. 二重の作成の防止と、使える条件

- **Decision**: `POST /api/entities/demo` は、(1) `active` か `preparing` の事業体があれば 409 `DEMO_NOT_AVAILABLE`、(2) server のプロセス内の排他（作成中の印）で同時の 2 つ目を 409 `DEMO_NOT_AVAILABLE` にする。web はボタンを押した後、応答まで無効にする。認証・施錠・Host・CSRF は既存の `/api` の検査のまま（リモートからも通常の作成と同じく使える。`routes/entities.ts:33` に channel の制限はない）。
- **Rationale**: FR-001・FR-012・FR-013。server は 1 プロセス（`127.0.0.1:8787`）なのでプロセス内の排他で足りる。
- **Alternatives**: DB の UNIQUE で防ぐ — 「アクティブな事業体がない」という条件は UNIQUE で表せない。

## R7. AI を呼ばない

- **Decision**: デモの経路は、AI の推定を呼ぶユースケース（明細の候補の推定、証憑の読み取り）を呼ばない。明細は確定（取込）までで止め、候補の推定は利用者が明細の画面を開いたときの既存の経路に任せる。`createDemoEntity` の deps に AI のポートを含めない（型で呼べないようにする）。
- **Rationale**: FR-007・INV-45。取込の確定が AI を呼ばないことは tasks の最初で確かめる（呼ぶなら、規則だけの候補に限る deps を渡す）。

## R8. 画面

- **Decision**: 事業体の一覧の空の状態（`apps/web/src/features/entities/EntityListPage.tsx:160-166`）に、説明とボタン（`variant="outline"`。主ボタンは作成フォームの 1 つのまま: 011 の ui-shell §7）を置く。成功したら `invalidateQueries(["entities"])` してデモのホームへ移る。事業体の画面の骨組み（`apps/web/src/routes/e/$entityId/route.tsx`）に、`demo` のときだけ目印の帯（「デモ用の架空のデータです」と「試し終わったら削除」→ 一覧の該当の事業体のアーカイブ）を出す。請求書の印刷（`apps/web/src/features/invoicing/InvoicePrint.tsx`）に、`demo` のとき「デモ（架空のデータ）」の表示を印刷にも出す。API 呼び出しは `features/entities/api.ts` に置く。
- **Rationale**: FR-001・FR-008・FR-009。目印は骨組みの 1 か所に置けば全画面に出る（SC-004）。

## R9. マニュアル

- **Decision**: 記事「事業体を作成・切り替える」（`apps/web/src/features/manual/content.ts:67`、id `entities`）に、デモ事業の作り方・目印・消し方の節を足す。sources に新しいファイルを足し、`pnpm manual:check` を通す。撮影の更新は 012 の手順（`docs/features/012-app-manual.md`）で利用者の確認の後に行う。
- **Rationale**: FR-014、AGENTS.md の「マニュアル」の規則。

## R10. 開発用スクリプトの片づけ

- **Decision**: 実装の最後に、試作の未コミットの変更（`scripts/seed-demo.ts`、`scripts/lib/demo-seed.ts`、`scripts/lib/terminal.ts`、`apps/server/test/demo-seed.test.ts`、`package.json`・`AGENTS.md`・`scripts/restore-backup.ts` の差分）を取り消す。データの定義と API の呼び順は R1・R5 の実装で引き継ぐ。
- **Rationale**: spec の Assumptions。製品に入口があれば開発用の入口は不要（YAGNI）。
