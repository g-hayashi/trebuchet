# Quickstart: 004-auth-backup の動作確認

仕様は [spec.md](./spec.md)、API は [contracts/http-api.md](./contracts/http-api.md)、復元のコマンドは [contracts/cli.md](./contracts/cli.md)、不変条件は [data-model.md](./data-model.md) §4。画面の文言は実装の後に合わせて直す。

**注意**: Claude Code のサンドボックスではローカルのポートを開けないため、§2・§3 の確認と E2E は利用者の端末で server を起動して行う。

## 1. 自動テストでの確認

| コマンド | 確認する内容 | 対応 |
|---|---|---|
| `pnpm vitest run --project domain` | セッションの失効（INV-28）、認証の要否（INV-29 の判定）、回復のロック、自動のバックアップの判断、世代の選び方（INV-27） | FR-003〜006, FR-019〜021 |
| `pnpm vitest run --project db` | バックアップの往復（INV-25）、改ざん・切り詰め・誤ったパスフレーズの検知（INV-26）、registry の 0001 の STRICT とトリガー、書きかけを残さない書き込み | SC-003, SC-004, SC-006 |
| `pnpm vitest run --project server` | 全ルートで未サインインが 401（INV-29、ルートの一覧から機械的に）、Host・CSRF の検査、エラーコード | SC-001 |
| `pnpm vitest run --project web` | 登録・サインイン・回復・設定の画面、バックアップの知らせ | US1〜US4 |
| `pnpm --filter @trebuchet/web e2e`（利用者の端末） | 仮想の認証器での登録 → サインイン → 既存の2本の流れ | US1 |

## 2. 手動での確認（利用者の端末）

```bash
TREBUCHET_DATA_DIR="$PWD/.tmp/quickstart-004" pnpm dev    # http://localhost:5173
```

1. **登録（US1）**: http://localhost:5173 を開く → パスキーの登録の画面 → Touch ID → 回復コードが表示され、「控えた」を押すまで進めない
2. **サインイン（US1）**: サインアウト → サインインの画面 → Touch ID で帳簿の画面に戻る。`curl -i http://127.0.0.1:8787/api/entities` が 401
3. **回復（US1）**: サインアウト → 「回復コードを使う」→ 控えたコード → 新しいパスキーを登録 → 新しい回復コードが出る。古いコードは使えない
4. **バックアップ（US2）**: 設定 → バックアップ → パスフレーズ（12文字以上）を2回、置き場所に `.tmp/quickstart-004-backup/` → 同意 → 最初のバックアップが成功し、ファイルができる。「今すぐバックアップ」を押しても、帳簿を変えていなければ「変更なし」
5. **失敗の知らせ（US2）**: 置き場所のフォルダを消して「今すぐバックアップ」→ 失敗と理由が表示され、画面の上部に知らせが出る
6. **検査（US3）**: 設定 → 復元 → ファイルとパスフレーズで「検査」→ 要約が出る。誤ったパスフレーズは「パスフレーズが違うか、ファイルが壊れています」
7. **復元（US3）**: server を止め、`pnpm restore -- --file .tmp/quickstart-004-backup/<ファイル> --data-dir .tmp/quickstart-004-restored` → 要約と確認 → 成功。`TREBUCHET_DATA_DIR=.tmp/quickstart-004-restored pnpm dev` で開くとパスキーの登録から始まり、登録後の帳簿が元と同じ
8. **時間（SC-008）**: 手順7（新しい場所への復元とパスキーの登録）にかかった時間を計る

## 3. Tailscale 経由の確認（US4、利用者の端末）

```bash
pnpm start                                                 # http://localhost:8787
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

1. 設定 → リモートのアクセス → 有効、名前に `<machine>.<tailnet>.ts.net` → 保存
2. iPhone（同じ tailnet）で `https://<machine>.<tailnet>.ts.net` → サインインの画面。Mac でサインインした状態で「この名前で使うパスキーを追加」→ iPhone で登録 → iPhone でサインインできる
3. リモートを無効にする → iPhone からの接続が拒否される
4. 確認が終わったら `tailscale serve reset`
