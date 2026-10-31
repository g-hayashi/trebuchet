# 008 Passkey vault: パスキーと回復キーでデータ鍵を守り、DB を暗号化する

invest-copilot の `specs/003-passkey-vault/design.md`（D1〜D8）を土台に、trebuchet との差分を書く。spec・plan・research は作らない（利用者の判断、2026-10-30）。

目的: DB の鍵を平文でディスク（キーチェーン、環境変数、ファイル）に置かない。パスキーで解錠するまで、server も帳簿を読めない。パスキーを失ったら回復キーで戻せる。

既存データは捨てる。移行・旧回復コードとの互換・キーチェーンの旧パスフレーズの移行は作らない（`data/` の DB は作り直す）。

## D1 鍵の構成

- DK（データ鍵）: 32 バイトの乱数。初回の設定で 1 回だけ作り、以後は変えない（包み直すだけ）。
- DB の鍵: `HKDF-SHA256(DK, salt=空, info)`。info は registry が `"trebuchet/db/registry/v1"`、事業体が `"trebuchet/db/tenant:<entityId 小文字>/v1"`。32 バイト。
- バックアップの鍵: `HKDF-SHA256(DK, salt=ヘッダーの salt 16 バイト, info="trebuchet/backup/v1")`（D9）。
- KEK（DK を包む鍵）: `HKDF-SHA256(ikm, salt=wrap.salt, info="trebuchet/dk-wrap/v1")`。
  - パスキー: ikm は WebAuthn PRF の出力（`prf.results.first`、32 バイト）。PRF の入力は資格情報ごとに保存する 32 バイトの乱数 `prf_salt`。
  - 回復キー: ikm は回復キーの 160 ビットの乱数そのもの（Crockford base32、4 文字区切り）。Argon2 は使わない。
- 包み: `AES-256-GCM(KEK, iv 12 バイト, DK)`。AAD は `kind` と `credential_id`（回復は `"recovery"`）。行の差し替えを検出する。
- 正しさの判定は包みが開けたこと（GCM の検証）だけ。回復キーのハッシュは保存しない（`recovery_codes` の表と `hashToken` による回復コードの照合はやめる）。
- 鍵の計算は純関数（`node:crypto` を使うので domain には置かない）。`packages/db/src/vault-crypto.ts`・`recovery-key.ts`（復元のコマンドが使うので server ではなく db に置いた）。写す元: invest-copilot `src/lib/server/vaultCrypto.ts`・`recoveryKey.ts`。

## D2 ファイルと表

| ファイル | 暗号化 | 中身 |
|---|---|---|
| `data/auth.sqlite` | しない | `passkeys`（`prf_salt BLOB NOT NULL` を足す）、`key_wraps`、`sessions`（トークンのハッシュ）、`auth_events` |
| `data/registry.sqlite` | DK から（D1） | `entities`、`app_settings`、`backup_runs`、`ai_settings`、`pairing_tokens`（US4 保留のまま） |
| `data/tenants/<id>.sqlite` | DK から（D1） | 帳簿 |

- `key_wraps(id TEXT PK, kind TEXT CHECK(kind IN ('passkey','recovery')), credential_id TEXT NULL, salt BLOB, iv BLOB, tag BLOB, wrapped BLOB, created_at)`。passkey は資格情報ごとに 1 行、recovery は常に 1 行（部分 UNIQUE）。`kind='passkey'` ⇔ `credential_id` が NOT NULL。
- `auth.sqlite` は秘密を持たない（公開鍵、PRF の salt、包んだ DK、トークンのハッシュ、操作の記録）。マイグレーションは `drizzle/auth`（新しい drizzle の設定 `drizzle.auth.config.ts`）。registry のマイグレーションから認証の表を消す（既存データを捨てるので、registry のマイグレーションは作り直してよい）。
- 「初回の設定が済んだ」の判定は `key_wraps` に recovery の行があること。
- 開き方（`packages/db/src/tenant-store.ts`）: ドライバーは `better-sqlite3-multiple-ciphers`。開いた直後に `PRAGMA cipher='sqlcipher'`、`PRAGMA key="x'<hex>'"` を設定し、続けて `journal_mode`・`foreign_keys`。鍵は `setDataKey(dk)` で渡した DK から D1 で作る。DK がない（施錠中）ときに `openRegistry`・`openTenant` を呼ぶと `VaultLockedError` を投げる。`clearDataKey()` は開いたハンドルを全部閉じ、DK のバッファを `fill(0)` する。
- 誤った鍵で開いたときは `SQLITE_NOTADB` を例外として上げる。空の DB として扱ったり作り直したりしない（invest-copilot の落とし穴 7）。
- テスト: `useTempDataDir` が固定のテスト用 DK を `setDataKey` し、`cleanup` で `clearDataKey` する。既存の db・server のテストは鍵を意識せずに動く。

## D3 server のメモリー上の状態

- vault: 解錠済みの DK か null（`lib/vault.ts`。写す元: invest-copilot `vault.ts`）。解錠 = `setDataKey`、施錠 = `clearDataKey`。
- セッションは `auth.sqlite` の `sessions`（今のまま、トークンのハッシュだけ）。種類は `normal`（全権）と `recovery`（10 分、パスキーの登録だけ）。**起動時と施錠時に `sessions` を全部消す**（再起動で DK が消えるので、残ったセッションは使えない）。
- 全権セッションは無操作 30 分で失効し、有効なセッションが 1 つもなくなったら施錠する（回復のセッションの間も DK が要るので、回復のセッションも数える）。判定は `lib/session-sweeper.ts`（`sweepSessions`、1 分ごとの `startSessionSweeper`）。**新しいセッションを入れてから期限切れを掃除する**（逆にすると解錠の直後に施錠される。落とし穴 5）。
- チャレンジ: 今の `lib/challenges.ts`（メモリー、5 分、1 回限り）。

## D4 流れ

1. 初回の設定（`key_wraps` が空、かつ Host が許可の一覧にあるとき）: 登録の options（`residentKey: required`、`userVerification: required`、`extensions.prf.eval.first = prf_salt`）→ 検証。登録で PRF の出力が返らない認証器のため、続けて認証を 1 回行い出力を得る（`prf_required`）。`prf.enabled` が真でなければ 400 `PRF_UNSUPPORTED`（画面で iCloud キーチェーン・1Password などを案内）。DK と回復キーを作り、包みを 2 行作り、`data/` の registry と tenants を空から作る（前の registry・tenants は消さず `data/discarded-<時刻>/` に移す）。回復キーは応答で 1 回だけ返す。全権セッションを発行する。
2. サインイン: 認証の options（`extensions.prf.evalByCredential` に資格情報ごとの `prf_salt`）→ 署名を検証 → PRF の出力で包みを開く → 解錠 → 全権セッション。
3. 回復: 回復キー → 包みが開けたら解錠し、recovery セッション（10 分）。できるのは新しいパスキーの登録だけ。登録に成功したら、新しい回復キーで recovery の包みを差し替え、新しいキーを 1 回だけ返し、全権セッションに上げる。
4. パスキーの追加・削除、回復キーの再発行: 全権セッションに加え、直近 5 分以内のパスキーの再認証を要求する（403 `REAUTH_REQUIRED`。`POST /api/auth/reauth/options`・`verify`、`lib/reauth.ts`）。最後の 1 本のパスキーは削除できない。パスキーを削除したら、その包みも同じトランザクションで消す。
5. 施錠: サインアウト（`POST /api/auth/sign-out`）で全セッションを消して施錠する。
- PRF の値の変換: server は options の `eval.first`・`evalByCredential` を base64url で返す。画面は bytes に直して `startRegistration`・`startAuthentication` に渡し、`clientExtensionResults.prf.results.first` を base64url に戻して送る（落とし穴 1。写す元: invest-copilot `src/app/lib/webauthnClient.ts`）。PRF の出力は署名の対象外なので、正しさは包みが開けたかで判定する（落とし穴 3）。

## D5 保護の範囲

- 回復キーの試行の失敗の待ちは 1 秒。本文のとおり全体のロックはしない。
- 公開の手続きは `requiresAuth`（`packages/domain/src/auth/access.ts`）の完全一致の一覧だけ（INV-29 のまま。手続きの名前が変われば一覧と `auth-coverage.test.ts` を直す）。
- それ以外の `/api/*` は全権セッションと解錠済みの vault を要求する。セッションがなければ今の 401、セッションがあって施錠中なら 401 `LOCKED`。Host → CSRF → 認証の順は変えない。
- 回復キーの試行: 失敗ごとに 1 秒待たせる。全体のロックはしない（今のロックをやめる）。
- 許すオリジンと RP ID は今の `lib/origin.ts` のまま（`localhost`。127.0.0.1 は 421）。

## D6 画面

- 施錠中は解錠の画面: 「パスキーで解錠」と「回復キーで解錠」。`key_wraps` が空なら初回の設定（パスキーを作る → 回復キーを表示、保管の確認を付けるまで先へ進めない）。
- 設定のセキュリティ: パスキーの一覧（追加・削除）、回復キーの再発行、施錠のボタン、セッションの一覧（今のもの）。
- API が 401 `LOCKED` を返したら解錠の画面に戻る。

## D7 起動と背景の処理

- `main.ts` は起動時に `auth.sqlite` だけを開き、`sessions` を消す。registry と tenants は開かない。
- バックアップの定期実行（004 R10）、定期仕訳の自動登録（005 R18）は、解錠で始め、施錠で止める（`lib/startup.ts` を vault の状態に結びつける）。`.tmp/backup-snapshot-*/` の掃除は起動時のまま。
- `fm serve` の扱いは変えない。
- `pnpm verify:freee --continue` は使えない（実行ごとに乱数の DK で作るため。利用者の判断でそのままにする）。

## D8 使うもの

- `better-sqlite3-multiple-ciphers` 13.0.3（`better-sqlite3` を置き換え。利用者が 2026-10-30 に承認。同梱のビルド済みバイナリで動き、ビルドのスクリプトは不要）。
- `@simplewebauthn/server` 14.0.3・`@simplewebauthn/browser` 14.0.0（今のまま）。
- invest-copilot（`~/Documents/invest-copilot`）から写すもの: `src/lib/server/{vaultCrypto,vault,recoveryKey,authService,webauthnResponse}.ts`、`src/app/lib/webauthnClient.ts`、`tests/e2e/helpers/{virtual-authenticator,vault}.ts`。Next.js 固有の部分は Hono に合わせる。

## D9 バックアップ（ADR 0007 の差分）

- 暗号の鍵を、パスフレーズ + Argon2id から D1 のバックアップの鍵に替える。AES-256-GCM でヘッダー全体を AAD にするのは今のまま。
- ヘッダーに、作成時の recovery の包み（`salt`、`iv`、`tag`、`wrapped`）を入れる。新しい Mac では回復キーだけで復元できる。
- 本体の SQLite の写しは `VACUUM INTO` で作る（暗号化された DB の写しは同じ鍵で暗号化されるので、写しの暗号を `PRAGMA rekey=''` で外す）。中の写しは平文の SQLite のままで、外側の AES-GCM が守る。`auth.sqlite` はバックアップに含めない（今の「認証の表を含めない」と同じ）。
- 定期実行は解錠中だけ（D7）。キーチェーンのバックアップのパスフレーズ、パスフレーズの設定・変更の画面と API、「パスフレーズが使えない」の警告はなくす。`SecretStore`（キーチェーン）は外部の AI の API キー（006）のために残す。
- 復元のコマンド（`pnpm restore`）は回復キーを標準入力から受け取る（端末ならエコーなし。パイプなら 1 行目で、そのときは `--yes` が要る。引数・環境変数では受け取らない）。ヘッダーの包みで DK を開き、開けなければ今のデータ場所の `auth.sqlite` の recovery の包みでも試す（DK は変わらないので、回復キーを再発行した後でも古いバックアップを戻せる）。復元した後は、`auth.sqlite` を recovery の包みだけにして作り直す（パスキーとセッションは空）。次の起動で回復キーで解錠し、パスキーを登録する。
- 画面からのファイルの検査（004）は、解錠中に DK で行う（パスフレーズの入力はなくす）。
- `server-<id>/snap` がテストの後に残る漏れを直す（バックアップのテストの片付けの順序。ランナーが片付けの後に `snap` を作っている）。

## D10 不変条件（`specs/INVARIANTS.md` に足す）

- INV-51: DK・DB の鍵・バックアップの鍵は、平文でディスク・ログ・環境変数・応答に出ない（回復キーは作成・再発行の応答で 1 回だけ）。施錠中に registry・tenants を開く経路はない。
- INV-52: どの包み（passkey・recovery）を開いても同じ DK になる。AAD（kind・credential_id）を替えた包み、誤った ikm では開けない。
- INV-53: 設定済みなら recovery の包みは常に 1 行、passkey の包みはパスキーと 1 対 1 で、パスキーは 1 本以上。
- INV-54: バックアップは、そのときの回復キーでも、取った時点の回復キーでも復号できる。誤った鍵では本体を 1 バイトも使わずに失敗する。

## D11 テスト

- 単体: 包む・開く（正しい鍵、別の鍵、AAD の差し替え。INV-52 は fast-check）、回復キーの生成と正規化、DB の鍵の導出（registry と tenant で別、同じ DK なら同じ）、施錠中の `openRegistry` が `VaultLockedError`、誤った鍵で `SQLITE_NOTADB`、DB のファイルに平文が残らない、ガードの網羅（INV-29）、セッションの失効と施錠、再認証の要求、回復の遅延。
- E2E: 仮想の認証器に `hasPrf: true`。設定 → 帳簿の操作 → 施錠 → パスキーで解錠して見える → 施錠 → 回復キーで解錠 → 新しいパスキー → 古い回復キーが使えない。テストの間でパスキーを書き出して戻す今のやり方は使えない（戻したパスキーは PRF を持たない。落とし穴 4）。テストの間は回復キーを引き継ぎ、回復キーで解錠して新しいパスキーを登録してから始める（invest-copilot `tests/e2e/helpers/vault.ts` の `enterVault`）。
- E2E は利用者の端末で実行する（サンドボックスはポートを開けない）。

## D12 文書

- ADR 0011（パスキー PRF でデータ鍵を包み、DB 全体を暗号化する）を足す。ADR 0006 の回復コード・セッションの節と ADR 0007 のパスフレーズ・キーチェーンの節は 0011 で置き換える（状態の書き換えは各 ADR の書式に従う）。
- AGENTS.md の 004 の節（キーチェーン、バックアップのパスフレーズ、`hashToken` の回復コード）、`docs/requirements.md`、README を直す。
