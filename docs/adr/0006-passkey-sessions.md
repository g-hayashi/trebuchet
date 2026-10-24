# ADR 0006: パスキーとサーバー側のセッションで認証する

- 状態: 採用
- 日付: 2026-10-24
- 関連: specs/004-auth-backup/research.md R1, R2, R5, R6, R7, R17

## 状況

これまでの帳簿アプリは認証がなく、`127.0.0.1` だけで待ち受けることで守っていた。バックアップと将来のリモートの利用を入れるにあたり、帳簿の API に認証が要る。利用者は本人 1 人で、Mac の Touch ID が使える。パスワードは持たせたくない。

## 決定

- **サインインはパスキー**（WebAuthn）。検証は `@simplewebauthn/server`、ブラウザ側は `@simplewebauthn/browser`。attestation は `none`、userVerification は `required`
- **RP ID は接続先のホスト名**。ローカルは `localhost`（IP アドレスは RP ID にできない）。開発の URL は `http://localhost:5173`。許す Host・オリジン・RP ID の決定は `apps/server/src/lib/origin.ts` の 1 か所にまとめる
- **セッションは 32 バイトの乱数のトークンと cookie**（`HttpOnly`、`SameSite=Strict`、`Path=/`、https のとき `Secure`）。DB には SHA-256 のハッシュ（db の `hashToken`）だけを保存する。最後の操作から 8 時間で失効し、作ったパスキーと RP ID を持つ。パスキーを削除すると、そのパスキーのセッションも失効する
- **回復コード**は 128 ビットの乱数（Crockford の base32）。保存はハッシュだけで、有効なものは常に 1 つ。コードの確認は 10 分の回復用の一時セッションを出すだけで、コードを消費しない。新しいパスキーの登録に成功したときに、コードを無効にして新しいコードを出す。連続 5 回の失敗で 15 分ロックする
- **ペアリングのトークン**（別の接続先の名前のパスキーを登録する、一度きり・10 分の乱数）は、リモートの機能（US4）とともに保留している。実装していない
- **全 `/api` に Host → CSRF → 認証の順で検査を掛ける**
  1. Host が許す名前でなければ 421（DNS rebinding の対策）
  2. CSRF は自前のミドルウェア。GET・HEAD・OPTIONS 以外の要求は、`Content-Type` によらず `Origin` が許す一覧にあること。`Origin` がなければ `Sec-Fetch-Site: same-origin` であること
  3. 認証は、公開の手続きの完全一致の一覧（`requiresAuth`）以外は有効なセッションを要求する。ルートを足して一覧にも入れ忘れた場合は、INV-29 のテスト（全ルートの列挙）が、未サインインで 401 にならないことで見つける
- **認証を無効にする設定・環境変数を作らない**。テストはセッションを registry に直接作るヘルパーを使う

## 理由

- 検証には CBOR・COSE 鍵・authenticatorData の解析と署名の検査が要り、自作の誤りは認証の破れに直結する。標準機能で代替できないので依存を足す（Constitution VII）
- サーバー側のセッションは、個別に無効化できる。署名つきの cookie だけ（JWT など）では、失効に別の表が要り、利点がない
- `hono/csrf` は本文の形式（フォームの `Content-Type`）にしか検査を掛けず、JSON の POST と本文なしの DELETE を通す。それでは FR-009 を満たせない
- 回復コードを入力の成功で消費すると、続くパスキーの登録の失敗で、利用者が帳簿に戻れなくなる

## 検討した代替案

- `node:crypto` だけでパスキーを検証する: CBOR・COSE の解析を自作することになり、検証の漏れの危険が大きい
- JWT: 無効化に失効の表が要る
- 回復コードを確認の成功で消費する: 登録に失敗したときに帳簿へ戻れない

## 影響

- 開発の URL は `http://localhost:5173`。`127.0.0.1:5173` ではパスキーが使えない。vite の proxy は `changeOrigin: false` にして、Host を書き換えない
- 既存の server のテストはすべて認証が要る。`apps/server/test/helpers.ts` の `createTestSession`・`testHeaders` で cookie と許す Host・Origin を付ける
- 認証の履歴（`auth_events`）は追記のみで、更新・削除はトリガーで禁止する（Constitution II）
- 認証の情報は registry の DB に置く。バックアップには含めず、復元した帳簿ではパスキーの登録からやり直す（[ADR 0007](0007-backup-format.md)）
