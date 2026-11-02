import type { ReceiptReadingRequest, SuggestionContext } from "../ports.ts";

// 外部の AI に送る証憑の読み取りの要求（010 research R13、FR-015、INV-66）。
// 送るのは ①固定の指示文 ②科目のコードと名前・税区分のコードの一覧 ③画像 1 枚（メタデータを除いた JPEG）だけ。
// 取引先の一覧・ほかの仕訳・口座・メモ・元のファイル名・証憑に入力済みの値は引数に取らないので送れない。
// 指示文を変えるときは `pnpm eval:receipts` を前後で比べる（R17）

/** AI に送る画像の長辺（画素。R12） */
export const RECEIPT_AI_MAX_PX = 2048;

/** 固定の指示文。読めない項目は null にさせる（推測で埋めさせない。FR-016） */
export const RECEIPT_READING_SYSTEM_PROMPT = [
  "あなたは日本の個人事業主の経理を手伝います。与えられた領収書・請求書・レシートの画像 1 枚から、",
  "取引年月日、税込の合計金額、取引先の名称、勘定科目、税区分を読み取ってください。",
  "",
  "出力は JSON オブジェクトだけにしてください（前後に文章を付けない）:",
  '{"transactionDate": "YYYY-MM-DD", "amount": 税込の合計金額（円の整数）, "partnerName": 取引先の名称,',
  ' "accountCode": 勘定科目のコード, "taxCategory": 税区分のコード,',
  ' "confidence": 0〜100 の整数, "reason": 勘定科目と税区分を選んだ根拠を 200 字以内で}',
  "勘定科目のコードと税区分のコードは、利用者の選択肢の一覧にあるものだけを使ってください。",
  "画像から読み取れない項目、自信のない項目は null にしてください。推測で埋めないでください。",
  "分からないときは confidence を低くしてください。",
].join("\n");

/** 科目と税区分の選択肢の文。科目の行は `<コード> <名前>` */
function choicesOf(context: SuggestionContext): string {
  return [
    "勘定科目（コード 名前）:",
    ...context.accounts.map((a) => `${a.code} ${a.name}`),
    "",
    `税区分のコード: ${context.taxCategories.join(", ")}`,
  ].join("\n");
}

/** 一覧があるときだけ `enum` で縛る（空の `enum` は不正）。null（読めない）は常に許す */
const nullableString = (values: readonly string[]) =>
  values.length > 0 ? { enum: [...values, null] } : { type: ["string", "null"] };

/**
 * `response_format` の `json_schema`（strict）に渡す出力の形。各項目は null を許す。
 * 値の検証は返ってきた後の `parseReceiptReading` が項目ごとに行う
 */
function schemaOf(context: SuggestionContext): object {
  return {
    type: "object",
    properties: {
      transactionDate: { type: ["string", "null"] },
      amount: { type: ["integer", "null"] },
      partnerName: { type: ["string", "null"] },
      accountCode: nullableString(context.accounts.map((a) => a.code)),
      taxCategory: nullableString(context.taxCategories),
      confidence: { type: "integer" },
      reason: { type: "string" },
    },
    required: [
      "transactionDate",
      "amount",
      "partnerName",
      "accountCode",
      "taxCategory",
      "confidence",
      "reason",
    ],
    additionalProperties: false,
  };
}

/**
 * 要求を作る（純関数）。`jpeg` は `stripJpegMetadata` を通した、長辺 `RECEIPT_AI_MAX_PX` 以下の JPEG。
 * 引数にない情報（取引先・仕訳・口座・メモ・ファイル名）は要求に入らない（INV-66）
 */
export function buildReceiptReadingRequest(
  jpeg: Uint8Array,
  context: SuggestionContext,
): ReceiptReadingRequest {
  return {
    system: RECEIPT_READING_SYSTEM_PROMPT,
    choices: choicesOf(context),
    image: { mediaType: "image/jpeg", bytes: jpeg },
    schema: schemaOf(context),
  };
}
