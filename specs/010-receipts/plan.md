# Implementation Plan: 証憑（領収書・レシート）の保存・読み取り・仕訳との紐づけ

**Branch**: `010-receipts` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/010-receipts/spec.md`

## Summary

領収書・レシートの画像（JPEG・HEIC・PNG）と PDF を事業体の証憑として保存し、取引年月日・金額・取引先で検索し、仕訳と結びつける。原本は DK から HKDF で作った鍵で 1 ファイルずつ AES-256-GCM で暗号化し、平文の SHA-256 を名前にしてデータ場所の `receipts/<事業体>/` に置く（research R8・R9）。値・ファイルの版・結びつき・読み取りの記録は事業体の DB の 5 表に持ち、変更は追記のみの履歴に残し、物理削除をトリガーで止める（R7）。仕訳とは仕訳の ID で結びつくので、001 の訂正では結びつきがそのまま残り、取消では残って状態で分かる（R5）。スマホからは 004 の US4（ts.net）の PWA で撮って送る（R16）。外部の AI による読み取りは、006 の送る情報の原則（INV-45）の例外として、専用のポート `ReceiptReader` だけを通し、画像（`sips` で JPEG にしてメタデータを除いたもの）と科目・税区分の一覧だけを送る（R12・R13）。候補は Zod で項目ごとに検証し、入力欄の初期値にとどめる（R14）。バックアップは `.tbk` の形式を変えず、証憑のファイルを置き場所の別のフォルダに増分で写し（名前は鍵つきのハッシュ）、復元で全件を確かめる（R11）。

**一次資料で確かめた結果、spec の前提の 1 つが成り立たない**: 自作のシステムでは、タイムスタンプの代わりに「入力期間内に保存したことの確認」を使えない（スキャナ一問一答 問32）。紙を撮影した証憑は紙の原本を保存する運用にし、電子取引は事務処理規程で要件を満たす（R1。下の「spec への差し戻し」D1、「利用者の判断が要る点」Q1）。

## Technical Context

**Language/Version**: TypeScript 7.0（`strict: true`, ESM）、Node.js 26.9（001〜009 と同じ）

**Primary Dependencies**: 追加の npm の依存はない。暗号化は `node:crypto`（HKDF・AES-256-GCM・HMAC・SHA-256）、画像の変換は macOS の `sips`（PDF の描画が `sips` で足りなければ `qlmanage`）を server から `node:child_process` で呼ぶ（R12）。外部の AI は 006 の `fetch` による OpenAI 互換の Chat Completions（`image_url` の data URL）。PWA は 004 が置いた manifest のままで Service Worker を足さない（R16）

**Storage**: 事業体の SQLite に 5 表（`receipts`、`receipt_files`、`receipt_links`、`receipt_readings`、`receipt_audit_log`）、`tax_parameters` に 4 つの key（表の作り直し）。マイグレーション tenant `0014_receipts`（生成 + STRICT + 作り直し）・`0015_receipts_integrity`（`--custom`。トリガー、税制の値の投入）、registry `0002_ai_receipt_images`（`ai_settings.receipt_images_enabled`）。ファイルは `<データ場所>/receipts/<entityId>/<sha256>.trc`（`TRC1` 形式）と `<バックアップの置き場所>/trebuchet-receipts/<entityId>/<HMAC>.trc`（data-model §1.8）

**Testing**: Vitest ＋ fast-check（INV-61〜68）、テンポラリの SQLite と `.tmp/` での統合テスト（暗号化の往復、全部か無か、トリガー、バックアップ → 復元）、Hono の `app.request()`（multipart、偽の `fetch`、偽の `ReceiptImageTool`。`sips` と外部の AI は呼ばない）、Testing Library ＋ jsdom。E2E は足さない（quickstart の手動確認と実環境の確認で代える。スマホ・ts.net は E2E にできない）。AI の精度は `pnpm eval:receipts`（CI の外、R17）

**Target Platform**: macOS（Apple Silicon）上のローカル Web アプリ。スマホ（iPhone の Safari、ホーム画面のアプリ）は 004 の US4 の ts.net の HTTPS から使う

**Project Type**: Web アプリケーション（001 の pnpm monorepo に追加）

**Performance Goals**: 証憑 5,000 件の検索が 1 秒以内（SC-002。`bench:reports` に足す、R21）。5 MB の撮影の送信から保存の表示まで 10 秒以内（SC-001。暗号化は数十ミリ秒、`sips` の `probe` 1 回。利用者の端末で計る）。外部の AI の読み取りの時間切れ 90 秒（R13）

**Constraints**: 金額は整数（`0 < amount < 1e12`）。原本は変えない。DK・ファイルの鍵・名前の鍵を平文でディスク・ログ・応答に出さない（INV-51・61）。平文の写しは `.tmp/receipt-convert-*` だけで `finally` で消す（FR-003）。応答は `Cache-Control: no-store`。施錠中は読み書きできない。証憑の行・ファイル・履歴を物理削除しない（FR-018）。AI に送るのは R13 の 4 つだけ（INV-66）。実データの画像・値・取引先名をリポジトリに含めない（フィクスチャは合成、R17）。001 の仕訳の規則・型、006 の推定の経路を変えない

**Scale/Scope**: 個人の事業体で年に数百〜千件の証憑（7 年で数千件、ファイルの合計は 10〜20 GB の見込み、R11）。画面は証憑の一覧・詳細・撮影の 3 ルート、仕訳の詳細・一覧の表示、AI の設定の 1 項目

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | ✅ | 証憑から仕訳を作るときは 001 の `createJournal`（`validateJournal`）を同じ UnitOfWork で通す（R5）。結びつきの操作は仕訳を変えない（INV-64）。金額は整数。帳票は仕訳から導出したまま（証憑は集計に入らない） |
| II. 監査可能性（電子帳簿保存法） | ✅ | 証憑の値・版・削除・結びつき・読み取りは追記のみの `receipt_audit_log` に残し、物理削除をトリガーで止める（R7、INV-63）。取引年月日・金額・取引先で範囲・組み合わせの検索（R4、INV-65）。ファイルは内容の SHA-256 で識別し、仕訳との結びつきを持つ（R5・R8）。7 年以上: 期限で消す機能がなく、バックアップに含める（R11）。一次資料の確認で、スキャナ保存はタイムスタンプなしでは紙の代わりにならないと分かった（R1）。紙の原本を残す運用と電子取引の規程・システム概要書（R18）で、法令の要件と矛盾しない形にする（D1・D2） |
| III. ローカルファーストとプライバシー | ⚠️ → ✅ | 外部の AI に画像を送るのは「必要最小限」の原則の**利用者が決めた例外**（spec、2026-11-02）。例外は 1 つのポート（`ReceiptReader`）と 1 つの関数（`buildReceiptReadingRequest`）に閉じ込め、2 つの設定が真のときだけ呼び、Exif の位置情報を除き、取引先の一覧・仕訳・口座・メモ・ファイル名を送らない（R12・R13、INV-66）。画像のマスクはできないことを設定の画面で示す（FR-015）。Complexity Tracking に記録する。**例外は憲法の本文にも明記する**（C1。利用者が外部への画像の送信を明示的に選んだ、2026-11-02）: tasks T039 で、Constitution III に「証憑の画像の読み取りを、利用者が別に有効にしたときだけ許す」例外を 1 文足す PATCH の改定（Sync Impact Report つき）と、AGENTS.md の 006 の規則（INV-45）に 010 の例外を一言足す。ADR 0014（T038）にも判断を書く。バックアップの置き場所（同期フォルダ）には平文のハッシュの名前を出さない（R11） |
| IV. AIは提案、確定は人 | ✅ | 候補は Zod（`AiReceiptReading`）で項目ごとに検証し、確信度を含め、入力欄の初期値にとどめる（R14、INV-67）。プロバイダは `ReceiptReader` のインターフェースで抽象化する（外部だけ。端末内の `fm` は spec の範囲外）。評価データ（合成の 20 枚、`pnpm eval:receipts`）で精度を比べてから指示文などを変える（R17） |
| V. テストファースト | ✅ | tasks でテストを先に置く。INV-61〜68 は fast-check の性質テストか統合テスト（data-model §4 の「検証」）。フィクスチャは合成の画像（R17）。実データはフィクスチャにしない |
| VI. 税制ルールはデータ | ✅ | 入力期間（2 か月・7 営業日）と画素数の目安（2,338・1,654）を、適用開始日・出典つきで `tax_parameters` に持つ（R2・R3・R20）。seed とマイグレーションの両方に書き、db のテストで一致を確かめる |
| VII. シンプルさと境界 | ✅ | 依存を足さない（`sips`・`node:crypto`）。domain は純関数とポートだけ（暗号化・ファイル・`sips`・AI は db・server）。`.tbk` の形式を変えず、証憑は増分の写しにする（R11）。サムネイル・Service Worker・オフラインの送信・削除の取り消し・一括の書き出しは作らない（YAGNI）。表の作り直しは CHECK の列挙を変えるためで、009 の `0011` と同じ手順 |

**Post-design re-check（Phase 1 後）**: ✅（III は Complexity Tracking で正当化）。D1（スキャナ保存の前提）は利用者が (A) と答えた（2026-11-02。下の Q1）ので、spec を直した。(B) は後の機能の候補。

## spec への差し戻し（spec はこの段階では直さない）

| ID | 対象 | 内容 | 根拠 |
|---|---|---|---|
| D1 | 背景、FR-018、FR-020、US5 | 「タイムスタンプは使わず、訂正・削除の履歴が残る仕組みと事務処理規程で要件を満たす」は**スキャナ保存では成り立たない**（自社システムは時刻の非改ざん性を証明できないので、タイムスタンプの代替要件を満たせない）。スキャナ保存（紙を撮影した証憑）は「紙の原本も保存する写し」と書き直すか、タイムスタンプを使うかを決める。電子取引は規程（規則4①四）で成り立つ | R1、スキャナ問31・問32、電子取引問43 |
| D2 | FR-020 | 事務処理規程に加え、**電子計算機処理システムの概要書**の備付けが要る（自社開発のプログラムを使う電子取引）。FR-020 に足す | R1(g)・R18、電子取引問18 |
| D3 | FR-022、Edge Cases | 解像度に加え、**階調（24 ビットのカラー）**が重要書類の要件。警告に足す。入力期間は「受領から最長 2 か月 + おおむね 7 営業日（業務処理サイクル方式、規程が要る）」、解像度は「A4 の書類で 2,338 × 1,654 画素」と書く。D1 で紙を保存するなら、どちらも法的な効果のない目安の警告になる | R2・R3、スキャナ問10・問23・問26 |
| D4 | FR-008 | 金額のない書類（0 円・空欄）は「未入力」で探せることを書く。金額は書類に書かれた金額（税込）とする | R4、スキャナ問43・問44 |
| D5 | FR-019、Edge Cases | 削除した証憑と同じ内容を追加したときは、削除済みの証憑を案内する（新しく作らない）。削除の取り消しは作らない（必要なら追加の要件） | R7・R10 |
| D6 | FR-021、Assumptions | 証憑のファイルは `.tbk` に入れず、バックアップの置き場所の別のフォルダに増分で写す。復元には `.tbk` と同じフォルダの写しが要る（なければ帳簿だけを戻す選択肢）。同期フォルダの使用量が証憑の合計だけ増える | R11 |
| D7 | Edge Cases（参考） | 税務調査のダウンロードの求め（電子取引の検索の要件の免除の条件）に応じる一括の書き出し（索引の CSV と原本）は spec にない。今は 1 件ずつの取り出しと検索の画面で応じる。要るなら追加の要件 | R1(e)、スキャナ問45 |

## 利用者の判断が要る点

| ID | 問い | 推奨 | 答え（2026-11-02 利用者） |
|---|---|---|---|
| Q1 | スキャナ保存の扱い: (A) 紙の原本を保存し、アプリの証憑は写し（電子取引は規程で対応）／(B) 総務大臣が認定する時刻認証業務のタイムスタンプを足す（有料の契約、ハッシュの外部への送信、応答の検証。依存の追加の可能性）／(C) 他社のクラウドに保存（Constitution III に反する） | **(A)**。この plan は (A) で作った。(B) は後の機能の候補 | **(A)**。紙の原本を保存し、アプリの証憑は写し。電子取引は規程（規則4①四）と検索で要件を満たす。(B) は後の機能の候補 |
| Q2 | 入力期間の判定: 業務処理サイクル方式の最長（2 か月 + 7 営業日、規程に周期を書く）／早期入力方式（7 営業日） | 業務処理サイクル方式（R2）。(A) なら警告だけ | **業務処理サイクル方式**（推奨どおり） |
| Q3 | 「証憑の画像を外部の AI に送る」を端末の設定（`ai_settings`）にするか、事業体ごとにするか | 端末の設定（R15。外部の AI の接続先と同じ場所） | **端末の設定**（`ai_settings`。推奨どおり） |
| Q4 | バックアップの置き場所に証憑の写しのフォルダ `trebuchet-receipts/` を作り、増分で写すこと（同期フォルダの使用量が 10〜20 GB 増えうる） | 承認（R11） | **承認**（`trebuchet-receipts/` に増分で写す） |
| Q5 | PDF の 1 ページ目の描画が `sips`・`qlmanage` でできなかったとき（R12 のゲート）: PDF の読み取りを範囲外にする／依存（`pdfjs-dist` など）を足す | 範囲外にする（手入力）。依存を足すなら `pnpm add` の前に承認 | **ゲートで通らなければ PDF の読み取りは範囲外**（手入力）。依存は足さない |

**spec への反映（2026-11-02）**: Q1〜Q5 の答えを受け、D1〜D7 を `spec.md` に反映した（背景、FR-008・018・019・020・021・022、US5、Edge Cases、Assumptions）。plan の他の節は (A) で書いてあるので変えない。

## Project Structure

### Documentation (this feature)

```text
specs/010-receipts/
├── plan.md              # 本ファイル
├── research.md          # Phase 0（R1〜R22。R1 は電子帳簿保存法の一次資料の確認）
├── data-model.md        # Phase 1（表・ファイル、型と規則、状態、INV-61〜68、マイグレーション）
├── quickstart.md        # Phase 1（§1 自動テスト、§2 手動確認、§3 実環境の確認）
├── contracts/
│   ├── http-api.md      # 追加・変更する API とエラーコード
│   └── domain-module.md # 追加する関数・ユースケース・ポート
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks で作成
```

設計判断の記録: `docs/adr/0014-receipt-storage.md`（Polish で書く。R19 の内容: 暗号化と名前、`.tbk` と別置きの増分の写し、INV-45 の例外の閉じ込め、タイムスタンプを使わず紙の原本を残すこと）。不変条件の索引: `specs/INVARIANTS.md`（010 の節、INV-61〜68）。

### Source Code (repository root)

001〜009 の構成に、次を追加・変更する。

```text
packages/
├── schema/src/
│   ├── receipts.ts                    # 新規: data-model §2.1 の型、RECEIPT_MAX_BYTES、ReceiptQuery（contracts/http-api.md §7）
│   ├── ai.ts                          # AiReceiptReading、AiSettings(Input).receiptImagesEnabled（R14・R15）
│   ├── errors.ts                      # 9 コード（contracts §1。RECEIPT_READ_UNSUPPORTED を含む）
│   └── index.ts                       # 再エクスポート
├── domain/
│   ├── src/
│   │   ├── receipts/                  # 新規（純関数）
│   │   │   ├── format.ts              # detectReceiptFormat（R10）
│   │   │   ├── warnings.ts            # inputDeadline, receiptWarnings（R2・R3）
│   │   │   ├── search.ts              # normalizeReceiptText, matchesReceiptQuery, escapeLike（R4）
│   │   │   ├── candidates.ts          # rankJournalCandidates（R6）
│   │   │   ├── history.ts             # linkStateOf, needsReason, replayReceiptHistory（R5・R7）
│   │   │   ├── jpeg-metadata.ts       # stripJpegMetadata（R12）
│   │   │   ├── reading-prompt.ts      # RECEIPT_READING_SYSTEM_PROMPT, buildReceiptReadingRequest（R13）
│   │   │   └── reading.ts             # parseReceiptReading, compareReadingWith*（R14）
│   │   ├── dates.ts                   # addMonthsToDate, addBusinessDays（R2）
│   │   ├── seed/tax-parameters.ts     # 4 行（R20）
│   │   ├── types.ts                   # TaxParameterKey、Receipt* の行の型、ReceiptAuditEntry
│   │   ├── ports.ts                   # ReceiptStore, ReceiptUnitOfWork, ReceiptFileStore, ReceiptImageTool, ReceiptReader
│   │   └── usecases/
│   │       ├── receipts.ts            # 新規: add / list / get / update / replace / delete / history / readFile
│   │       ├── receipt-links.ts       # 新規: link / unlink / createJournalFromReceipt / candidates / 仕訳の合成
│   │       └── receipt-reading.ts     # 新規: readReceipt（3 段）
│   └── test/
│       ├── fakes/receipts.ts          # FakeReceiptStore, FakeReceiptFileStore, FakeImageTool, FakeReceiptReader
│       ├── receipt-arbitraries.ts     # 証憑・操作の列・JPEG のセグメント・応答の文字列のジェネレーター
│       ├── fixtures/receipts/         # 合成の画像 20 枚、README.md、expected.ts（R17）
│       └── receipts/*.test.ts / *.property.test.ts
└── db/
    ├── src/
    │   ├── schema/tenant.ts           # 5 表、tax_parameters の key
    │   ├── schema/registry.ts         # ai_settings.receipt_images_enabled
    │   ├── receipt-repository.ts      # 新規: ReceiptStore（drizzleUnitOfWork に receipts を足す）
    │   ├── receipt-files.ts           # 新規: encryptReceipt / decryptReceipt / createReceiptFileStore（R8・R9）
    │   ├── tenant-store.ts            # receiptFile(entityId, sha256)、receiptsDir(entityId)
    │   ├── ai-settings-repository.ts  # receiptImagesEnabled
    │   └── backup/
    │       ├── receipts.ts            # 新規: syncReceiptsToStore, restoreReceiptsFromStore, receiptBackupName（R11）
    │       └── restore.ts             # 証憑の復元、RECEIPTS_MISSING、ai_settings の列
    ├── drizzle/tenant/0014_receipts.sql, 0015_receipts_integrity.sql
    ├── drizzle/registry/0002_ai_receipt_images.sql
    └── test/receipt-*.test.ts / backup-receipts.test.ts / tenant-store.test.ts

apps/
├── server/src/
│   ├── routes/receipts.ts             # 新規（contracts §2・§3・§5）
│   ├── routes/journals.ts             # 一覧の receiptCount、詳細の receipts（R6）
│   ├── routes/ai-settings.ts          # receiptImagesEnabled の検査（R15）
│   ├── errors.ts                      # ERROR_STATUS
│   ├── app.ts                         # ルートの登録、createApp の差し替え口（receipts: { imageTool, reader, files }）
│   ├── deps.ts                        # receiptDeps（statementDeps と同形。dateOf は Asia/Tokyo 固定）
│   └── lib/
│       ├── image-tool.ts              # 新規: sips の ReceiptImageTool（R12）
│       ├── ai-client.ts               # createReceiptReader、ChatRequest の content の部品（R13）
│       ├── ai-runtime.ts              # receipts の reader（設定が有効なときだけ）
│       ├── upload.ts                  # 上限を引数で（既存の口のまま）
│       ├── backup-run.ts              # 証憑の写し → .tbk（R11）
│       ├── vault.ts                   # 初回の設定で receipts/ も discarded へ（R9）
│       └── startup.ts                 # .tmp/receipt-convert-* の掃除（R9）
└── web/src/
    ├── features/receipts/             # 新規: api.ts、ReceiptUpload、ReceiptSearchForm、ReceiptList、ReceiptViewer、
    │                                  # ReceiptFieldsForm、ReceiptHistory、LinkJournalDialog、ReceiptReadingNote、CaptureForm
    ├── features/journals/             # 一覧の証憑の印、詳細の証憑の欄
    ├── features/ai-settings/          # 「証憑の画像を外部の AI に送る」と確認
    ├── routes/e/$entityId/receipts/   # 新規: index.tsx、$receiptId.tsx、capture.tsx
    └── routes/index.tsx               # 事業体ごとの「証憑を撮る」への入口（R16）

scripts/
├── restore-backup.ts / lib/restore-cli.ts  # --receipts-dir、--allow-missing-receipts（R11）
├── bench-reports.ts                   # 証憑 5,000 件の検索（SC-002）
└── eval-receipts.ts                   # 新規: pnpm eval:receipts（R17）
docs/
├── receipts/processing-rules.md       # 新規: 事務処理規程（R18）
├── receipts/system-overview.md        # 新規: システム概要書（R18）
└── adr/0014-receipt-storage.md        # 新規（R19）
```

**Structure Decision**: 001 の monorepo と依存の向き（`apps/server → packages/db → packages/domain → packages/schema`、`apps/web → packages/schema`）を変えない。証憑の業務ルールは `packages/domain/src/receipts/` の純関数にし、Biome の `noRestrictedImports` をそのまま適用する（`node:crypto`・`node:fs`・`child_process` は db・server だけ）。暗号化は DK を持つ db（`tenant-store.ts` の `withDataKey`）に、`sips` と外部の AI は server に置き、domain はポートで受け取る。仕訳の画面との合成は 006 と同じくルートで行い、001 のリポジトリ・型を変えない（R6）。

## Phase の進め方（tasks への入力）

1. **Setup**: Q1〜Q5 の答えは記録済み（2026-11-02、Q1 = (A)）。R12 のゲート（**T040**。利用者の Mac で `sips`・`qlmanage` の HEIC・PDF・向き。T001 の直後に行い、`image-tool.ts` の T013 はその結果に従う。O1）。004 の US4（T016b・T001(b)・T022）の状態を確かめ、US2 の実機の確認をその後に置く。合成のフィクスチャ（R17）を作る
2. **Foundational**: schema（`receipts.ts`、`ai.ts`、`errors.ts`。エラーコードは `grep -rn` で全プロジェクトのテストを直す）、`types.ts`・`ports.ts`・`dates.ts`、seed の 4 行、マイグレーション `0014`・`0015`（`) STRICT;`、作り直し、トリガー）と registry `0002`、`ReceiptStore` の実装と `FakeReceiptStore`、`receipt-files.ts`（INV-61）、`ReceiptFileStore` の偽物、arbitraries。履歴の表とトリガーはここで作る（US1 の追加から履歴を残す）
3. **US1**（形式・警告・検索の純関数 → `addReceipt`・`listReceipts`・`getReceipt`・`readReceiptFile` → ルート（multipart、経路、ファイルの応答、`image-tool.ts` の `probe`・`toDisplay`）→ 一覧・詳細・追加の画面）→ **US2**（経路の表示、撮影の画面、事業体の一覧の入口、送信の失敗の表示）→ **US3**（結びつき・候補・証憑からの仕訳の登録・仕訳の一覧と詳細の合成）→ **US5**（訂正・差し替え・削除・履歴の画面、規程とシステム概要書）→ **US4**（設定、`stripJpegMetadata`・`buildReceiptReadingRequest`・`parseReceiptReading`、`createReceiptReader`、`readReceipt`、候補の表示、`eval:receipts`）
4. **バックアップと復元**（FR-021）: `backup/receipts.ts`、`backup-run.ts` の順序、`restore.ts`・`restore-cli.ts` の証憑、INV-68。US1 の後ならいつでもよい
5. 各ユーザーストーリーで「性質／例のテスト → ドメイン → リポジトリ → API → 画面」の順。テストと実装の対を 1 体の部下に渡す。**整合性の難所**（implementer-hard の候補）: INV-62（追加の全部か無か・重複）、INV-63（履歴の完全性）、INV-68（バックアップ → 復元）、R8 の暗号化の形式
6. **Polish**: `bench:reports` に証憑 5,000 件（SC-002）、ADR 0014（INV-45 の例外の判断を含む）、憲法 III の例外の 1 文と AGENTS.md の 006 の規則への一言（C1）、AGENTS.md に「証憑（010）」の節（場所の表、暗号化と名前、INV-45 の例外の経路、`sips` の作業ファイル、バックアップの写し、`eval:receipts` の規則、税制の値の 4 つの key）、`docs/requirements.md` の FR-08・NFR-04・NFR-09 の状態、`specs/INVARIANTS.md`（済み）、quickstart §2 の手動確認、§3 の実環境の確認（利用者）、最終の全体検証

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| III「外部の AI に送る情報は必要最小限、マスクする」の例外（画像はマスクできない） | 利用者の判断（spec、2026-11-02）。証憑の読み取りは画像そのものが入力 | 端末内の AI（`fm`）は spec の範囲外。手入力だけ → 利用者が読み取りを求めた。例外は 2 つの設定・1 つのポート・送る中身の性質テスト（INV-66）で閉じ込め、位置情報は除く |
| 006 の推定の順序（ルール → 端末内の `fm` → 外部）を使わず、証憑の読み取りは外部の AI だけ（ルール・`fm` は範囲外。C2） | 利用者の判断（spec FR-014、2026-11-02）。画像の読み取りは文字の推定と入力の形が違い、006 のルール（取引先の文字列）も `fm`（文字だけ）も画像を扱えない | 006 の順序に載せる → ルールと `fm` は画像を読めず、`SuggestionProvider` に画像の口が要って INV-45 の経路と混ざる。端末内の画像モデル → spec の範囲外（後の機能） |
| 証憑のファイルを `.tbk` の外に別置きで写す（バックアップの形が 2 つになる） | 証憑の合計が 10〜20 GB になり、`.tbk` はメモリー上で組む全量の形式（R11） | `.tbk` に入れる → 世代ごとに全量、メモリーに乗らない。ストリームの形式への作り直しは 004・008 の復元・検査の全部に波及する |
