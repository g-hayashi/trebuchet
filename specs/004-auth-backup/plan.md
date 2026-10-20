# Implementation Plan: 認証とバックアップ（基盤の残り）

**Branch**: `004-auth-backup` | **Date**: 2026-10-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-auth-backup/spec.md`

## Summary

パスキー（WebAuthn）で、アプリの画面と API のすべてを守る。対象は Mac のローカル（`http://localhost`）と Tailscale の HTTPS（`https://<name>.ts.net`）。登録時の回復コード、8時間で失効するセッション、Host と Origin の検査、追記のみの認証の記録を持つ（research R1〜R7）。バックアップは、全事業体の SQLite を `VACUUM INTO` で一貫して写し、Argon2id と AES-256-GCM で暗号化した1つのファイルにする（R8〜R11）。そのファイルを Google Drive の同期フォルダに書き、読み戻して検証する。自動のバックアップは1日1回で、変更がなければ取らない。世代は毎日30日分と月ごと7年を残す。パスフレーズは macOS のキーチェーンに保管する（R12）。復元は、server を止めて実行するコマンドで、全部か無かで行う（R13）。リモートのために、server がビルド済みの web も配信する（R3）。

## Technical Context

**Language/Version**: TypeScript 7.0（`strict: true`, ESM）、Node.js 26.9（`crypto.argon2` は 24.7 以降で使える）

**Primary Dependencies**: 001 に `@simplewebauthn/server`（apps/server）と `@simplewebauthn/browser`（apps/web）を足す（R1。Complexity Tracking）。暗号・鍵の導出・ハッシュは `node:crypto`、キーチェーンは `/usr/bin/security`（`node:child_process`）、静的配信は `@hono/node-server/serve-static`（既存の依存に含まれる）

**Storage**: `registry.sqlite` に6表（`passkeys`、`recovery_codes`、`sessions`、`auth_events`、`app_settings`、`backup_runs`）。マイグレーション `drizzle/registry/0001_auth_backup`。事業体の DB は変えない。バックアップは `.tbk`（data-model §2）

**Testing**: Vitest ＋ fast-check（INV-25〜29）、テンポラリの SQLite でのバックアップの往復と改ざんの検知、Hono の `app.request()`（全ルートの 401 を機械的に）、Testing Library ＋ jsdom、Playwright（Chromium の仮想の認証器。利用者の端末で実行）

**Target Platform**: macOS（Apple Silicon）上のローカル Web アプリ。Tailscale の tailnet の中の端末（iPhone を含む）から HTTPS で接続

**Project Type**: Web アプリケーション（pnpm monorepo に追加）

**Performance Goals**: サインインが10秒以内（SC-002）。数千仕訳/年 × 3年の手動のバックアップが30秒以内で、その間も画面を使える（SC-005）

**Constraints**: パスフレーズ・回復コード・セッションのトークンを、平文でデータ場所・ログ・リポジトリに置かない。インターネットに公開しない（Funnel を使わない）。認証を無効にする設定を作らない（R15）。サンドボックスではローカルのポートを開けないため、dev サーバー・E2E・Tailscale の確認は利用者の端末で行う

**Scale/Scope**: 利用者1人、パスキー数個、端末数台。バックアップは数 MB〜数十 MB、1日1回

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | ✅ | 帳簿の表と規則は変えない。復元は全部か無か（R13）で、往復で内容が一致することを INV-25 で検証する |
| II. 監査可能性 | ✅ | 認証の出来事を追記のみの `auth_events`（トリガーで更新・削除の禁止）に残す（FR-008）。バックアップは7年分の世代を残し（FR-021）、7年以上の保持（II）を補う |
| III. ローカルファーストとプライバシー | ✅ | リモートは Tailscale の Serve だけ（tailnet の中。Funnel は使わない）。パスフレーズはキーチェーン（R12）。バックアップは Mac の中で暗号化してから同期フォルダに置き、アプリは Google の認証や API を使わない |
| IV. AIは提案 | N/A | AI は使わない |
| V. テストファースト | ✅ | INV-25〜29 をプロパティテスト・統合テストで先に書く。全ルートの 401 は、ルートの一覧から機械的に検査する |
| VI. 税制ルールはデータ | N/A | 税制の値は扱わない |
| VII. シンプルさと境界 | ⚠️ → ✅ | 依存を2つ足す（R1。Complexity Tracking）。暗号・アーカイブ・キーチェーンは標準機能で作る。復元を画面で行わず、server を止めて実行するコマンドにして、動いている DB の差し替えを避ける（R13）。ドメインは純関数だけ（セッションの失効、世代の選び方、自動の判断）で、暗号とファイルは db、キーチェーンと HTTP は server |

**Post-design re-check（Phase 1 後）**: ✅ 違反なし（依存の追加は Complexity Tracking で正当化）。

## Project Structure

### Documentation (this feature)

```text
specs/004-auth-backup/
├── plan.md              # 本ファイル
├── research.md          # Phase 0（R1〜R16）
├── data-model.md        # Phase 1（registry の6表、.tbk の形式、INV-25〜29）
├── quickstart.md        # Phase 1
├── contracts/
│   ├── http-api.md      # 全ルートの検査、認証・設定・バックアップの API、エラーコード
│   └── cli.md           # 復元・起動のコマンド、バックアップのモジュール、ポート
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks で作成
```

### Source Code (repository root)

```text
packages/
├── schema/src/
│   ├── auth.ts                    # AuthStatus, PasskeyView, SessionView, AuthEvent, RemoteSettings など
│   ├── backup.ts                  # BackupStatus, BackupSettingsInput, BackupRun, BackupInspection など
│   └── errors.ts                  # エラーコード15種（contracts/http-api.md）
├── domain/src/
│   ├── auth/                      # session.ts（isSessionActive）、access.ts（requiresAuth）、recovery.ts（recoveryLocked）、passkeys.ts（canDeletePasskey）
│   ├── backup/                    # policy.ts（shouldRunAutoBackup, backupAlert）、retention.ts（selectBackupsToPrune）
│   └── ports.ts                   # SecretStore, AuthStore, BackupStore
├── db/
│   ├── src/schema/registry.ts     # 6表
│   ├── src/auth-repository.ts     # AuthStore
│   ├── src/backup/                # snapshot.ts, archive.ts, crypto.ts, file.ts, restore.ts, repository.ts（BackupStore）
│   ├── drizzle/registry/0001_auth_backup.sql（＋ --custom のトリガー）
│   └── test/auth-*.test.ts, backup-*.test.ts / *.property.test.ts
apps/
├── server/src/
│   ├── middleware/                # host.ts, csrf.ts, auth.ts（R6）
│   ├── routes/auth.ts, settings.ts, backup.ts
│   ├── lib/keychain.ts            # SecretStore の実装（R12）
│   ├── lib/backup-scheduler.ts    # 1時間ごとの判断（R10）
│   ├── static.ts                  # ビルド済みの web の配信（R3）
│   └── main.ts                    # スケジューラーの開始、静的配信
└── web/src/
    ├── features/auth/             # RegisterPasskey, SignIn, RecoveryCode, PasskeyList, SessionList
    ├── features/backup/           # BackupSettings, BackupStatusBanner, InspectBackup
    ├── routes/settings/{index,security,backup,remote}.tsx
    └── main.tsx / __root.tsx      # 認証の状態で、登録・サインインの画面に分岐
scripts/
└── restore-backup.ts              # pnpm restore（R13）
```

**Structure Decision**: 依存の向き（`apps/server → packages/db → packages/domain → packages/schema`、`apps/web → packages/schema`）を変えない。純粋な判断は domain、暗号・ファイル・SQLite は db、HTTP・キーチェーン・タイマーは server に置く。`packages/domain` は `node:crypto` を import しない（判断に乱数やハッシュは要らない。トークンとハッシュの生成は db と server が行う）。

## Phase の進め方（tasks への入力）

1. **Setup**: 2つのゲートを利用者の Mac で確かめる。キーチェーンを標準入力から使えるか（R12）と、`tailscale serve` で server に届く Host のヘッダー（R3）。依存の追加。vite の `allowedHosts` と E2E の `baseURL` を `localhost` にする
2. **Foundational**: Zod スキーマとエラーコード、registry のマイグレーション 0001（6表、STRICT、トリガー）、ポートと偽物、ドメインの純関数（セッション、認証の要否）
3. **US1**（登録・サインイン・回復・パスキーとセッションの管理、全ルートの保護、画面）→ **US2**（暗号とアーカイブ、書き込みと世代、キーチェーン、スケジューラー、設定と知らせの画面）→ **US3**（検査の API と画面、復元のコマンド）→ **US4**（静的配信、リモートの設定、Host の許可、別の RP ID のパスキー）
4. 各ストーリーで「プロパティ／ユニットテスト → domain → db → server → web」の順
5. **Polish**: E2E を仮想の認証器で直す（既存の2本に登録とサインインを足す）、AGENTS.md・README の更新（URL を localhost に、`pnpm start`、`pnpm restore`、Tailscale の手順）、ADR 0006（パスキーとセッションの方式）・0007（バックアップの形式と暗号）、quickstart の手動確認（利用者の端末）、性能の確認（SC-005）、最終の全体検証

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 依存の追加: `@simplewebauthn/server`、`@simplewebauthn/browser`（Constitution VII） | WebAuthn の応答の検証（CBOR・COSE・authenticatorData の解析、署名・origin・RP ID・カウンタの検査）は、誤ると認証が破れる | `node:crypto` だけでの自作は、検証の漏れを自分のテストだけで防げない。広く使われ監査されている実装を使う方が安全 |
