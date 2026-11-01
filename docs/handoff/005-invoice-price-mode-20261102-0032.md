# 005 請求の税込・税抜入力と消費税相当額

## Branch

- `fix/invoice-price-mode`
- 作業場所: `/Users/ghayashi/Documents/ghayashi-trebuchet/.tmp/worktrees/invoice-price-mode`
- 基点: `3b9b054`。009 の設計文書は基点にあるが、009 の実装・未コミット変更は取り込んでいない。

## Completed tasks

- Feature ID: `005-recurring-invoicing`、追加要件 005/R27。
- T028: schema/domain、税込・税抜入力、税率別の加算、請求税率と免税の帳簿税区分の分離、写しの固定。
- T029: 条件・写しの永続化、`0011_invoice_price_mode.sql`、方式の更新禁止、計算 API、合成旧 DB の移行確認。
- T030: 条件と案の入力方法・税率の選択、API の計算結果による小計・加算額・合計、詳細と印刷の税抜表示・消費税相当額。
- T031: 自動検証とコミット。`pnpm typecheck`、`pnpm lint`、`pnpm test`（303 ファイル、3,444 テスト）、`pnpm --filter @trebuchet/web build` が成功。最終のテスト記述の型修正後、関連 web 4 ファイル・39 テストも成功。UI detector は指摘なし。
- 税抜 6,000 円 × 30 時間、10% で 198,000 円。税込入力では 180,000 円。免税の売掛金・売上は加算後の全額、仕訳税額は 0。実データは読まず、変更していない。

## Next task

- 今回の実装タスク ID は残りなし。
- 端末でのブラウザ操作・E2E・A4 印刷確認。専用作業場所へ移動し、`TREBUCHET_DATA_DIR="$PWD/.tmp/quickstart-005" pnpm dev` で合成データを使う。操作は `specs/005-recurring-invoicing/quickstart.md` の R27 を参照。
- 取引先の「請求の条件」または請求書の案で「金額の入力方法」を税抜入力にし、請求税率を10%にする。発行前に小計・加算額・合計を確認する。既存の請求書は変更されず、訂正は取消と再発行。

## Deferred

- ブラウザ・E2E・実印刷: AGENTS.md の端末実行制約に従い未実施。DOM コンポーネントテストは成功。
- 009 ブランチへの統合: 利用者の混在指摘に従い、専用 worktree で分離したまま。統合していない。
- 将来009へ統合する場合、両ブランチが tenant migration の0011番を使うため、請求側の番号・journal・snapshotを統合先に合わせて再生成し、マイグレーションのテストを実施する。自動で両方のjournalを足して済ませない。

## Failing checks

- 現在の自動検証に失敗なし。ブラウザ・E2E・実印刷は未検証。

## Commits this session

- `3d69316`: T028-T029、請求計算・保存・API・仕様。
- `6c34693`: T030-T031、画面・対応テストと最終検証。
- 元の `009-depreciation-deferred` 側のみ `05f5124`: 別セッションの `e60205d` に混入した今回の請求テスト1ファイルを除去する訂正コミット。009の他のコード・未コミット変更は戻していない。履歴は書き換えていない。
- 本メモは別の handoff コミットで保存する。

## Usage stats

- トークン: 取得不可。
- 費用: 取得不可。
- セッション全体の所要時間: 取得不可。
- 使用量の記録用に `/status` の確認を案内済み。利用者から数値の提供なし。
