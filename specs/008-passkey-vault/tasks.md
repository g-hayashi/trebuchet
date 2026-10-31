# Tasks: 008 Passkey vault

設計: `design.md`（D 番号で参照）。助言の元: invest-copilot の 003-passkey-vault。

## 全タスク共通のルール

- AGENTS.md の「開発の進め方」に従う（TDD、Edit / Write で編集、担当のプロジェクトのテストだけを実行、コミットしない）。
- 既存データは捨てる。移行・旧版との互換を作らない。registry のマイグレーションは作り直してよい。
- 写す元の invest-copilot は `~/Documents/invest-copilot`（読むだけ）。
- エラーコード・共有の型・公開の手続きを変えたら `grep -rn <値> packages apps scripts` で全プロジェクトを直す。

## タスク

- [X] T001 db: ドライバーを `better-sqlite3-multiple-ciphers` に替え（import と型。`@types/better-sqlite3` が要らなければ外す）、`auth.sqlite`（`passkeys` に `prf_salt`、`key_wraps`、`sessions`、`auth_events`）を registry から分け、`recovery_codes` を消す。`tenant-store.ts` に `setDataKey`・`clearDataKey`・`VaultLockedError`・`openAuth`、DB の鍵の導出（HKDF、`node:crypto`）。`useTempDataDir` がテスト用の DK を入れる。テスト: 施錠中の open、誤った鍵、平文が残らない、鍵の導出、`key_wraps` の制約（D1・D2、INV-51・53）
- [X] T002 server: `lib/vault-crypto.ts`・`vault.ts`・`recovery-key.ts`（invest-copilot から写す）、初回の設定・サインイン・回復の PRF と包み（`prf_required`、`PRF_UNSUPPORTED`）、5 分の再認証（`REAUTH_REQUIRED`）、パスキーの削除で包みも消す、回復の 1 秒の遅延とロックの廃止、起動時・施錠時のセッションの全削除と順序、401 `LOCKED`、背景の処理を解錠に結びつける（`startup.ts`・`main.ts`）。INV-29 の一覧と網羅テスト、INV-52 の性質テスト（D1・D3〜D5・D7）
- [X] T003 web と E2E: PRF の値の変換（`webauthnClient.ts` を写す）、初回の設定・解錠（パスキー・回復キー）・回復の後のパスキー登録の画面、401 `LOCKED` で解錠の画面に戻す、設定のセキュリティ（追加・削除・回復キーの再発行・施錠、再認証）。`mock-api.ts` の既定の応答。E2E の仮想の認証器に `hasPrf: true`、回復キーで引き継ぐ `enterVault`（D4・D6・D11）
- [X] T004 バックアップと復元: 鍵を DK から（D9）、ヘッダーに recovery の包み、パスフレーズ・キーチェーンの経路と画面・API の削除（`SecretStore` は AI の API キーのために残す）、解錠中だけの定期実行、`pnpm restore` は回復キーで（ヘッダー → 今の `auth.sqlite` の順に試す）、画面の検査は DK で。テストの後に `.tmp/server-<id>/snap` が残る漏れを直す。INV-54 の性質テスト。`bench:backup` を合わせる（D9、INV-54）
- [X] T005 文書: ADR 0011、ADR 0006・0007 の置き換えの記載、`specs/INVARIANTS.md` に INV-51〜54、AGENTS.md の 004 の節と 008 の節、`docs/requirements.md`、README（D10・D12）
- [X] T006 メイン: `pnpm typecheck`・`pnpm lint`・`pnpm test`・web の build。利用者の端末で `data/` を作り直し、E2E と手動の確認（設定 → 施錠 → パスキーで解錠 → 回復キーで解錠 → バックアップ → 復元）
