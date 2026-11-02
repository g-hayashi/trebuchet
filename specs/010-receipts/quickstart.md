# Quickstart: 010-receipts の動作確認

実装の完了後に、この手順で機能が動くことを確かめる。仕様は [spec.md](./spec.md)、API は [contracts/http-api.md](./contracts/http-api.md)、表と不変条件は [data-model.md](./data-model.md) §1・§4。証憑の画像・金額・取引先は合成のもの（`packages/domain/test/fixtures/receipts/`）を使い、実データの値・取引先名・画像をリポジトリや記録に書かない。画面の文言は実装の後に合わせる。

## 前提

- 001〜009 の quickstart の前提（`pnpm install`、`pnpm typecheck && pnpm lint && pnpm test` が成功）
- 008 の解錠（回復キー・パスキー）ができる。§2 の US2 と §3 は 004 の US4（ts.net、ペアリング、`pnpm start`）が利用者の端末で動いている
- research R12 のゲート（`sips` の HEIC・PDF・向き）を済ませ、結果を research に追記してある

## 1. 自動テストでの確認

| コマンド | 確認する内容 | 対応 |
|---|---|---|
| `pnpm vitest run --project schema` | `ReceiptCreateOptions`・`ReceiptQuery`・`AiReceiptReading` の境界（金額 0・1e12、日付、取引先 100 文字、`sha256` の形） | contracts §7 |
| `pnpm vitest run --project domain` | INV-63・65・66・67 の性質テスト。`detectReceiptFormat`（4 形式、拡張子と違う中身、HEIC の brands、空・短いバイト列）、`inputDeadline`（問23 の 4/21 → 6/20 + 7 営業日、月末、土日）、`receiptWarnings`（`paper_scan` だけ、A4 の目安、カラー）、`needsReason`、`rankJournalCandidates`、`stripJpegMetadata`（Orientation を残す、GPS を含む Exif を除く）、`parseReceiptReading`（項目ごとの候補なし）、ユースケース（重複、全部か無か、削除の制限、付け替え・自動の閉じ、仕訳の登録の巻き戻し、読み取りの 3 段と設定が無効なら呼ばない） | FR-001〜019, FR-022, SC-005 |
| `pnpm vitest run --project db` | INV-61（暗号化の往復・改ざん・別の DK・別の事業体）、INV-62・64・65（実際の UnitOfWork、5,000 件でない小さな集合で SQL と素朴なフィルタの一致）、INV-68（バックアップ → 復元の往復、置き場所の名前が HMAC、欠け・改ざんで `RECEIPTS_MISSING`、`--allow-missing-receipts`）、`0014`・`0015` の STRICT とトリガー（DELETE の禁止、不変の列、1 回だけの UPDATE）、`listTaxParameters` が seed と一致（4 行を含む）、registry の `ai_settings` の列と復元の引き継ぎ | R7〜R11, R15, R20 |
| `pnpm vitest run --project server` | §contracts のエラーコードとステータス、multipart の上限（20 MB + 1 バイトで 413）、経路（`localhost` で `local`、ts.net の Host で `remote`）、施錠中の 401 `LOCKED`、ファイルの応答のヘッダー（`no-store`、`nosniff`、`Content-Disposition`）、仕訳の一覧の `receiptCount`・詳細の `receipts`、読み取りの 422 `AI_NOT_CONFIGURED` と偽の `fetch` での要求の形（`image_url` の data URL、`response_format`、取引先の一覧を含まない）、`/settings/ai` の `receiptImagesEnabled`、`.tmp/receipt-convert-*` が残らない、バックアップの実行で証憑を写してから `.tbk` を書く | contracts, R9〜R16 |
| `pnpm vitest run --project web` | 一覧の検索の条件、未入力・期限・解像度の表示、詳細の表示と履歴、結びつけのダイアログ、証憑から仕訳の入力の初期値、AI の候補の表示（候補であることが分かる）、設定の確認の文言、撮影の画面の失敗の表示 | US1〜US5 |
| `pnpm bench:reports` | 証憑 5,000 件の事業体で、日付の範囲 × 金額の範囲 × 取引先の部分一致の検索が 1 秒以内 | SC-002 |
| `pnpm eval:receipts`（外部の AI を呼ぶ。CI に含めない） | 合成の 20 枚で、取引年月日・金額の一致率がそれぞれ 90% 以上。結果は `.tmp/eval-receipts/` に件数と割合だけ | SC-004, R17 |

## 2. 手動での確認（合成のデータ）

```bash
TREBUCHET_DATA_DIR="$PWD/.tmp/quickstart-010" pnpm dev   # http://localhost:5173
```

1. **準備**: 回復キーで初回の設定をして解錠し、事業体を種別「個人」・開始年度「2026」で作る。バックアップの置き場所を `.tmp/quickstart-010-backup/` にする
2. **追加と検索（US1）**: 証憑の画面で、合成の JPEG を区分「紙を撮影（原本は保存）」・2026-10-15・3,300 円・「サンプル商店」で追加 → 一覧に出て、詳細に受領日時・ハッシュ・元の名前・形式・大きさ・経路「この Mac から」が出る。ほかに 2 件（区分・日付・金額・取引先が違うもの。うち 1 件は PDF、1 件は HEIC）を追加する。2026-10-01〜2026-10-31 かつ 1,000〜5,000 円 → 条件に合うものだけ。取引先に「ｻﾝﾌﾟﾙ」（半角）→ 「サンプル商店」が出る。HEIC の証憑を Chrome で開いて画像が表示される。原本の取り出しで落としたファイルの SHA-256（`shasum -a 256`）が詳細のハッシュと一致する
3. **重複・拒否（US1 シナリオ4、Edge Cases）**: 同じ JPEG をもう一度追加 → 既存の証憑が案内され、件数は増えない。`.jpg` に名前を変えた PDF → PDF として保存される。テキストファイル → 拒否。21 MB の画像 → 拒否
4. **暗号化（US1 シナリオ5）**: `ls .tmp/quickstart-010/receipts/<事業体の ID>/` の名前が詳細のハッシュと同じで、`file` コマンドで画像・PDF と判定されない
5. **施錠（US1 シナリオ6）**: 設定のセキュリティで「施錠」→ 証憑の一覧・追加・表示が 401
6. **未入力と後からの入力（US2 シナリオ1・3）**: 日付・金額・取引先なしで追加 → 一覧で「未入力」。後から入れる → 履歴に入力が残り、理由は求められない。検索に出る
7. **警告（FR-022）**: 区分「紙を撮影（原本は保存）」で取引年月日を 2026-07-01（受領日より 2 か月 + 7 営業日以上前）にする → 「入力期間を過ぎています」と期限の日付が出る。1,000 × 800 の画像を追加 → 解像度の目安を下回る警告。どちらも保存はされる
8. **結びつき（US3）**: 3,300 円の証憑から「この証憑から仕訳を作る」→ 日付・金額・摘要が入った仕訳の入力が開く → 登録すると結びつき、仕訳の一覧に証憑の印、仕訳の詳細から画像が開ける。別の証憑を「仕訳に結びつける」で、日付・金額の近い仕訳が上に出る → 選ぶ。1 件の仕訳に 2 件の証憑 → 詳細に 2 件並ぶ。仕訳を訂正 → 結びつきが残る。仕訳を取り消す → 一覧に「仕訳が取消済み」。別の仕訳に結び直せる。付け替え・解除の理由が履歴に残る
9. **訂正・差し替え・削除（US5）**: 金額 3,300 → 3,500 に理由つきで訂正 → 履歴に前後の値と理由。撮り直した画像に差し替え → 新しい画像が出て、履歴から前の画像を開ける。結びつきのある証憑を削除 → 解除が要ると示される。解除して理由つきで削除 → 一覧から外れ、「削除済みも表示」で出て、表示・取り出しができる
10. **AI の読み取り（US4。偽の接続先）**: 外部の AI を有効にし、接続先を手元の偽のサーバー（決まった JSON を返す。`apps/server/test` の偽の `fetch` と同じ応答）にする。証憑の送信が無効 → 読み取りの操作が出ない（呼ばれない）。設定で有効にするとき、画像がそのまま外部に送られる旨の確認が出る。有効にして読み取る → 候補が入力欄に入り、AI の候補であることが分かる。保存されるのは確かめた値だけ。応答の科目を一覧にないものにする → 科目だけ候補なし。偽のサーバーを止める → 失敗が示され、証憑は残る。詳細の記録に日時とモデル名が出る
11. **バックアップと復元（FR-021、SC-006）**: 「今すぐバックアップ」→ `.tmp/quickstart-010-backup/trebuchet-receipts/<事業体の ID>/` に証憑の数だけファイルがあり、名前がデータ場所の名前（ハッシュ）と違う。もう一度実行 → 写しは増えない。server を止め、`pnpm restore -- --file <.tbk> --data-dir .tmp/quickstart-010-restored` → 回復キーで復元でき、`receipts/` のファイルの名前と数が元と同じ。置き場所の写しを 1 つ消して復元 → `RECEIPTS_MISSING` で何も変わらない
12. **事務処理規程（US5 シナリオ5）**: `docs/receipts/processing-rules.md` と `docs/receipts/system-overview.md` を開き、名前・日付の欄、訂正・削除の手順、保存の責任者、保存期間 7 年以上、紙の原本の保存（research R1）が書かれている

確認が終わったら `pnpm dev` を止め、`.tmp/quickstart-010*` を削除する。

## 3. 実環境での確認（利用者の端末。値・画像・取引先名は書かない）

- **スマホ（US2、SC-001）**: `pnpm start` と `tailscale serve` の ts.net を iPhone の Safari で開き、ホーム画面に追加 → アプリとして起動し、アプリの中でパスキーでサインインする（Safari と cookie が分かれる）。撮影の画面でカメラを選んで撮る → 送信から保存の表示まで 10 秒以内（5 MB 前後）。経路が「スマホ・リモート」。機内モードで送る → 失敗と示される。Mac が施錠中 → 401 `LOCKED` の表示
- **`sips`（R12 のゲート）**: iPhone の HEIC（縦の撮影）、1 ページの電子の PDF で、表示用の JPEG、AI 用の JPEG（長辺 2,048、向きが正しい、Exif の位置情報がない〔`sips -g all` の出力に GPS の項目がない〕）、PDF の 1 ページ目の文字が読めることを確かめ、結果（できた・できない、どの方法か）だけを research R12 に追記する
- **外部の AI（US4、SC-003・004）**: 利用者が選んだ画像入力に対応するモデルで、合成の証憑の読み取りと `pnpm eval:receipts` を行い、一致率（割合だけ）を控える。証憑から仕訳の登録までの時間（AI の候補あり 1 分、手入力 2 分）を計る。実データの証憑で試すときは、送ってよい画像かを利用者が決め、結果は件数と一致・不一致だけを控える
- **バックアップの大きさ**: 実際の証憑を貯め始めた後、置き場所の `trebuchet-receipts/` の大きさと、自動のバックアップの時間を控える（値だけ。ファイル名・中身は書かない）
