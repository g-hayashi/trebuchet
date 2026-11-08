# Contracts: デモ事業の作成（014）

## HTTP API

### POST /api/entities/demo（新規）

デモ事業を作る。本文なし（`{}` を許す）。既存の `/api` の検査（Host → CSRF → 認証、施錠中は 401 `LOCKED`）を通る。

| 状態 | 本文 | 条件 |
|---|---|---|
| 201 | `{ "entity": EntitySummary }`（`demo: true`） | 作成に成功（R1・R2） |
| 409 | `{ "error": { "code": "DEMO_NOT_AVAILABLE", "message": "事業体があるため、デモ事業は作れません" } }` | `active` か `preparing` の事業体がある、または別のデモを作成中（R6） |
| 500 | `{ "error": { "code": "DEMO_FAILED", "message": "デモ事業を作れませんでした。作りかけのデータは残っていません" } }` | 投入の途中で失敗し、消した（R2）。原因の詳細は応答・ログに金額や摘要を出さない |

- ルートは `apps/server/src/routes/entities.ts`（テナントのミドルウェアの外）。`respond(c, result, ...)` で返す。
- エラーコードは `packages/schema` と `apps/web/src/lib/api-errors.ts` に足す。

### GET /api/entities（変更）

`entities[]` の各要素に `demo: boolean` を足す。`preparing` は含めない（従来どおり `active` だけ）。

### GET /api/entities/archived（変更）

各要素に `demo: boolean` を足す。

## 画面（UI contract）

| 場所 | 振る舞い |
|---|---|
| 事業体の一覧（`/list`）の空の状態 | `active` の事業体が 0 件のとき、説明「架空のデータで機能を試せる事業体を作ります。試し終わったら削除できます。」とボタン「デモ事業を作って試す」（`variant="outline"`）。押すとボタンを無効にして「作成中…」。成功でデモのホームへ。409・500 は既存の `ApiErrorMessage` で表示 |
| 事業体の画面の骨組み（`/e/:entityId/*`） | `demo` のとき、全画面の上部に帯「デモ用の架空のデータです」と「試し終わったら削除」（一覧へ移り、その事業体のアーカイブを案内） |
| 請求書の印刷 | `demo` のとき、印刷にも「デモ（架空のデータ）」を出す |
| 一覧の各事業体 | `demo` のとき名前の横に「デモ」の印 |
