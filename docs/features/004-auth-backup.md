# 認証とバックアップ（004）

仕様: `specs/004-auth-backup/`。設計判断: [ADR 0006](../adr/0006-passkey-sessions.md)（パスキー、Host → CSRF → 認証。セッションと回復コードは 008 で置き換わった）、[ADR 0007](../adr/0007-backup-format.md)（形式、スナップショット、復元。鍵とパスフレーズは 008 で置き換わった）。鍵まわりは[008](008-passkey-vault.md)と [ADR 0011](../adr/0011-passkey-prf-vault.md)。

| 層 | 場所 |
|---|---|
| 業務ルール（パスキー・セッションの判定、公開の手続きの一覧 `requiresAuth`、バックアップの要否・世代の選び方・警告） | `packages/domain/src/auth/`、`packages/domain/src/backup/` |
| 永続化（認証の表、セッションのトークンのハッシュ `hashToken`） | `packages/db/src/auth-hash.ts`、`auth-repository.ts` |
| バックアップの形式と復元 | `packages/db/src/backup/`（`snapshot.ts`、`archive.ts`、`crypto.ts`、`file.ts`、`repository.ts`、`restore.ts`） |
| HTTP の検査（Host → CSRF → 認証の順） | `apps/server/src/middleware/`（`host.ts`、`csrf.ts`、`auth.ts`） |
| server の部品 | `apps/server/src/lib/`（`origin.ts`、`session.ts`、`webauthn.ts`、`challenges.ts`、`tailscale.ts`（tailscale の CLI を決まった引数だけで呼ぶ。シェルを通さない）、`keychain.ts`（006 の外部 AI の API キー用）、`backup-run.ts`、`backup-scheduler.ts`、`startup.ts`。解錠まわりは 008 の節） |
| HTTP のルート | `apps/server/src/routes/auth.ts`、`backup.ts` |
| 画面 | `apps/web/src/features/auth/`、`features/backup/`、`apps/web/src/routes/settings/`（`security.tsx`、`backup.tsx`） |
| E2E の仮想の認証器 | `apps/web/e2e/helpers/`（`virtual-authenticator.ts`、`auth.ts`） |
| 復元のコマンド | `scripts/restore-backup.ts`（本体は `scripts/lib/restore-cli.ts`） |

- **開発の URL は `http://localhost:5173`**（`127.0.0.1` ではパスキーが使えない）。`apps/web/vite.config.ts` の proxy は `changeOrigin: false` が必須（`true` だと Host が書き換わる）。
- **許す Host・オリジン・RP ID の決定は `apps/server/src/lib/origin.ts` の 1 か所**。別の場所で名前の一覧を書かない。
- **全 `/api` に Host → CSRF → 認証の順で検査を掛ける**。CSRF は `hono/csrf` を使わず自前。公開の手続きは `requiresAuth`（domain）の完全一致の一覧だけ。`apps/server/test/auth-coverage.test.ts`（INV-29）が、一覧にないルートは未サインインで 401 になることを確かめる。
- 認証を無効にする設定・環境変数・テスト用の分岐を本番のコードに作らない（規則の正本は AGENTS.md の「認証」）。
- **DK・DB の鍵・回復キー・セッションのトークンを平文でログ・データ場所・リポジトリに置かない**。セッションのトークンは DB にハッシュだけを保存する（ハッシュは db の `hashToken` に一本化）。回復キーはハッシュも保存しない（008）。バックアップの鍵は DK から作り、パスフレーズはない。
- **キーチェーン（`SecretStore`）は 006 の外部の AI の API キーだけに使う**。`/usr/bin/security -i` の標準入力に 1 行を流す（引数は `ps` に出る。004/R12）。テストはキーチェーンに触れず、`SecretStore` の偽物を使う。
- **平文の写しは `.tmp/` の下に作り、`finally` で必ず消す**。server の起動時に、前回の異常終了で残った `.tmp/backup-snapshot-*/` を消す。
- バックアップには、端末に結びつく registry の表（`app_settings`・`backup_runs`・`ai_settings`。`snapshot.ts` の `EXCLUDED_REGISTRY_TABLES`）と認証の表（`auth.sqlite`）を含めない。`deleting`・`preparing` の事業体と tenant の DB のない事業体の行も写さない。復元した帳簿は、次の起動で回復キーで解錠し、パスキーを登録するところから始まる。
- **US4（Tailscale によるリモートの利用）は 2026-11-02 に 008 の形で再開した**。リモートの設定とペアリングのトークンは `auth.sqlite`（施錠中も読める）。手順は README の「スマホから使う」。Funnel は使わない。
  - server: `apps/server/src/static.ts`（`TREBUCHET_WEB_DIST`、既定 `apps/web/dist` の静的配信。`pnpm start`）、`routes/settings.ts`（`GET/PUT /settings/remote`、422 `REMOTE_HOST_INVALID`。`GET /settings/remote/tailscale` は serve の状態、`PUT /settings/remote/tailscale/serve` は開始・停止で、`lib/tailscale.ts` を通し localhost の Host だけ。停止は `serve --https=443 off`〔`reset` は他の設定を消すので使わない〕）、`routes/pairing.ts`（`POST /auth/pairing`: 再認証つき・ローカルの Host だけ。`pairing/register/*`: 公開、解錠中だけ、トークンは包みを作ってから消費）、`lib/auth-support.ts`（`routes/auth.ts` と共有の登録・セッション・再認証の部品）
  - web: `features/remote/`（`api.ts`、`RemoteSettingsForm.tsx`、`PairingSection.tsx`）、`routes/settings/remote.tsx`、`routes/pair.tsx`・`features/auth/Pair.tsx`（`/pair` は `routes/__root.tsx` の `PUBLIC_PATHS` で AuthGate の例外）
  - ペアリングのトークン・URL をログ・`auth_events.detail` に出さない。`/pair` の画面は帳簿の API を呼ばない

