# Research: 認証とバックアップ

**Feature**: [spec.md](./spec.md) | **Date**: 2026-10-20

既存の構成（scout の調査）: API は `127.0.0.1:8787` 固定で、web は vite の dev サーバー（`127.0.0.1:5173`、`/api` を proxy）だけ。ビルド済みの web を配信する仕組みはない。データは `<dataDir>/registry.sqlite`（事業体の一覧だけ）と `<dataDir>/tenants/<id>.sqlite`。DB は初回のアクセスで開き、drizzle のマイグレーションを当てる（registry と tenant でフォルダが別）。認証・暗号の依存はない。

## R1. パスキーの検証は @simplewebauthn を使う

- **Decision**: サーバーは `@simplewebauthn/server`（14.x、ESM、node>=20）で登録・認証の options の生成と応答の検証を行う。ブラウザは `@simplewebauthn/browser` の `startRegistration` / `startAuthentication` を使う。attestation は `none`、userVerification は `required`（Touch ID）、residentKey は `preferred`
- **Rationale**: 検証には CBOR・COSE 鍵・authenticatorData の解析、署名・origin・RP ID・カウンタの検査が要る。自作は誤りが認証の破れに直結する（Constitution VII は「標準機能や既存の依存で代替できない場合に限って追加」で、これに当たる）。出典: https://simplewebauthn.dev/docs/packages/server 、https://www.w3.org/TR/webauthn-3/
- **Alternatives**: `node:crypto` だけで検証 → CBOR/COSE の解析を自作することになり、検証の漏れの危険が大きい
- **Complexity Tracking**: 依存の追加（server 1、web 1）を plan に記す

## R2. 接続先の名前（オリジン）と RP ID

- **Decision**: RP ID は接続先のホスト名そのもの。ローカルは `localhost`（IP アドレスは RP ID にできない。`http://localhost` は secure context）。リモートは Tailscale の `<machine>.<tailnet>.ts.net`。パスキーは RP ID ごとに別（spec の Assumptions どおり）
  - 開発: `http://localhost:5173`（vite。`/api` を 8787 へ proxy）
  - ローカルの本番: `http://localhost:8787`（server がビルド済みの web を配信。R3）
  - リモート: `https://<name>.ts.net` → `tailscale serve` → `http://127.0.0.1:8787`
- **変更**: vite の `server.host` は `127.0.0.1` のまま、`server.allowedHosts` に `localhost` を足す。E2E の `baseURL` と README の URL を `http://localhost:5173` に直す
- 出典: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts 、W3C WebAuthn §5.1.3（RP ID は domain に限る）

## R3. server がビルド済みの web を配信する（リモートのため）

- **Decision**: `apps/server` に、`TREBUCHET_WEB_DIST`（既定は `apps/web/dist`）が存在すれば `@hono/node-server/serve-static` で配信し、`/api` 以外の未知のパスは `index.html` を返す（SPA）処理を足す。`pnpm start`（web をビルドして server を起動）を足す。リモートは `tailscale serve --bg --https=443 http://127.0.0.1:8787`
- **Rationale**: リモートの origin を1つ（8787）にまとめ、Host と Origin の検査を server だけで行える。vite の dev サーバーを外に見せない
- **ゲート（Setup）**: `tailscale serve` の転送で server に届く `Host` と `X-Forwarded-Host` を、利用者の Mac で確かめる（公式に記載がない）。結果で R6 の名前の取り方を決める
- 出典: https://tailscale.com/kb/1312/serve （tailnet の中だけ。Funnel は使わない）、https://hono.dev/docs/getting-started/nodejs

## R4. 認証の情報は registry の DB に置く

- **Decision**: `registry.sqlite` に表を足す（マイグレーション `drizzle/registry/0001_auth_backup`）: `passkeys`、`recovery_codes`、`sessions`、`auth_events`、`app_settings`、`backup_runs`。`auth_events` は更新・削除をトリガーで禁止（Constitution II）
- **Rationale**: アプリ全体の設定を置ける DB は registry だけ。事業体の DB に置くと、事業体ごとに認証が分かれてしまう

## R5. セッションは乱数のトークンと cookie

- **Decision**: サインインで 32 バイトの乱数のトークンを作り、cookie（`HttpOnly`、`SameSite=Strict`、`Path=/`、https のときは `Secure`）で渡す。DB には SHA-256 のハッシュだけを保存する。最後の操作から 8 時間（`SESSION_IDLE_MS`）で失効。操作のたびに最後の操作の時刻を更新する（1分に1回まで）。セッションはオリジン（RP ID）を持ち、別のオリジンからは使えない
- **Rationale**: 依存を足さずに済み、サーバー側で個別に無効化できる（FR-013）。署名つきの cookie だけでは無効化ができない
- **Alternatives**: JWT → 無効化に失効の表が要り、利点がない

## R6. 接続先とクロスサイトの検査

- **Decision**: 全ての `/api` の要求に、次の順でミドルウェアを掛ける
  1. **Host の検査**（FR-011、DNS rebinding の対策）: 許す名前は `localhost:5173`、`localhost:8787`、`127.0.0.1:8787`（ヘルスチェックと E2E の server の起動確認だけ）と、リモートが有効なら登録した ts.net の名前。外れたら 421 `HOST_NOT_ALLOWED`
  2. **CSRF**（FR-009）: `hono/csrf` で、変更の要求（POST・PUT・PATCH・DELETE）の `Origin`（なければ `Sec-Fetch-Site`）が許すオリジンに一致することを確かめる。cookie の `SameSite=Strict` と合わせる
  3. **認証**（FR-003）: `/api/health` と `/api/auth/*` の公開の手続き以外は、有効なセッションがなければ 401 `UNAUTHENTICATED`
- 出典: https://hono.dev/docs/middleware/builtin/csrf 、https://hono.dev/docs/helpers/cookie

## R7. 回復コード

- **Decision**: 128 ビットの乱数を Crockford の base32（区切りつき、例 `XXXX-XXXX-...`）で表す。保存は SHA-256 のハッシュだけ（乱数が十分に長いので遅いハッシュは要らない）。有効なものは常に1つ。誤りは `auth_events` から直近15分の連続の失敗を数え、5回で 429 `RECOVERY_LOCKED`
- **Rationale**: 追加の表や依存なしで FR-006 を満たす

## R8. バックアップの形式

- **Decision**: 1つのファイル（拡張子 `.tbk`）:
  - **ヘッダー**（平文の JSON、長さつき）: 形式の版、アプリの版（registry と tenant のマイグレーションの適用数）、作った Mac の ID、作成日時、鍵の導出の parameters（Argon2id、salt 16 バイト、memory 65536 KiB、passes 3、parallelism 1）、nonce（12 バイト）
  - **本体**: アーカイブ（JSON のマニフェスト〔ファイル名、長さ、SHA-256、事業体ごとの要約〕＋各 SQLite のスナップショットの連結）を AES-256-GCM で一度に暗号化。ヘッダー全体を AAD にして、ヘッダーの改ざんも検知する。認証タグ 16 バイト
  - 鍵: `crypto.argon2("argon2id", ...)`（Node 24.7 以降。Node 26.9 で使える）で 32 バイト
  - 帳簿の大きさは数 MB〜数十 MB の想定なので、ファイル全体をメモリで扱う。復号はタグの検証が通るまで平文を使わない（GCM の一度の復号で `final()` が通ってから使う）
- **Rationale**: 依存なし（Constitution VII）。途中で切れたファイル・1バイトの書き換え・誤ったパスフレーズは、どれもタグの検証で落ちる（SC-004）。OWASP の Argon2id の最小（19 MiB、t=2）より強い値にする
- **Alternatives**: チャンクごとの GCM（ストリーム）→ 帳簿の大きさでは不要（YAGNI）。tar・zip の依存 → 自前の単純なアーカイブで足りる
- 出典: https://nodejs.org/api/crypto.html （argon2、createCipheriv）、https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- **置き場所**: 形式（書く・読む・検証）は `packages/db/src/backup/`（データのファイルを扱うのは db に閉じる）。世代の選び方・自動のバックアップを取るかの判断は domain の純関数

## R9. 一貫したスナップショット

- **Decision**: 各 DB に `VACUUM INTO '<一時ファイル>'` を実行してスナップショットを作る。書き込みを止めない。registry のスナップショットからは、認証の表（`passkeys`・`recovery_codes`・`sessions`・`auth_events`）と端末に結びつく設定（Mac の ID）の行を消してから詰める（FR-028）
- **Rationale**: 一度で一貫した内容になり、別の接続の書き込みでやり直しにならない（`db.backup()` はやり直しがある）。出典: https://www.sqlite.org/lang_vacuum.html
- **複数の DB の間の一貫性**: DB ごとに時点が少しずれる。事業体の DB は互いに独立で、registry は事業体の一覧だけなので許容する。事業体の追加の直後のずれは、マニフェストに registry にない事業体を載せない（または逆）ことで防ぐ

## R10. 自動のバックアップと「変更があれば」

- **Decision**: server の起動中、1時間ごとに「最後の成功から 24 時間以上たったか」を見る。たっていればスナップショットを作り、アーカイブの内容の SHA-256 を前回の成功のものと比べる。同じなら `skipped`（変更なし）として記録し、ファイルは書かない。違えば暗号化して書く
- **Rationale**: 変更の検知のために帳簿の書き込みの経路に手を入れずに済む
- **知らせ**: 最後の成功から 48 時間以上、または直近の自動の実行が失敗なら、`GET /api/backup/status` が `alert` を返し、web は全画面の上部に知らせる（FR-020）

## R11. 置き場所への書き込みと世代

- **Decision**: ファイル名 `trebuchet-<macId 先頭8文字>-<YYYYMMDD-HHmmss>.tbk`（UTC）。同じフォルダに `.trebuchet-<...>.tbk.partial` で書き、`fsync` の後に読み戻して復号・検証（FR-022）し、`rename` で最終の名前にする（FR-018）。成功の後に、この Mac の名前のファイルだけを世代の規則（直近 30 日は日ごとに最新の1つ、それより前は月ごとに最新の1つ、7年より古いものは消す）で整理する（FR-021）。整理の対象の選び方は domain の純関数 `selectBackupsToPrune`
- **空きの不足**: 書き込みの失敗をそのまま失敗として記録し、世代は整理しない

## R12. キーチェーン

- **Decision**: `node:child_process` で `/usr/bin/security` を呼ぶ。保存は `add-generic-password -U -a trebuchet -s trebuchet-backup -w`、読み出しは `find-generic-password -a trebuchet -s trebuchet-backup -w`。パスフレーズは引数に載せない（ps で見えるため）
- **ゲート（Setup）**: `-w` を最後に置いたときに標準入力から読めるかを、利用者の Mac で確かめる（公式の man で「最後に置くと入力を求める」とあるが、標準入力からの読み込みは未確認。出典: `man security`）。読めない場合は、`security -i`（対話モード）に標準入力でコマンドを流す方法を試す。どちらも駄目なら、パスフレーズを保管しない（自動のバックアップは起動のたびに入力を求める）に落とす
- **抽象化**: `SecretStore`（get/set/delete）のポートにし、テストはメモリの偽物を使う。サンドボックスのテストでキーチェーンに触れない

## R13. 復元は server を止めて行うコマンド

- **Decision**: 復元の本体は `scripts/restore-backup.ts`（`pnpm restore -- --file <.tbk> [--data-dir <dir>]`。パスフレーズは端末から入力、エコーなし）。手順: ファイルの読み込み → 復号と検証 → 版の確認（今より新しい版は拒否）→ 要約の表示と確認 → データ場所が空でなければ、今の帳簿のバックアップ（同じ形式、同じパスフレーズで）を `<dataDir>/../trebuchet-before-restore-<日時>.tbk` に取る → `<dataDir>.restore-<日時>/` に展開 → 展開した DB を開いてマイグレーションを当て（古い版の更新、FR-027）、整合性の検査（`PRAGMA integrity_check`）→ 元の `<dataDir>` を `<dataDir>.before-restore-<日時>/` に改名し、展開したものを `<dataDir>` に改名（FR-026）。server が動いている（8787 が応答する）ときは中止する
- **画面**: 設定の画面では、ファイルを選んでパスフレーズを入れると「検査」（復号・版・要約の表示）までを行い、復元の手順（server を止めてコマンドを実行）を示す。server が動いたまま DB を差し替えないため
- **Rationale**: 新しい Mac ではパスキーがなく画面に入れない（FR-029）。動いている server の DB の差し替えは、開いた接続の扱いが複雑になる（VII）
- **認証**: 復元した registry には認証の行がない → 次の起動で FR-001 の登録から始まる（FR-028）

## R14. Mac の ID

- **Decision**: 最初の起動で UUID を作り `app_settings` に保存する。バックアップのファイル名とヘッダーに使う。復元では元の Mac の ID を持ち込まない（今の Mac の ID を保つ。新しい Mac では新しく作る）

## R15. E2E とテスト

- **Decision**: E2E は Chromium の仮想の認証器（CDP の `WebAuthn.addVirtualAuthenticator`）でパスキーの登録とサインインを行う。既存の2本の E2E は、最初に登録とサインインをする共通の手順を足す。server のテストは、テスト用のヘルパーでセッションを直接作って cookie を付ける（認証の経路のテストとは別）
- **Rationale**: 認証を外す設定（環境変数での無効化など）を作らない。本番で誤って無効になる危険を作らない
- **サンドボックス**: このセッションではローカルのポートを開けないため、E2E と dev サーバーの確認は利用者の端末で行う（003 と同じ）

## R16. 不変条件（INV-25〜INV-29）

- data-model.md §4 に、復元の往復（INV-25）、改ざんの検知（INV-26）、世代の選び方（INV-27）、セッションの失効（INV-28）、認証の要否（INV-29）を足し、fast-check のプロパティテスト・統合テストで検証する
