# 証憑のフィクスチャ（010-receipts）

証憑（領収書・レシート）の形式の判定、JPEG のメタデータの除去、暗号化、重複の判定、追加の全部か無かのテストが使う、**合成の**バイト列（research R17）。

| ファイル | 内容 |
|---|---|
| `sample-files.ts` | 最小の合成バイト列を返す関数と、読み戻す小さな関数。下の表 |

| 関数 | 作るもの |
|---|---|
| `jpegBytes(options)` | SOI, [APP1 Exif], [APP1 XMP], [APP13], [COM], DQT, SOF0, SOS, 画素の代わりの数バイト, EOI。`orientation`・`gps` で Exif（Orientation と、合成の `0°0′0″N` の GPS）、`xmp`・`iptc`・`comment` で別のセグメント、`width`・`height` で SOF0 の寸法（画素数が違う 2 種）、`seed` で中身（SHA-256）を変える |
| `jpegSegments`・`jpegDimensions`・`readExif` | セグメントの並び、SOF0 の寸法、Exif の Orientation と GPS の有無を読み戻す（テストの確認用） |
| `pngBytes(options)`・`pngDimensions` | 署名、IHDR（寸法）、IDAT（数バイト）、IEND。各チャンクの CRC は正しい |
| `pdfBytes(options)` | `%PDF-` で始まり `%%EOF` で終わる空の 1 ページ。`leading` は `%PDF-` の前に置くバイト数（先頭 1,024 バイト以内の判定用） |
| `heicBytes({ major, compatible })`・`ftypBrands`・`mp4Bytes` | `ftyp` ボックス（major brand と compatible brands）と小さな `mdat`。`mp4Bytes` は `ftyp` を持つが HEIC の brands を持たない |
| `mislabeledSamples()` | 拡張子と中身が違うもの（`receipt.jpg` の中身が PDF、`receipt.pdf` が PNG、`receipt.png` がテキスト、`receipt.heic` が JPEG）。形式は中身で判定する（R10） |
| `emptyBytes()`・`shortBytes()` | 0 バイト、どの形式の先頭にも足りない長さ（`%PD`） |

## 匿名化の方針

- **実データの写真・文字列を入れない**。バイト列はすべてコードで組み立てた合成。Exif の GPS は `0°0′0″N` の合成の値で、実在の場所を指さない
- どれも画素は描けない。意味を持つのは先頭のマーカー、ヘッダー（寸法・brands）、セグメントの並びだけ。`sips` などの画像の変換は、これらを入力にしない（変換の確認は T040 のゲートで利用者の Mac で行う）
- 実データ（`work/`、`data/`）から写してよいのは、形式の仕様どおりのバイトの並び（マーカー、ボックスの形）だけ

## 作り方

- 手で書いたコードが作る。画像の生成ツールや使い捨てのスクリプトを使わない。1 つのファイルに畳んであるので、形式を足すときは `sample-files.ts` に関数を足し、`packages/domain/test/receipts/sample-files.test.ts` に先頭のマーカー・並びの確認を足す
- 同じ指定なら同じバイト列になる（決定的）。SHA-256 の違うファイルが要るときは `seed` を変える

## 評価用の画像（`pnpm eval:receipts`、R17。画像の用意は T042）

| ファイル | 内容 |
|---|---|
| `eval/<ファイル名>` | 合成の証憑 20 枚（レシート・領収書・電子の PDF を混ぜる。HEIC 2 枚、PDF 2 枚を含む）。JPEG・PNG・HEIC・PDF。形式は中身で判定する |
| `expected.ts` | `RECEIPT_EVAL_EXPECTED`: `eval/` のファイル名 → 正解（`transactionDate`・`amount`・`partnerName`・`accountCode`・`taxCategory`）。正解を決めない項目は `null`（集計しない） |

- 画像は**合成だけ**（実データの写真・実在の取引先名を入れない。上の匿名化の方針と同じ）。作る手順はリポジトリに置かない使い捨てのスクリプト（002・007 と同じ）。正解は画像を作るときに決めた値
- 上の「作り方」（`sample-files.ts` の最小のバイト列）の例外。`eval/` の画像は画素のある本物の画像で、`sample-files.ts` は使わない

### 一覧（`eval/`。値は合成）

| ファイル | 種類 | 形式 | 日付の書式 | 取引先 | 金額（税込） | 備考 |
|---|---|---|---|---|---|---|
| `receipt-01.jpg` | 感熱レシート | JPEG | 2026/10/20 | 合成商店 | 1,100 | 外税 10%、少し傾き |
| `receipt-02.jpg` | 感熱レシート | JPEG | 2026年10月21日 | テスト文具 | 3,278 | 外税 10% |
| `receipt-03.jpg` | 感熱レシート | JPEG | 令和8年10月22日 | サンプル食堂 | 864 | 軽減税率 8% のみ（持ち帰り） |
| `receipt-04.jpg` | 感熱レシート | JPEG | R8.10.23 | 見本スーパー | 2,374 | 8% と 10% の混在（科目・税区分は正解なし） |
| `receipt-05.jpg` | 印字の領収書 | JPEG | 2026-10-24 | 架空タクシー | 2,350 | 宛名「上様」 |
| `receipt-06.png` | 感熱レシート | PNG | 2026/10/25 | 合成コーヒー | 1,540 | 内税 10% |
| `receipt-07.jpg` | 印字の領収書 | JPEG | 2026年10月26日 | テスト事務機 | 12,000 | |
| `receipt-08.jpg` | 手書き風の領収書 | JPEG | 令和8年10月27日 | 合成工房 | 33,000 | 「也」つき、傾き |
| `receipt-09.png` | 印字の領収書 | PNG | 2026.10.28 | 架空運輸 | 5,500 | |
| `receipt-10.jpg` | 印字の領収書 | JPEG | 2026/10/29 | 架空テレコム | 4,400 | |
| `receipt-11.jpg` | 感熱レシート | JPEG | 2026/10/30 | 見本パーキング | 1,200 | 内税 10% |
| `receipt-12.jpg` | 印字の領収書 | JPEG | 2026年11月1日 | 架空新聞 | 3,200 | 軽減税率 8%（購読料） |
| `receipt-13.jpg` | 印字の領収書 | JPEG | 令和8年11月2日 | 架空ホテル | 12,100 | |
| `receipt-14.jpg` | 感熱レシート | JPEG | 2026/10/31 | 見本居酒屋 | 18,700 | 外税 10%、明細 6 行 |
| `receipt-15.png` | 手書き風の領収書 | PNG | 令和8年10月30日 | 架空不動産 | 65,000 | 賃料（非課税） |
| `receipt-16.jpg` | 感熱レシート（お支払い票） | JPEG | 2026/10/15 | 架空電力 | 6,820 | 外税 10% |
| `receipt-17.heic` | 手書き風の領収書 | HEIC | R8.10.18 | テスト研修センター | 22,000 | 元は `.tmp/receipts-gen/heic-src/` の PNG |
| `receipt-18.heic` | 感熱レシート | HEIC | 2026/10/12 | 合成プリント | 4,950 | 同上 |
| `receipt-19.pdf` | 電子の請求書兼領収書 | PDF（A4、1 ページ） | 2026年10月5日 | 合成クラウド株式会社 | 3,300 | 登録番号は `T0000000000000`（架空） |
| `receipt-20.pdf` | 電子の領収書 | PDF（A4、1 ページ） | 2026-10-10 | 架空デザイン | 55,000 | 明細 2 行 |

- 内訳は JPEG 13・PNG 3・HEIC 2・PDF 2。正解の科目コード・税区分は `expected.ts`（8% と 10% の混在の `receipt-04` は科目・税区分とも `null`）

### 作り方（使い捨て）

- 合成の文書を HTML で組み、ブラウザ（Playwright の Chromium）で開いて、スクリーンショット（JPEG・PNG。長辺 1,300〜1,900 px 程度）と印刷（PDF）で保存した。HTML と生成スクリプトはリポジトリに置かない
- HEIC は、PNG で保存した元の画像を macOS の `sips` で変換して置く: `sips -s format heic <元の PNG> --out packages/domain/test/fixtures/receipts/eval/receipt-17.heic`（`receipt-18.heic` も同じ）。`eval:receipts` は HEIC を本番と同じ経路（`sips`）で JPEG にして AI に送る
- 画像を差し替えたら、`expected.ts` の正解を同じファイル名で合わせる

### 匿名化

- 取引先・宛名・住所・電話番号・登録番号はすべて明らかな架空（「合成商店」「架空市」「000-0000-0000」「T0000000000000」など）。実在の店名・チェーン名・番号を使わない
- 画像に実データの写真・Exif（GPS など）を含めない。ブラウザの描画から作るので撮影の情報はない
- 画像を足す・消すときは `expected.ts` を同じファイル名で合わせる。食い違うと `pnpm eval:receipts` は AI を呼ばずに止まる
- `accountCode` は初期の科目（`seed/accounts.individual.ts`）のコード、`taxCategory` は `TaxCategoryCode` の値
- 目標: 取引年月日・金額の一致率が 90% 以上（20 枚中 18 枚）。取引先・科目・税区分は記録だけ。結果は `.tmp/eval-receipts/` に件数と割合だけ
- 集計の確認（偽の reader）は `packages/domain/test/receipts/evals.test.ts`。外部の AI は CI で呼ばない
