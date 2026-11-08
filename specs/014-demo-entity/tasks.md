---
description: "Task list for 014 デモ事業の作成"
---

# Tasks: デモ事業の作成

**Input**: `specs/014-demo-entity/`（spec、plan、research R1〜R10、data-model §1〜5、contracts/http-api.md、quickstart）

**Tests**: テスト先行（Constitution V）。各タスクはテストを書いて赤を確かめてから実装する。テストと実装は同じタスクに入れてある（1 体の部下にまとめて渡す単位）

**Organization**: ストーリーごと。[P] は並列にしてよい印で、実行は順番に行う

## 全タスク共通のルール

- **[AGENTS.md](../../AGENTS.md) の「開発の進め方」「データと一時ファイル」に従う**（テスト先行、`respond`、web の `features/entities/api.ts`、新しい API を呼ぶ画面は `mock-api.ts` に既定の応答を足す、エラーコード・共有の型を変えるときの `grep -rn <値> packages apps scripts`、マイグレーションの `) STRICT;` の置き換え、部下のテストの範囲）
- この機能に固有: **依存（npm）を足さない**。既存のユースケースのルール・監査の経路を迂回しない（SQL の直接投入をしない。R1）。デモの経路で AI のポート・外部の送信を使わない（R7）。テストのフィクスチャを実行時に読まない（R4）。日付の計算は `packages/domain/src/dates.ts` だけ（R5）
- 開発用の試作（未コミット）の `scripts/lib/demo-seed.ts` は、データの中身と API の呼び順の参考に読んでよい。import・コピーでの流用はせず、T009 で消す
- registry のマイグレーションは最新が `0003_entity_lifecycle`・`0004_ai_local_default_off`。生成した順に番号が付く
- 実データ（`work/`・`data/`）は扱わない

## Phase 1: Foundational（全ストーリーの前提）

- [X] T001 registry の印と状態（data-model §1・§2・§5、R2・R3）。先に `packages/db/test/registry-repository.test.ts`（または既存の registry のテスト）に「`is_demo` の既定 0、`demo: true` で作った行が一覧に `demo: true` で出る」「`preparing` の行は `listEntities`・`listArchivedEntities` に出ない」「`activateEntity` で `preparing` → `active`、`active` 以外からは変えない」「`listPreparingEntities`」を、`packages/db/test/backup-*.test.ts` の該当箇所に「`preparing` の行とそのテナントはバックアップに含めない、`is_demo` は写る」を足して赤を確かめる。実装: `packages/db/src/schema/registry.ts`（`is_demo` INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1))、`status` に `preparing`）、マイグレーション（`drizzle-kit generate`、表を作り直すなら `) STRICT;`）、`packages/db/src/registry-repository.ts`、`packages/db/src/backup/snapshot.ts`。domain: `packages/domain/src/types.ts` の `EntitySummary.demo: boolean`・`EntityStatus` に `"preparing"`、`packages/domain/src/ports.ts` の registry のポート（`insertEntity` に status・demo、`activateEntity`、`listPreparingEntities`）、domain のテストの偽物（`packages/domain/test/fakes/`）。`EntitySummary` を参照するテストを grep して直す
- [X] T002 `createEntity` の入力（data-model §2）。先に `packages/domain/test/usecases/create-entity.test.ts`（既存）に「`status: "preparing"`・`demo: true` で registry に渡る」「省略時は `active`・`false`」を足して赤を確かめる。実装: `packages/domain/src/usecases/create-entity.ts`。`POST /api/entities` の入力（`EntityCreate`）には足さない（通常の作成から demo を作れない）

## Phase 2: User Story 1 - 初回起動でデモ事業を作って試す（P1）🎯 MVP

**Goal**: 一覧の空の状態のボタンでデモ事業を作り、そのホームが開く

**Independent Test**: 事業体のないデータ場所でボタンを押し、11 種のデータが各 1 件以上・試算表の貸借一致・ホームが開くこと（spec US1、SC-002）

- [X] T003 [US1] デモの計画（R4・R5、data-model §3、INV-76）。先に `packages/domain/test/demo/plan.property.test.ts`（INV-76: fast-check で作成日を 2000〜2100 年の任意の日にし、全日付 ≤ 作成日・年度内、11 種が各 1 件以上、各仕訳の貸借一致、金額は整数で `0 < amount < 1e12`。1・2 月は前の年、3 月以降は今年）と具体例（2026-11-08・2026-03-01・2026-01-15）を書いて赤を確かめる。実装: `packages/domain/src/demo/plan.ts` の `buildDemoPlan(today: string): DemoPlan`（純関数。科目は名前・コードで指し、ID は持たない。明細は 4 列の UTF-8 CSV の文字列と列の対応。証憑は素材のキー `receipt-01`・`receipt-05`・`receipt-06` と日付・金額・取引先）。量と中身は試作（仕訳 40 程度、資産 3、開業費 1、請求書 2、定期仕訳 1、証憑 3、明細 10）を目安にする。名前の重なりの規則（data-model §3 の `name`）は `demoEntityName(existing: string[])` として同じファイルに置く
- [X] T004 [US1] デモの作成のユースケース（R1・R2・R7、INV-77）。先に `packages/domain/test/demo/create-demo-entity.test.ts`（偽物のポートで成功時の件数・`activateEntity` の呼び出し・`demo: true`）と `create-demo-entity.property.test.ts`（INV-77: 投入の n 番目のユースケースで err か例外を注入し、任意の n で後片づけ（`purgeEntityData` 相当のポート）が呼ばれ `preparing`・`active` が残らない、`DEMO_FAILED` を返す）を書いて赤を確かめる。実装: `packages/domain/src/usecases/demo-entity.ts` の `createDemoEntity(deps, { today })`（`active`・`preparing` があれば `DEMO_NOT_AVAILABLE`。createEntity を `preparing`・`demo: true` で呼び、既存のユースケースを計画の順に呼ぶ。各ユースケースの UoW を入れ子にしない）と `cleanupPreparingEntities(deps)`。deps の型に AI のポートを含めない。`DemoAssets`（`receiptImage(key): Uint8Array`）を `ports.ts` に。明細の取込の確定が AI を呼ばないことを最初に確かめ、呼ぶなら規則だけの deps を渡す（結果を報告に書く）。エラーコード `DEMO_NOT_AVAILABLE`・`DEMO_FAILED` を domain のエラーに足す
- [X] T005 [US1] server（contracts の POST・GET、R4・R6）。先に `apps/server/test/entities-demo.api.test.ts`（新規。空のデータ場所で 201・`demo: true`・各画面の API で件数 > 0・試算表の貸借一致、事業体があると 409、同時の 2 回目が 409、投入の途中の失敗（deps の差し替え）で 500 `DEMO_FAILED` と後に何も残らない、施錠中 401）と `apps/server/test/auth-coverage.test.ts`（INV-29）、`entities` の既存のテストの `demo: false` を足して赤を確かめる。実装: `apps/server/assets/demo/receipt-01.png` などに合成の画像 3 枚（`packages/domain/test/fixtures/receipts/eval/` の 01・05・06 の写し。拡張子は元に合わせる）、`apps/server/src/demo-assets.ts`、`apps/server/src/routes/entities.ts` の `POST /entities/demo`（プロセス内の排他）、`apps/server/src/deps.ts` の deps の組み立て、解錠の後の `cleanupPreparingEntities`（解錠の処理の場所を探して呼ぶ）、`apps/server/src/errors.ts` の状態の対応（409・500）、`packages/schema` のエラーコード
- [X] T006 [US1] web の空の状態（contracts の UI、R8）。先に `apps/web/test/routes/entity-list.test.tsx`（既存か新規。事業体 0 件で説明とボタン、1 件以上で出ない、押すと無効化と「作成中…」、成功でデモのホームへ移る、409・500 の表示）を書いて赤を確かめる。実装: `apps/web/src/features/entities/api.ts` の `createDemoEntity`、`apps/web/src/features/entities/EntityListPage.tsx:160-166`（ボタンは `variant="outline"`）、`apps/web/src/lib/api-errors.ts` の 2 コード、`apps/web/test/mock-api.ts` の既定の応答（一覧の `demo: false`、`POST /entities/demo`）

## Phase 3: User Story 2 - デモ事業だと分かり、試し終わったら消せる（P1）

**Goal**: デモ事業の全画面と印刷に目印を出し、既存のアーカイブ・完全削除へ案内する

**Independent Test**: デモ事業の任意の画面で帯が出て通常の事業体では出ない、印刷に表示が出る、削除後に一覧が空に戻りボタンが出る（spec US2、SC-004・005）

- [X] T007 [US2] 目印（contracts の UI、R8、FR-008・009）。先に `apps/web/test/routes/demo-banner.test.tsx`（新規。`demo: true` の事業体のホーム・仕訳・決算書で帯と「試し終わったら削除」、`demo: false` で出ない、リンクが一覧へ移る）、`apps/web/test/routes/invoice-print.test.tsx` に「`demo` のとき『デモ（架空のデータ）』」、一覧の「デモ」の印を足して赤を確かめる。実装: `apps/web/src/components/layout/DemoBanner.tsx` と `apps/web/src/routes/e/$entityId/route.tsx`（`entitiesQuery` の該当の事業体の `demo`）、`apps/web/src/features/invoicing/InvoicePrint.tsx`（印刷の CSS で隠さない）、`EntityListPage.tsx` の印。削除後に一覧が空ならボタンが出ることは T006 のテストに 1 件足す

## Phase 4: User Story 3 - 起動した時期に合ったデータで試す（P2）

**Goal**: 作成日に合った年度と日付

**Independent Test**: 時計を変えた server のテストで、全データの日付 ≤ 作成日・年度が作成日に合う（spec US3、SC-003）

- [X] T008 [US3] 作成日の受け渡しの確認。T003 の INV-76 で計画は満たしている。ここでは `apps/server/test/entities-demo.api.test.ts` に `makeClock` で 2027-01-20 と 2027-03-01 の 2 例（前の年・今年の年度、仕訳・請求書・証憑・明細の最大の日付 ≤ 作成日）を足して赤を確かめ、落ちれば `createDemoEntity` に渡す `today` の作り方（server の clock → `dates.ts` の日付。タイムゾーンは既存の「今日」の関数に合わせる）を直す

## Phase 5: Polish & Cross-Cutting

- [X] T009 試作の片づけ（R10）: `scripts/seed-demo.ts`、`scripts/lib/demo-seed.ts`、`scripts/lib/terminal.ts`、`apps/server/test/demo-seed.test.ts` を消し、`package.json`・`AGENTS.md`（コマンドの表の `demo:seed` の行）・`scripts/restore-backup.ts` を `git checkout` で戻す（メインが行う）
- [X] T010 文書: `docs/features/014-demo-entity.md`（層の表と固有の規則: AI を呼ばない、テストのフィクスチャを読まない、全部か無か、素材の置き場所）と AGENTS.md の「機能ごとの文書」の表に 1 行、`specs/INVARIANTS.md` に INV-76・77（data-model §4）、`docs/requirements.md` の FR-15 の状態（済 014）
- [X] T011 マニュアル（R9、FR-014）: `apps/web/src/features/manual/content.ts` の `entities` の記事にデモ事業の作り方・目印・消し方の節を足し、sources に新しいファイル（`usecases/demo-entity.ts`、`DemoBanner.tsx`）を足して `pnpm manual:check` を通す（撮影は T013 で利用者の端末）
- [X] T012 最終の検証（メイン）: `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @trebuchet/web build`、`pnpm manual:check`（2026-11-08: manual:check 以外は通過。manual:check は根拠の変更で 29 記事が要確認となり、T013 の撮影と record の後に通す）
- [ ] T013 利用者の端末での確認: quickstart の 1〜6（SC-001 の 10 秒を含む）と、`pnpm manual:capture` → 画像の確認 → `pnpm manual:record`（docs/features/012-app-manual.md）

## Dependencies & Execution Order

- T001 → T002 → US1（T003 → T004 → T005 → T006）→ US2（T007）→ US3（T008）→ T009〜T013
- T004 は T003 の計画と T001・T002 のポートを使う。T005 は T004、T006 は T005 の API を使う。T007 は T001 の `demo` を使う（US1 と独立に試せるが、ファイルの順で US1 の後）
- [P] は付けていない（`types.ts`・`ports.ts`・`routes/entities.ts`・`EntityListPage.tsx` を順に触るため）

## Implementation Strategy

- MVP は Phase 1 + US1（ボタンでデモ事業ができる）。US2 の目印は MVP の直後に入れる（本物の帳簿との取り違えを防ぐため、US2 なしで利用者に出さない）
- 部下への渡し方: T001・T002 を 1 体、T003・T004 を 1 体（T004 は INV-77 の全部か無かの設計を伴う。implementer で進め、整合性の判断が要ると報告されたら implementer-hard）、T005・T006 を 1 体、T007・T008 を 1 体、T010・T011 を 1 体。T009・T012 はメイン。コミットは最後にまとめてメインが行う（2026-11-08 利用者の指示）
