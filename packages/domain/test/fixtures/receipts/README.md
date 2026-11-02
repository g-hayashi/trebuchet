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
- 画像を足す・消すときは `expected.ts` を同じファイル名で合わせる。食い違うと `pnpm eval:receipts` は AI を呼ばずに止まる
- `accountCode` は初期の科目（`seed/accounts.individual.ts`）のコード、`taxCategory` は `TaxCategoryCode` の値
- 目標: 取引年月日・金額の一致率が 90% 以上（20 枚中 18 枚）。取引先・科目・税区分は記録だけ。結果は `.tmp/eval-receipts/` に件数と割合だけ
- 集計の確認（偽の reader）は `packages/domain/test/receipts/evals.test.ts`。外部の AI は CI で呼ばない
