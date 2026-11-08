# Quickstart: デモ事業の作成（014）

## 自動の検証（サンドボックスで実行できる）

```sh
pnpm vitest run --project domain   # buildDemoPlan の性質テスト（INV-76）、createDemoEntity の全部か無か（INV-77、偽物のポート）
pnpm vitest run --project db       # registry の is_demo・preparing、activateEntity、バックアップから preparing を除く
pnpm vitest run --project server   # POST /api/entities/demo の 201・409・500（後片づけ）、GET /api/entities の demo
pnpm vitest run --project web      # 空の状態のボタン、二重押しの無効、目印の帯、印刷の表示
pnpm typecheck && pnpm lint && pnpm test
pnpm manual:check
```

## 利用者の端末での確認（server を起動する）

1. 空のデータ場所で起動する: `TREBUCHET_DATA_DIR=.tmp/quickstart-014 pnpm dev` → `http://localhost:5173` で初回の設定（パスキーの登録、回復キーを控える）
2. 事業体の一覧に「デモ事業を作って試す」がある → 押す → 10 秒以内にデモのホームが開く（SC-001）
3. 仕訳・試算表（借方 = 貸方）・請求書（入金済み 1・未入金 1）・固定資産（3）・開業費・定期仕訳・証憑（3。仕訳に結びつく）・明細（未処理）が見える。どの画面にも目印の帯がある。請求書の印刷のプレビューに「デモ（架空のデータ）」が出る
4. 決算整理の案・明細の承認・請求書の発行を試せる（通常と同じ）
5. 帯の「試し終わったら削除」→ アーカイブ → 完全に削除（名前の確認）→ 一覧が空に戻り、ボタンが再び出る（SC-005）
6. 片づけ: `.tmp/quickstart-014` を消す
