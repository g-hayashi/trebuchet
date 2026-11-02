import type { ReceiptCategory, TaxCategoryCode } from "@trebuchet/schema";
import fc from "fast-check";
import { addDays } from "../src/dates.ts";
import { normalizeReceiptText } from "../src/receipts/search.ts";
import type { ReceiptFileRow, ReceiptRow } from "../src/types.ts";
import { type JpegOptions, jpegBytes } from "./fixtures/receipts/sample-files.ts";

/**
 * 010 の性質テストのジェネレーター（data-model §1 の制約を満たす値）。名前・金額はすべて合成。
 * 操作の列（`receiptOpsArb`）は、対象を「それまでに追加した証憑の添字」（実行側が剰余で解決する）、
 * ファイルの中身を種（`seed`。`jpegBytes({ seed })` で SHA-256 の違うバイト列にする）で指す
 */

// ---- 値 ----

export const receiptCategoryArb: fc.Arbitrary<ReceiptCategory> = fc.constantFrom(
  "paper_scan",
  "electronic",
);

/** 実在する日付（2024-01-01 から約 4 年） */
export const receiptDateArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 1500 })
  .map((n) => addDays("2024-01-01", n));

/** 0 < 金額 < 1e12。小さい額と上限に近い額の両方 */
export const receiptAmountArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 100_000 }),
  fc.integer({ min: 1, max: 999_999_999_999 }),
);

/** 取引先に出る文字（全角・半角・大文字小文字・空白・かな・漢字・LIKE の記号） */
const PARTNER_CHARS = [
  ..."abcXYZ019 -&.,%_\\",
  ..."ＡＢＣｘｙｚ　",
  ..."株式会社カフェコーヒー店あいうえお",
  ..."ｶﾌｪﾄﾞｰ",
];

/** 1〜100 文字、前後に空白がなく、正規化しても空にならない取引先 */
export const partnerNameArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...PARTNER_CHARS), { minLength: 1, maxLength: 100 })
  .map((chars) => chars.join("").trim())
  .filter((s) => s.length > 0 && normalizeReceiptText(s).length > 0);

export const receiptMemoArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...PARTNER_CHARS), { maxLength: 60 })
  .map((chars) => chars.join(""));

const orNull = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | null> => fc.option(arb, { nil: null });

/** 追加の入力（`ReceiptCreateOptions`）。取引年月日・金額・取引先・メモは未入力（null）もある */
export const receiptInputArb = fc.record({
  category: receiptCategoryArb,
  transactionDate: orNull(receiptDateArb),
  amount: orNull(receiptAmountArb),
  partnerName: orNull(partnerNameArb),
  memo: orNull(receiptMemoArb),
});
export type ReceiptInput = {
  category: ReceiptCategory;
  transactionDate: string | null;
  amount: number | null;
  partnerName: string | null;
  memo: string | null;
};

/** 64 文字の小文字の 16 進 */
export const sha256Arb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 })
  .map((chars) => chars.join(""));

const isoTimeArb: fc.Arbitrary<string> = fc.integer({ min: 0, max: 1500 }).chain((day) =>
  fc.integer({ min: 0, max: 86_399 }).map((sec) => {
    const h = String(Math.floor(sec / 3600)).padStart(2, "0");
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${addDays("2024-01-01", day)}T${h}:${m}:${s}.000Z`;
  }),
);

/** 証憑の行（§1.1。`partnerKey`・削除の組が整合している） */
export const receiptRowArb: fc.Arbitrary<ReceiptRow> = fc
  .record({
    id: fc.uuid(),
    receivedAt: isoTimeArb,
    channel: fc.constantFrom("local" as const, "remote" as const),
    category: receiptCategoryArb,
    currentSha256: sha256Arb,
    transactionDate: orNull(receiptDateArb),
    amount: orNull(receiptAmountArb),
    partnerName: orNull(partnerNameArb),
    memo: orNull(receiptMemoArb),
    deleted: fc.option(fc.tuple(isoTimeArb, partnerNameArb), { nil: null }),
    version: fc.integer({ min: 1, max: 50 }),
    createdAt: isoTimeArb,
  })
  .map(
    ({ deleted, createdAt, ...r }): ReceiptRow => ({
      ...r,
      partnerKey: r.partnerName === null ? null : normalizeReceiptText(r.partnerName),
      deletedAt: deleted === null ? null : deleted[0],
      deletedReason: deleted === null ? null : deleted[1],
      createdAt,
      updatedAt: createdAt,
    }),
  );

/** ファイルの行（§1.2） */
export const receiptFileRowArb: fc.Arbitrary<ReceiptFileRow> = fc.record({
  sha256: sha256Arb,
  receiptId: fc.uuid(),
  fileVersion: fc.integer({ min: 1, max: 20 }),
  mediaType: fc.constantFrom(
    "image/jpeg" as const,
    "image/png" as const,
    "image/heic" as const,
    "application/pdf" as const,
  ),
  sizeBytes: fc.integer({ min: 1, max: 20 * 1024 * 1024 }),
  originalName: fc
    .array(fc.constantFrom(..."abcdef012-_ 領収書"), { minLength: 1, maxLength: 30 })
    .map((c) => `${c.join("")}.jpg`),
  width: orNull(fc.integer({ min: 1, max: 10_000 })),
  height: orNull(fc.integer({ min: 1, max: 10_000 })),
  fullColor: fc.option(fc.boolean(), { nil: null }),
  addedAt: isoTimeArb,
  channel: fc.constantFrom("local" as const, "remote" as const),
});

// ---- 操作の列 ----

const reasonArb = fc.constantFrom("誤記の訂正", "撮り直し", "重複のため", "付け替え", "確認済み");
/** 訂正の変更（指定した項目だけ。null は空にする） */
const changesArb = fc.record(
  {
    category: receiptCategoryArb,
    transactionDate: orNull(receiptDateArb),
    amount: orNull(receiptAmountArb),
    partnerName: orNull(partnerNameArb),
    memo: orNull(receiptMemoArb),
  },
  { requiredKeys: [] },
);
const targetArb = fc.nat({ max: 9 });
const seedArb = fc.integer({ min: 0, max: 16_383 });

export type ReceiptOp =
  | { kind: "add"; input: ReceiptInput; seed: number }
  | {
      kind: "update";
      target: number;
      changes: Partial<ReceiptInput>;
      reason: string | undefined;
    }
  | { kind: "replace"; target: number; seed: number; reason: string }
  | { kind: "delete"; target: number; reason: string }
  /** `journal` は仕訳の添字（実行側が剰余で解決する）。`replace` は付け替えの指定 */
  | { kind: "link"; target: number; journal: number; replace: boolean; reason: string | undefined }
  | { kind: "unlink"; target: number; reason: string }
  | { kind: "read"; target: number };

export const receiptOpArb: fc.Arbitrary<ReceiptOp> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("add" as const),
      input: receiptInputArb,
      seed: seedArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("update" as const),
      target: targetArb,
      changes: changesArb,
      reason: fc.option(reasonArb, { nil: undefined }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("replace" as const),
      target: targetArb,
      seed: seedArb,
      reason: reasonArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      target: targetArb,
      reason: reasonArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("link" as const),
      target: targetArb,
      journal: fc.nat({ max: 4 }),
      replace: fc.boolean(),
      reason: fc.option(reasonArb, { nil: undefined }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("unlink" as const),
      target: targetArb,
      reason: reasonArb,
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("read" as const), target: targetArb }) },
);

/** 操作の列。0 件の列も出る。先頭が追加でなくても、実行側は対象がなければ飛ばす */
export const receiptOpsArb: fc.Arbitrary<ReceiptOp[]> = fc.array(receiptOpArb, { maxLength: 25 });

// ---- JPEG ----

/** 寸法つきの JPEG の指定（メタデータの有無・Exif の向き・GPS・IPTC・XMP・コメントが混ざる） */
export type ReceiptJpegOptions = JpegOptions & { width: number; height: number };

export const jpegOptionsArb: fc.Arbitrary<ReceiptJpegOptions> = fc.record(
  {
    width: fc.integer({ min: 1, max: 6000 }),
    height: fc.integer({ min: 1, max: 6000 }),
    orientation: fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }),
    gps: fc.boolean(),
    iptc: fc.boolean(),
    xmp: fc.boolean(),
    comment: fc.option(
      fc.array(fc.constantFrom(..."abcdef 0123"), { maxLength: 40 }).map((c) => c.join("")),
      { nil: undefined },
    ),
    seed: seedArb,
  },
  { requiredKeys: ["width", "height"] },
) as fc.Arbitrary<ReceiptJpegOptions>;

export const jpegBytesArb: fc.Arbitrary<Uint8Array> = jpegOptionsArb.map((o) => jpegBytes(o));

// ---- AI の応答 ----

/** 応答の 1 項目: 正しい値・null・型違い・範囲外・一覧にない値 */
const field = <T>(valid: fc.Arbitrary<T>, invalid: fc.Arbitrary<unknown>) =>
  fc.oneof(
    { weight: 5, arbitrary: valid },
    { weight: 2, arbitrary: fc.constant(null) },
    { weight: 2, arbitrary: invalid },
  );

/**
 * `message.content` の文字列（INV-67 の入力）。項目ごとに正しい値・null・外れた値が混ざった JSON の
 * 文字列、JSON でない文字列、JSON だがオブジェクトでないもの、途中で切れた JSON。
 * `lists` は事業体の科目のコードと税区分の一覧（一覧にあるコードとないコードの両方を作る）
 */
export function readingResponseArb(lists: {
  accountCodes: readonly string[];
  taxCategories: readonly TaxCategoryCode[];
}): fc.Arbitrary<string> {
  const accountCode = field(
    fc.oneof(fc.constantFrom(...lists.accountCodes), fc.stringMatching(/^[0-9]{4}$/)),
    fc.oneof(fc.integer(), fc.constant(""), fc.boolean()),
  );
  const object = fc
    .record({
      transactionDate: field(
        receiptDateArb,
        fc.oneof(fc.constant("2026-02-30"), fc.constant("令和8年1月1日"), fc.integer()),
      ),
      amount: field(
        receiptAmountArb,
        fc.oneof(
          fc.constant(0),
          fc.constant(-5),
          fc.constant(1e12),
          fc.constant(12.5),
          fc.constant("1,000"),
        ),
      ),
      partnerName: field(
        partnerNameArb,
        fc.oneof(fc.constant(""), fc.string({ minLength: 101, maxLength: 120 }), fc.integer()),
      ),
      accountCode,
      taxCategory: field(
        fc.constantFrom(...lists.taxCategories),
        fc.oneof(fc.constant("SALES_99"), fc.integer(), fc.constant("")),
      ),
      confidence: field(
        fc.integer({ min: 0, max: 100 }),
        fc.oneof(fc.constant(101), fc.constant(-1), fc.constant(0.5), fc.constant("high")),
      ),
      reason: fc.oneof(
        fc.string({ maxLength: 200 }),
        fc.string({ minLength: 201, maxLength: 260 }),
        fc.constant(null),
      ),
    })
    .map((o) => JSON.stringify(o));
  const wellFormed = fc
    .record({
      transactionDate: receiptDateArb,
      amount: receiptAmountArb,
      partnerName: partnerNameArb,
      accountCode: fc.constantFrom(...lists.accountCodes),
      taxCategory: fc.constantFrom(...lists.taxCategories),
      confidence: fc.integer({ min: 0, max: 100 }),
      reason: fc.string({ maxLength: 200 }),
    })
    .map((o) => JSON.stringify(o));
  return fc.oneof(
    { weight: 4, arbitrary: wellFormed },
    { weight: 6, arbitrary: object },
    { weight: 1, arbitrary: fc.string({ maxLength: 80 }) },
    { weight: 1, arbitrary: fc.constantFrom("null", "[]", "[1,2]", "42", '"text"', "true") },
    { weight: 1, arbitrary: object.map((s) => s.slice(0, Math.max(1, Math.floor(s.length / 2)))) },
  );
}
