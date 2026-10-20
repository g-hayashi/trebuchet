# Research: 認証とバックアップ

**Feature**: [spec.md](./spec.md) | **Date**: 2026-10-20

既存の構成（scout の調査）: API は `127.0.0.1:8787` 固定で、web は vite の dev サーバー（`127.0.0.1:5173`、`/api` を proxy）だけ。ビルド済みの web を配信する仕組みはない。データは `<dataDir>/registry.sqlite`（事業体の一覧だけ）と `<dataDir>/tenants/<id>.sqlite`。DB は初回のアクセスで開き、drizzle のマイグレーションを当てる（registry と tenant でフォルダが別）。認証・暗号の依存はない。

## R1. パスキーの検証は @simplewebauthn を使う

- **Decision**: サーバーは `@simplewebauthn/server`（14.x、ESM、node>=20）で登録・認証の options の生成と応答の検証を行う。ブラウザは `@simplewebauthn/browser` の `startRegistration` / `startAuthentication` を使う。attestation は `none`、userVerification は `required`（Touch ID）、residentKey は `preferred`。challenge はサーバーのメモリに5分、最大100件まで保持し（要求ごとに1つ。成功・失敗で破棄）、100件を超えたら古いものから捨てる（公開の options の呼び出しでメモリを増やされないため）
- **Rationale**: 検証には CBOR・COSE 鍵・authenticatorData の解析、署名・origin・RP ID・カウンタの検査が要る。自作は誤りが認証の破れに直結する（Constitution VII は「標準機能や既存の依存で代替できない場合に限って追加」で、これに当たる）。出典: https://simplewebauthn.dev/docs/packages/server 、https://www.w3.org/TR/webauthn-3/
- **Alternatives**: `node:crypto` だけで検証 → CBOR/COSE の解析を自作することになり、検証の漏れの危険が大きい
- **Complexity Tracking**: 依存の追加（server 1、web 1）を plan に記す

## R2. 接続先の名前（オリジン）と RP ID

- **Decision**: RP ID は接続先のホスト名そのもの。ローカルは `localhost`（IP アドレスは RP ID にできない。`http://localhost` は secure context）。リモートは Tailscale の `<machine>.<tailnet>.ts.net`。パスキーは RP ID ごとに別（spec の Assumptions どおり）
  - 開発: `http://localhost:5173`（vite。`/api` を 8787 へ proxy）
  - ローカルの本番: `http://localhost:8787`（server がビルド済みの web を配信。R3）
  - リモート: `https://<name>.ts.net` → `tailscale serve` → `http://127.0.0.1:8787`
- **許す Host・オリジン・RP ID の決定は `apps/server/src/lib/origin.ts` の1か所にまとめる**（Host の検査、CSRF の許すオリジン、WebAuthn の RP ID と期待する origin、ローカルの Host かの判定が、すべてここを使う）
- **変更**: vite の `server.host` は `127.0.0.1` のまま、`server.allowedHosts` に `localhost` を足す。E2E の `baseURL` と README の URL を `http://localhost:5173` に直す
- 出典: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts 、W3C WebAuthn §5.1.3（RP ID は domain に限る）

## R3. server がビルド済みの web を配信する（リモートのため）

- **Decision**: `apps/server` に、`TREBUCHET_WEB_DIST`（既定は `apps/web/dist`）が存在すれば `@hono/node-server/serve-static` で配信し、`/api` 以外の未知のパスは `index.html` を返す（SPA）処理を足す。静的ファイル（`index.html`・JS・CSS）は帳簿のデータを含まないので、認証なしで配信してよい（FR-003）。`pnpm start`（web をビルドして server を起動）を足す。リモートは `tailscale serve --bg --https=443 http://127.0.0.1:8787`
- **Rationale**: リモートの origin を1つ（8787）にまとめ、Host と Origin の検査を server だけで行える。vite の dev サーバーを外に見せない
- **ゲート（Setup）**: `tailscale serve` の転送で server に届く `Host` と `X-Forwarded-Host` を、利用者の Mac で確かめる（公式に記載がない）。結果で R6 の名前の取り方を決める
- **ゲートの結果（2026-10-20）**: 未確認（利用者の Mac に Tailscale が未導入）。US4（T016〜T018）の着手の前に確かめる
- 出典: https://tailscale.com/kb/1312/serve （tailnet の中だけ。Funnel は使わない）、https://hono.dev/docs/getting-started/nodejs

## R4. 認証の情報は registry の DB に置く

- **Decision**: `registry.sqlite` に表を足す（マイグレーション `drizzle/registry/0001_auth_backup`）: `passkeys`、`recovery_codes`、`sessions`、`auth_events`、`app_settings`、`backup_runs`、`pairing_tokens`（7表）。`auth_events` は更新・削除をトリガーで禁止（Constitution II）
- **Rationale**: アプリ全体の設定を置ける DB は registry だけ。事業体の DB に置くと、事業体ごとに認証が分かれてしまう

## R5. セッションは乱数のトークンと cookie

- **Decision**: サインインで 32 バイトの乱数のトークンを作り、cookie（`HttpOnly`、`SameSite=Strict`、`Path=/`、https のときは `Secure`）で渡す。DB には SHA-256 のハッシュだけを保存する（ハッシュは db の `hashToken` に一本化し、server はそれを使う。server で別に SHA-256 を書かない）。最後の操作から 8 時間（`SESSION_IDLE_MS`）で失効。操作のたびに最後の操作の時刻を更新する（1分に1回まで）。セッションはオリジン（RP ID）と、作ったパスキー（`passkey_id`）を持つ。別のオリジンからは使えない。パスキーを削除したら、そのパスキーで作ったセッションを失効する。回復用の一時セッション（`kind = recovery`、作成から10分）は同じ表の別の種類で、パスキーの登録の手続きにだけ使える
- **Rationale**: 依存を足さずに済み、サーバー側で個別に無効化できる（FR-013）。署名つきの cookie だけでは無効化ができない
- **Alternatives**: JWT → 無効化に失効の表が要り、利点がない

## R6. 接続先とクロスサイトの検査

- **Decision**: 全ての `/api` の要求に、次の順でミドルウェアを掛ける。許す名前・オリジンは `lib/origin.ts`（R2）から取る
  1. **Host の検査**（FR-011、DNS rebinding の対策）: 許す名前は `localhost:5173`、`localhost:8787`、`127.0.0.1:8787`（ヘルスチェックと E2E の server の起動確認だけ）と、リモートが有効なら登録した ts.net の名前。外れたら 421 `HOST_NOT_ALLOWED`
  2. **CSRF**（FR-009）: `hono/csrf` は使わない（`hono/csrf` は本文の形式（フォームの Content-Type）にしか検査を掛けず、JSON の POST と本文なしの DELETE を通すため）。自前の小さなミドルウェアで、GET・HEAD・OPTIONS 以外の要求は、`Content-Type` によらず、`Origin` が許すオリジンの一覧（`lib/origin.ts`）にあること。`Origin` がなければ `Sec-Fetch-Site` が `same-origin` であること。どちらでもなければ 403 `CSRF_REJECTED`。cookie の `SameSite=Strict` と合わせる
  3. **認証**（FR-003）: 公開の手続きの完全一致の一覧（data-model §3 の `requiresAuth`）以外は、有効なセッションがなければ 401 `UNAUTHENTICATED`。公開の手続きのうち前提のあるもの（`register/*`: パスキー0件かつローカルの Host、`recovery/register/*`: 回復用の一時セッション、`pairing/register/*`: 有効なペアリングのトークン）は、前提がなければ 401 か 409 か 421 で拒否する
- 出典: https://hono.dev/docs/helpers/cookie 、https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site

## R7. 回復コード

- **Decision**: 128 ビットの乱数を Crockford の base32（区切りつき、例 `XXXX-XXXX-...`）で表す。保存は SHA-256 のハッシュだけ（乱数が十分に長いので遅いハッシュは要らない）。有効なものは常に1つ
  - `POST /auth/recovery/verify` は、コードが正しければ回復用の一時セッション（10分）を発行するだけで、**コードを消費しない**。一時セッションの間は、パスキーの登録をやり直せる（登録の途中で中断しても、コードを失わない）
  - 新しいパスキーの登録が成功したとき（`recovery/register/verify`）に、使ったコードに `used_at` を付けて無効にし、新しいコードを出して、通常のセッションを発行する
  - **ロック**: 直近の連続した `recovery_failed` が5回以上、かつ最後の失敗から15分未満のとき、429 `RECOVERY_LOCKED`。ロック中の試行は検証せず、`recovery_failed` に記録しない（ロックは延びない）。15分たつか、成功（`recovery_used`）で連続が切れる
- **Rationale**: 追加の表や依存なしで FR-006 を満たす。コードを入力の成功で消費すると、続く登録の失敗で利用者が帳簿に戻れなくなる

## R8. バックアップの形式

- **Decision**: 1つのファイル（拡張子 `.tbk`）:
  - **ヘッダー**（平文の JSON、長さつき）: 形式の版、アプリの版（registry と tenant のマイグレーションの適用数）、作った Mac の ID、作成日時、鍵の導出の parameters（Argon2id、salt 16 バイト、memory 65536 KiB、passes 3、parallelism 1）、nonce（12 バイト）
  - **本体**: アーカイブ（JSON のマニフェスト〔ファイル名、長さ、SHA-256、事業体ごとの要約〕＋各 SQLite のスナップショットの連結）を AES-256-GCM で一度に暗号化。ヘッダー全体を AAD にして、ヘッダーの改ざんも検知する。認証タグ 16 バイト
  - 鍵: `crypto.argon2("argon2id", ...)`（Node 24.7 以降。Node 26.9 で使える）で 32 バイト
  - 帳簿の大きさは数 MB〜数十 MB の想定なので、ファイル全体をメモリで扱う。復号はタグの検証が通るまで平文を使わない（GCM の一度の復号で `final()` が通ってから使う）
  - **版**: アプリの版（registry と tenant のマイグレーションの適用数）が今のアプリと**完全に一致しなければ拒否**する（新しくても古くても。開発中なので帳簿の形式の更新はしない）。`decryptBackup` は、形式の版が 1 でなければ復号の前に、`appVersion` の不一致は復号と検証が通った後に、`VERSION_MISMATCH` を返す
- **Rationale**: 依存なし（Constitution VII）。途中で切れたファイル・1バイトの書き換え・誤ったパスフレーズは、どれもタグの検証で落ちる（SC-004）。OWASP の Argon2id の最小（19 MiB、t=2）より強い値にする
- **Alternatives**: チャンクごとの GCM（ストリーム）→ 帳簿の大きさでは不要（YAGNI）。tar・zip の依存 → 自前の単純なアーカイブで足りる
- 出典: https://nodejs.org/api/crypto.html （argon2、createCipheriv）、https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- **置き場所**: 形式（書く・読む・検証）は `packages/db/src/backup/`（データのファイルを扱うのは db に閉じる）。世代の選び方・自動のバックアップを取るかの判断は domain の純関数

## R9. 一貫したスナップショット

- **Decision**: 各 DB に `VACUUM INTO '<一時ファイル>'` を実行してスナップショットを作る。書き込みを止めない。**バックアップに `app_settings` を含めない**（すべて端末に結びつく設定: Mac の ID、バックアップの置き場所、リモートの設定など）。`backup_runs` も含めない。registry の写しは、`VACUUM INTO` の後に次の順で加工する（FR-028）
  1. 写しの `CREATE TRIGGER` の SQL を `sqlite_master` から控え、トリガーを `DROP` する（`auth_events` の削除禁止のトリガーが行の削除を止めるため）
  2. `passkeys`・`recovery_codes`・`sessions`・`auth_events`・`app_settings`・`backup_runs`・`pairing_tokens` の全行を消す
  3. 控えた SQL でトリガーを作り直す（復元後の registry にもトリガーを残す）
  4. `VACUUM`（消した行の内容を写しのファイルの空き領域に残さない）
- **平文の写しの扱い**: 各 DB の写しは平文なので、`.tmp/backup-snapshot-<乱数>/` の下に作り、`try/finally` で必ず消す。server の起動時に、前回の異常終了で残った `.tmp/backup-snapshot-*/` を消す
- **Rationale**: 一度で一貫した内容になり、別の接続の書き込みでやり直しにならない（`db.backup()` はやり直しがある）。出典: https://www.sqlite.org/lang_vacuum.html
- **複数の DB の間の一貫性**: DB ごとに時点が少しずれる（FR-017は「DB ごとに、ある一時点の一貫した状態」）。事業体の DB は互いに独立で、registry は事業体の一覧だけなので許容する。事業体の追加の直後のずれは、マニフェストに registry にない事業体を載せない（または逆）ことで防ぐ

## R10. 自動のバックアップと「変更があれば」

- **Decision**: server の起動中、1時間ごとに判断する。**「最後の確認」= `backup_runs` の最後の「成功（succeeded）または変更なし（skipped）」**。24時間の判断と48時間の警告は、どちらも最後の確認で見る
  - 最後の確認から 24 時間以上たっていれば（確認が一度もなければ）、スナップショットを作り、アーカイブの内容の SHA-256 を前回の成功のものと比べる
  - **`skipped`（変更なし）にするのは、次の3つをすべて満たすときだけ**: ① 内容の SHA-256 が前回の成功と同じ、② 今の置き場所に、前回の成功のファイル（`backup_runs.file_name`）がある、③ パスフレーズを変えていない（`app_settings.backup_force_write` が立っていない）。1つでも欠ければ、暗号化して書く。skip のとき、ファイルは書かない
  - **手動の実行は skip しない**（内容が同じでも書く）。設定の保存・パスフレーズの変更の直後の実行も skip しない（これらは `manual` として即時に書き、`backup_force_write` を立てて、書いた成功で消す）
- **Rationale**: 変更の検知のために帳簿の書き込みの経路に手を入れずに済む。skip の条件を厳しくして、置き場所のファイルが消えたとき・パスフレーズが変わったときに最新の内容を必ず置く
- **知らせ**: `GET /api/backup/status` が `alert` を返し、web は全画面の上部に知らせる（FR-020）。次のいずれか:
  - 最後の確認から 48 時間以上（`STALE`）
  - 直近の実行が失敗（`LAST_RUN_FAILED`）。一度も成功していなくても、設定が済んでいる（フォルダとパスフレーズの設定がある）なら対象
  - 自動のバックアップに要るパスフレーズが使えない（`PASSPHRASE_NEEDED`。キーチェーンが空、または R12 の代替で未入力）。このとき自動のバックアップは止める

## R11. 置き場所への書き込みと世代

- **Decision**: ファイル名 `trebuchet-<macId 先頭8文字>-<YYYYMMDD-HHmmss>.tbk`（UTC）。同じフォルダに `.trebuchet-<...>.tbk.partial` で書き、`fsync` の後に読み戻して復号・検証（FR-022）し、`rename` で最終の名前にする（FR-018）。成功の後に、この Mac の名前のファイルだけを世代の規則（直近 30 日は日ごとに最新の1つ、それより前は月ごとに最新の1つ、7年より古いものは消す）で整理する（FR-021）。整理の対象の選び方は domain の純関数 `selectBackupsToPrune`
- **空きの不足**: 書き込みの失敗をそのまま失敗として記録し、世代は整理しない

## R12. キーチェーン

- **Decision**: `node:child_process` で `/usr/bin/security` を呼ぶ。保存は `add-generic-password -U -a trebuchet -s trebuchet-backup -w`、読み出しは `find-generic-password -a trebuchet -s trebuchet-backup -w`。パスフレーズは引数に載せない（ps で見えるため）
- **ゲート（Setup）**: `-w` を最後に置いたときに標準入力から読めるかを、利用者の Mac で確かめる（公式の man で「最後に置くと入力を求める」とあるが、標準入力からの読み込みは未確認。出典: `man security`）。読めない場合は、`security -i`（対話モード）に標準入力でコマンドを流す方法を試す
- **ゲートの結果（2026-10-20）**: `-w` を最後に置いて標準入力から渡す方法は**不可**（利用者の Mac で確認）。`security -i` の標準入力に `add-generic-password -U -a … -s … -w <パスフレーズ>` の1行を流す方法は**可**（保存した値を `find-generic-password … -w` で読み出せた）。**この方法を採用する**（パスフレーズは `security` の標準入力にだけ載り、引数・ps に出ない）。対話モードは行を空白で区切り引用符を解釈するため、パスフレーズは二重引用符で囲み、`"` と `\` をエスケープする。改行を含むパスフレーズは受け付けない（12文字以上の規則に加え、改行を拒否する）。読み出しは `find-generic-password -a trebuchet -s trebuchet-backup -w` の標準出力（末尾の改行を除く）
- **キーチェーンが使えない場合の代替**（ゲートがどちらも失敗したとき）: パスフレーズは、server の起動ごとに一度、設定の画面で入力させ、**メモリにだけ保持する**（`SecretStore` のメモリの実装を、キーチェーンの実装の代わりに `main.ts` で渡す。保存しない）。未入力の間は自動のバックアップを止め、`PASSPHRASE_NEEDED` で警告する（FR-015）。入力は `PUT /backup/passphrase`（`current` を省略できる。キーチェーン／メモリが空のときだけ）で行う
- **キーチェーンが空のとき**（別の Mac に移ったなど）: `PUT /backup/passphrase` の `current` を省略できる（`SecretStore` が空のときだけ。値があるのに `current` が違えば 422 `PASSPHRASE_WRONG`）。設定の画面で再入力を求める
- **抽象化**: `SecretStore`（get/set/delete）のポートにし、テストはメモリの偽物を使う。サンドボックスのテストでキーチェーンに触れない

## R13. 復元は server を止めて行うコマンド

- **Decision**: 復元の本体は `scripts/restore-backup.ts`（`pnpm restore -- --file <.tbk> [--data-dir <dir>]`。パスフレーズは端末から入力、エコーなし）。手順: ファイルの読み込み → 復号と検証 → 版の確認（アプリの版が今と**一致しなければ**拒否。R8）→ 要約の表示と確認（同じ事業体が既にあれば事業体ごとの差〔仕訳の件数、最後の更新〕も表示）→ データ場所が空でなければ、今の帳簿のバックアップ（同じ形式、同じパスフレーズで）を `<dataDir>/../trebuchet-before-restore-<日時>.tbk` に取る → `<dataDir>.restore-<日時>/` に展開 → 展開した DB を開いて整合性の検査（`PRAGMA integrity_check`。マイグレーションは当てない）→ 元の `<dataDir>` の `app_settings` の行を、展開した registry に引き継ぐ（端末に結びつく設定。R9 でバックアップに含めないため。Mac の ID を保つ）→ 元の `<dataDir>` を `<dataDir>.before-restore-<日時>/` に改名し、展開したものを `<dataDir>` に改名（FR-026）。server が動いている（8787 が応答する）ときは中止する
  - **復元の前のバックアップは、db の `snapshotDataDir`・crypto・`file` だけで書く**（server のバックアップの実行の関数を使わない。復元のコマンドは server なしで動く）。`backup_runs` には記録しない
  - **展開先の後始末**: 展開先 `<dataDir>.restore-<日時>/` は、成功すれば改名されて残らず、失敗すれば（`integrity_check` の失敗、改名の失敗を含む）消す。`<dataDir>.before-restore-<日時>/` は元の帳簿として残す（`.gitignore` に `data.restore-*/`・`data.before-restore-*/`・`*.tbk`）
- **画面**: 設定の画面では、ファイルを選んでパスフレーズを入れると「検査」（復号・版・要約の表示）までを行い、復元の手順（server を止めてコマンドを実行）を示す。server が動いたまま DB を差し替えないため。検査のファイルの上限を超えたら、既存の 413 `FILE_TOO_LARGE`
- **Rationale**: 新しい Mac ではパスキーがなく画面に入れない（FR-029）。動いている server の DB の差し替えは、開いた接続の扱いが複雑になる（VII）
- **認証**: 復元した registry には認証の行がない → 次の起動で FR-001 の登録から始まる（FR-028）

## R14. Mac の ID

- **Decision**: 最初の起動で UUID を作り `app_settings` の `mac_id` に保存する。バックアップのファイル名とヘッダーに使う。バックアップに `app_settings` を含めないので、復元では元の Mac の ID を持ち込まない。同じ Mac への復元では、復元の前の `app_settings` を引き継いで、Mac の ID を保つ（R13）。新しい Mac では起動時に新しく作る

## R15. E2E とテスト

- **Decision**: E2E は Chromium の仮想の認証器（CDP の `WebAuthn.addVirtualAuthenticator`）でパスキーの登録とサインインを行う。既存の2本の E2E は、最初に登録とサインインをする共通の手順を足す。server のテストは、テスト用のヘルパーでセッションを直接作って cookie を付ける（認証の経路のテストとは別）
- **Rationale**: 認証を外す設定（環境変数での無効化など）を作らない。本番で誤って無効になる危険を作らない
- **サンドボックス**: このセッションではローカルのポートを開けないため、E2E と dev サーバーの確認は利用者の端末で行う（003 と同じ）

## R16. 不変条件（INV-25〜INV-29）

- data-model.md §4 に、復元の往復（INV-25）、改ざんの検知（INV-26）、世代の選び方（INV-27）、セッションの失効（INV-28）、認証の要否（INV-29）を足し、fast-check のプロパティテスト・統合テストで検証する

## R17. ペアリングのトークン（別の接続先の名前のパスキー）

- **Decision**: パスキーは RP ID（接続先の名前）ごとに別で、ts.net の名前のパスキーは ts.net の名前の画面からでないと登録できない（WebAuthn の制約）。しかし最初のパスキーの登録は localhost だけで受け付ける（FR-001）ため、ts.net の画面には「サインインしていない状態で、パスキーを登録する」入口が要る。それを、Mac の localhost でサインインした利用者が発行するトークンで開く
  - `POST /auth/pairing`（要サインイン、`localhost` の Host から。リモートが有効で名前が登録済みのとき）→ `{ token, url }`。`token` は 32 バイトの乱数（base64url）、DB には `hashToken` のハッシュだけ（`pairing_tokens`）。`url` は `https://<登録した名前>/pair?token=…`。10分で切れ、単回
  - ts.net の画面（`/pair`）が、トークンで `POST /auth/pairing/register/options`・`/verify`（公開の手続き。トークンが前提）を呼び、その RP ID のパスキーを登録して、通常のセッション（`passkey_id` つき）を得る。検証の成功で `used_at` を付ける
  - 発行と使用は `auth_events`（`pairing_issued`・`pairing_used`）に残す
- **Rationale**: ts.net からは最初の登録を受け付けないので、そのままでは ts.net のパスキーを作れない。一度きり・期限つきのトークンで、Mac の前にいる利用者の許可を、別の端末へ渡す
- **Alternatives**: サインイン済みの端末の `/auth/passkeys/options` で追加 → 別の RP ID のパスキーは別のオリジンの画面でしか作れず、実現できない
