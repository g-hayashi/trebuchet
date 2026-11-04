# 証憑（010）

仕様: `specs/010-receipts/`。暗号化と名前、バックアップの別置き、INV-45 の例外、紙の原本を残す理由: [ADR 0014](../adr/0014-receipt-storage.md)。領収書・レシートの画像と PDF を保存・検索し、仕訳と結びつけ、外部の AI で値の候補を読む。

| 層 | 場所 |
|---|---|
| 入出力の型（証憑、検索の条件、警告、AI の出力 `AiReceiptReading`、`RECEIPT_MAX_BYTES`・`RECEIPT_MAX_PIXELS`） | `packages/schema/src/receipts.ts`、`ai.ts`、`errors.ts` |
| 業務ルール（形式の判定、入力期限・解像度の警告、検索の正規化、候補の順位、履歴からの復元、JPEG のメタデータの除去、指示文と送る中身、出力の検証、評価の集計） | `packages/domain/src/receipts/`（`format.ts`、`warnings.ts`、`search.ts`、`candidates.ts`、`history.ts`、`jpeg-metadata.ts`、`reading-prompt.ts`、`reading.ts`、`evals.ts`） |
| ユースケース | `packages/domain/src/usecases/receipts.ts`（追加・更新・差し替え・削除・検索）、`receipt-links.ts`（結びつき・仕訳の登録）、`receipt-reading.ts`（`readReceipt`） |
| 永続化（5 表、ファイルの暗号化、バックアップの写しと復元） | `packages/db/src/receipt-repository.ts`（`ReceiptStore`、`ReceiptUnitOfWork`）、`receipt-files.ts`（`encryptReceipt`・`decryptReceipt`、`ReceiptFileStore`）、`backup/receipts.ts`（置き場所への写しと復元） |
| HTTP | `apps/server/src/routes/receipts.ts`（`journals.ts` は仕訳の一覧・詳細の合成だけを足す）、`ai-settings.ts`（`receiptImagesEnabled`） |
| server の部品 | `apps/server/src/lib/image-tool.ts`（`sips`）、`ai-client.ts`（`createReceiptReader`）、`ai-runtime.ts`、`backup-run.ts`、`startup.ts`、`vault.ts` |
| 画面 | `apps/web/src/features/receipts/`（`api.ts`、`labels.ts`、`ReceiptReadingNote.tsx` など）、`apps/web/src/routes/e/$entityId/receipts/`（`index.tsx`、`$receiptId.tsx`、`capture.tsx`）、`routes/settings/ai.tsx` |
| 評価・性能・文書 | `scripts/eval-receipts.ts`、`scripts/bench-reports.ts`（SC-002）、`packages/domain/test/fixtures/receipts/`（`README.md`、`expected.ts`）、`docs/receipts/`（`processing-rules.md`、`system-overview.md`） |

- **証憑のファイルは `TRC1` で暗号化し、名前は平文の SHA-256 + `.trc`**（`receipt-files.ts`）。鍵は `HKDF(DK, salt, "trebuchet/receipt:<entityId>/v1")` で、`withDataKey` の中でだけ作り `fill(0)` する。置き場所は `<データ場所>/receipts/<entityId>/`（`tenants/` と分ける）。DK・鍵をディスク・ログ・応答に出さない（INV-51・61）。施錠中は読み書きできない（`VaultLockedError`、401 `LOCKED`）。応答は `Cache-Control: no-store`。初回の設定で以前の事業体を `discarded-<時刻>/` に移すときは `receipts/` も移す。
- **証憑の行・ファイル・履歴を物理削除しない**（トリガーで止める。INV-63）。追加・差し替えは全部か無か、同じ内容は `RECEIPT_DUPLICATE`（INV-62）。形式は中身で判定する（拡張子・`Content-Type` は見ない）。経路（Mac／スマホ・リモート）は要求の Host で決める。
- **INV-45 の例外は、`ReceiptReader`（domain のポート）と `createReceiptReader`（`ai-client.ts`）の 1 つの経路だけ**（憲法 III、ADR 0014）。利用者が外部への画像の送信を明示的に選んだ（2026-11-02）。外部の endpoint だけで、`external_enabled` と `receipt_images_enabled` がともに真のときだけ呼ぶ（無効なら 1 回も呼ばず 422 `AI_NOT_CONFIGURED`。INV-66）。送るのは `buildReceiptReadingRequest` の固定の指示文・科目と税区分の一覧・メタデータを除いた JPEG 1 枚だけ（取引先の一覧・仕訳・口座・メモ・元のファイル名・入力済みの値は送らない）。006 の `createAiSuggester`・`buildAiPayload` に画像の口を作らない。出力は `AiReceiptReading` で検証し、証憑の値を変えない（INV-67）。`readReceipt` は 読む → AI を呼ぶ（UnitOfWork の外）→ 書く の 3 段。
- **画像の変換は macOS の `sips`**（`lib/image-tool.ts`。新しい依存を足さない）。HEIC → JPEG、PDF の 1 ページ目、AI 用の JPEG を作る。平文の作業ファイルは `.tmp/receipt-convert-<乱数>/` に書き、`finally` で消す。server の起動時に残りを消す（`startup.ts`）。テストは `sips` を呼ばず、偽の `ReceiptImageTool` を使う。
- **バックアップは、`.tbk` に証憑のファイルを入れず、置き場所の `trebuchet-receipts/<entityId>/` に増分で写す**（`backup/receipts.ts`、`backup-run.ts`）。名前は `HMAC-SHA256(K, sha256)`（同期フォルダに平文のハッシュを見せない）で、中身はデータ場所の `.trc` と同じバイト列。写しの失敗は `.tbk` を書かずに失敗にする（INV-68）。世代の整理は `.tbk` だけで、証憑の写しは消さない。復元は `--receipts-dir`（既定は `.tbk` と同じフォルダの `trebuchet-receipts/`）から全件を検証して戻し、1 件でも欠ければ何も変えずに失敗する（`RECEIPTS_MISSING`）。`--allow-missing-receipts` で帳簿だけを戻せる（欠けた証憑は画面で「ファイルがありません」）。復元前の今の証憑は `.before-restore-<日時>/receipts/` に残る。INV-54（`.tbk` の形式）は変わらない。
- **`eval:receipts` の規則**: 指示文・`RECEIPT_AI_MAX_PX`・`RECEIPT_READ_TIMEOUT_MS` を変えるときは、変更の前と後で `pnpm eval:receipts` を実行して結果を比べる（Constitution IV、010/R17）。外部の AI に合成の画像を送るので CI に含まれない。結果は `.tmp/eval-receipts/` に件数と割合だけを残し、ファイル名・取引先・値を書かない。CI のテストは偽の `ReceiptReader` で集計だけを確かめる。フィクスチャの画像は合成（実データの写真・実在の店名・番号を入れない。作り方は同じ場所の `README.md`）。
- **税制の値の 4 つの key**: `RECEIPT_INPUT_CYCLE_MONTHS`（2）、`RECEIPT_INPUT_GRACE_BUSINESS_DAYS`（7）、`RECEIPT_SCAN_MIN_LONG_PX`（2,338）、`RECEIPT_SCAN_MIN_SHORT_PX`（1,654）。足し方は [003](003-tax-return.md) の「税制の値の足し方」（`seed/tax-parameters.ts` とマイグレーションの両方）に従う。値は取引年月日（未入力なら受領日）で解決し、解決できなければ警告を出さない（保存を止めない）。入力期間・解像度の警告は保存を拒まない目安。
- **紙を撮影した証憑（区分 `paper_scan`）は、紙の原本も保存する運用**（010/R1、plan Q1 = (A)。自作のアプリはタイムスタンプの代わりにならない）。電子取引（`electronic`）は事務処理規程で要件を満たす（`docs/receipts/`）。タイムスタンプを足すときは新しい ADR を書く。
- **区分などの表示名は `features/receipts/labels.ts` の 1 か所だけ**に置く（`paper_scan` は「紙を撮影（原本は保存）」、`electronic` は「電子取引」）。識別子は schema の値のまま使い、画面・テストで表示名を書き直さない。
- **web の証憑の操作の後の読み直し**: 仕訳が変わる操作（証憑と仕訳の結びつけ・解除、証憑からの仕訳の登録）は `invalidateLedger`（証憑の query も読み直す）、証憑だけが変わる操作は `receiptKeys.all(entityId)` を読み直す。API 呼び出しと query key は `features/receipts/api.ts`（AGENTS.md の「開発の進め方」のとおり）。

