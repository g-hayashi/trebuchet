# パスキーと回復キーによる DB の暗号化（008）

設計: `specs/008-passkey-vault/design.md`（D1〜D12。spec・plan・research はない）。判断の記録: [ADR 0011](../adr/0011-passkey-prf-vault.md)。004 の認証とバックアップの鍵まわりを置き換えた（回復コード、バックアップのパスフレーズ、キーチェーンの経路は消えた）。

| 層 | 場所 |
|---|---|
| ファイル | `data/auth.sqlite`（平文。`passkeys`（`prf_salt` つき）、`key_wraps`、`sessions`、`auth_events`）、`data/registry.sqlite` と `data/tenants/<id>.sqlite`（DK から HKDF で作った鍵で SQLCipher 方式に暗号化） |
| 鍵の計算（DK の包み、HKDF、回復キーの生成・解析。純関数） | `packages/db/src/vault-crypto.ts`、`recovery-key.ts`（復元のコマンドが使うので db に置く。domain は `node:crypto` を使えない） |
| DK の保持と DB の開き方（`setDataKey`・`clearDataKey`・`VaultLockedError`・`openAuth`・`openRegistry`・`openTenant`） | `packages/db/src/tenant-store.ts`。ドライバーは `packages/db/src/driver.ts`（`better-sqlite3-multiple-ciphers`） |
| 認証の表のスキーマとマイグレーション | `packages/db/src/schema/auth.ts`、`packages/db/drizzle/auth/`、`drizzle.auth.config.ts`（registry の `schema/registry.ts`・`drizzle/registry/` とは別） |
| server の解錠まわり | `apps/server/src/lib/`（`vault.ts`、`session-sweeper.ts`、`reauth.ts`、`startup.ts`）、`routes/auth.ts` |
| 画面 | `apps/web/src/features/auth/`（`AuthGate.tsx`、`RegisterPasskey.tsx`、`SignIn.tsx`、`Recovery.tsx`、`RecoveryCodePanel.tsx`、`PasskeyList.tsx`、`webauthn-client.ts`）、`routes/settings/security.tsx` |
| E2E | `apps/web/e2e/helpers/`（`virtual-authenticator.ts` は `hasPrf: true`、`auth.ts` の `enterVault`） |

- **DK・DB の鍵・バックアップの鍵は、平文でディスク・ログ・環境変数・応答に出さない**（INV-51）。回復キーは作成・再発行の応答で 1 回だけ返す。DK は `setDataKey` で渡したバッファだけが持ち、`clearDataKey` が `fill(0)` する。
- **施錠中は registry・事業体を開けない**（`VaultLockedError`）。帳簿の API は、セッションがなければ 401、セッションがあって施錠中なら 401 `LOCKED`。誤った鍵は `SQLITE_NOTADB` を例外として上げる。空の DB として扱わない。
- **正しさの判定は包みが開けたこと（GCM の検証）だけ**。回復キーのハッシュを保存しない。包みの AAD は種類と資格情報 ID（INV-52）。設定済みなら recovery の包みは 1 行、passkey の包みはパスキーと 1 対 1（INV-53）。
- **エラーコード**: 401 `LOCKED`、403 `REAUTH_REQUIRED`、400 `PRF_UNSUPPORTED`。パスキーの追加・削除、回復キーの再発行は、全権のセッションに加え、直近 5 分以内の再認証（`POST /api/auth/reauth/options`・`verify`）を要求する。最後の 1 本のパスキーは削除できない。
- **セッションは `auth.sqlite`**。無操作 30 分で失効し、有効なセッションが 1 つもなくなると施錠する。**起動時・施錠時に `sessions` を全部消す**。サインアウトは全セッションを消して施錠する。**新しいセッションを入れてから期限切れを掃除する**（逆にすると解錠の直後に施錠される）。
- **回復キーの試行はロックしない**。失敗ごとに 1 秒待たせる。
- **初回の設定**は `key_wraps` に recovery の行がないときだけ。以前の registry・事業体は `data/discarded-<時刻>/` に移す（消さない）。
- **バックアップの定期実行と定期仕訳の自動登録は、解錠中だけ**動く（`lib/startup.ts` を vault の状態に結びつける）。
- **バックアップの鍵は `HKDF(DK, ヘッダーの salt, "trebuchet/backup/v1")`**。ヘッダーに取った時点の recovery の包みを入れる（INV-54）。中の SQLite の写しは平文で、外側の AES-GCM が守る。`pnpm restore` は回復キーを標準入力から読み、ヘッダーの包み → 今の `auth.sqlite` の包みの順に試す。復元した後の `auth.sqlite` は recovery の包みだけ。画面のファイルの検査は解錠中に DK で行う。
- **テストは `useTempDataDir` が固定のテスト用 DK を `setDataKey` する**（cleanup で `clearDataKey`）。既存の db・server のテストは鍵を意識しない。server のテストのセッションは `auth.sqlite` に作る（`createTestSession`）。
- **E2E の仮想の認証器は `hasPrf: true`**。パスキーを書き出して戻すと PRF を失うので使わない。テストの間は回復キーを引き継ぎ、`enterVault` で回復キーで解錠して新しいパスキーを登録してから始める。E2E は利用者の端末で実行する。
- **`pnpm verify:freee --continue` は使えない**（実行ごとに乱数の DK で作るため。利用者の判断で使えないままにする）。
- **registry のマイグレーションは 008 で作り直した**（認証の表を `auth.sqlite` に分けたため）。以前の `data/` の DB は読めない。

