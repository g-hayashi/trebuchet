# Quickstart: 汎用の明細取込

## 1. 自動の検証（サンドボックスでも動く）

```sh
pnpm vitest run --project domain   # 読み取り（INV-48〜50）、辞書、口座の推定、当てはめ
pnpm vitest run --project db       # statement_sources、マイグレーションの作り直し後のトリガー・外部キー
pnpm vitest run --project server   # multipart の取込、取込元、列の案が外部へ行かないこと
pnpm vitest run --project web      # 列の選択、取込元の当てはめ、口座の案の表示
pnpm bench:statements              # 500 件の CSV で layout → preview → commit（SC-006、5 秒以内）
pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @trebuchet/web build
```

期待: すべて通過。`fixtures/statements/` の各形で、件数と入金・出金の合計が `expected.ts` と一致する（SC-001）。

## 2. 利用者の端末での確認

前提: `pnpm dev`、`http://localhost:5173` でサインイン済み、事業体がある。

1. **CSV（初回）**: `packages/domain/test/fixtures/statements/` の銀行の形の CSV を「ファイル」で選ぶ → 区切り・見出しの行が自動で選ばれ、前置きの行は見本に出ない → 出金・入金の列の案が入っている → 取込元の名前を入れて確認画面へ → 口座に「銀行・普通預金」の案 → 用途を選んで取り込む（2 分以内。SC-002）
2. **CSV（2 回目）**: 同じ形の別の CSV を選ぶ → 列の選択を経ずに確認画面（SC-003）
3. **見出しの変更**: 列を 1 つ入れ替えた CSV → 違いが示され、選び直しになる
4. **貼り付け（まとめ）**: `.tmp/sample-ai-paste.txt`（MF ME の形の合成）を貼り付ける → 列の案がそろい、符号の向き（正が入金）を選ぶ → 口座ごとに案（「カード」→ カード・未払金）
5. **端末内の AI**: AI の設定で端末内を有効にし、見出しが独自の名前の合成の CSV を選ぶ → 「AI の案」が入るか、20 秒で案なしになる。外部の AI を有効にしていても外部へ送られない（server の要求の記録で、外部の接続先への要求がないこと）
6. E2E: `pnpm --filter @trebuchet/web e2e`（`statements.spec.ts` を CSV の取込と 2 回目の当てはめに直したもの）

実データでの確認は、件数と一致・不一致だけを記録し、値・口座名・摘要を書かない（006 の quickstart §3 と同じ）。
