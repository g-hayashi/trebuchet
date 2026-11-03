import type { ReceiptMediaType, TaxCategoryCode } from "@trebuchet/schema";
import type { ReceiptImageTool, ReceiptReader, SuggestionContext } from "../ports.ts";
import { perMille } from "../statements/evals.ts";
import { stripJpegMetadata } from "./jpeg-metadata.ts";
import {
  parseReceiptReading,
  RECEIPT_READING_ERROR,
  type ReceiptCandidates,
  type ReceiptReadingErrorCode,
} from "./reading.ts";
import { buildReceiptReadingRequest, RECEIPT_AI_MAX_PX } from "./reading-prompt.ts";
import { normalizeReceiptText } from "./search.ts";

// 証憑の読み取りの評価（010 research R17、Constitution IV）。合成の画像を外部の AI に送り、項目ごとの一致率を出す。
// 指示文・`RECEIPT_AI_MAX_PX`・`RECEIPT_READ_TIMEOUT_MS` を変えるときは `pnpm eval:receipts` を前後で比べる。
// 純関数（画像の変換と AI は引数で受け取る）。結果は件数と千分率だけで、例の名前・取引先・値を含まない

/** 評価の対象の項目（結果の `fields` はこの順） */
export const RECEIPT_EVAL_FIELDS = [
  "transactionDate",
  "amount",
  "partnerName",
  "accountCode",
  "taxCategory",
] as const;
export type ReceiptEvalField = (typeof RECEIPT_EVAL_FIELDS)[number];

/** 目標の一致率（千分率）。取引年月日・金額が 90% 以上（20 枚中 18 枚）。取引先・科目・税区分は記録だけ */
export const RECEIPT_EVAL_TARGETS: Readonly<Partial<Record<ReceiptEvalField, number>>> = {
  transactionDate: 900,
  amount: 900,
};

/** 正解。null は正解を決めない項目（集計しない） */
export type ReceiptEvalExpected = {
  transactionDate: string | null;
  amount: number | null;
  partnerName: string | null;
  accountCode: string | null;
  taxCategory: TaxCategoryCode | null;
};

/** 評価の 1 例。`name` は表示用で結果には出さない */
export type ReceiptEvalCase = {
  name: string;
  bytes: Uint8Array;
  mediaType: ReceiptMediaType;
  expected: ReceiptEvalExpected;
};

/** 率は千分率の整数（0〜1000）。件数 0 のときは 0 */
export type ReceiptEvalResult = {
  caseCount: number;
  /** 候補を得られた（変換・AI の失敗がなく、出力が JSON だった）例の率 */
  succeededRate: number;
  /** 失敗の理由別の件数（R13 の写像） */
  failures: Record<ReceiptReadingErrorCode, number>;
  /** `count` は正解を決めた例の件数、`matchRate` はそのうち候補が正解と同じ率（失敗・null は不一致） */
  fields: { field: ReceiptEvalField; count: number; matchRate: number }[];
};

export type ReceiptEvalDeps = {
  reader: ReceiptReader;
  images: ReceiptImageTool;
  context: SuggestionContext;
};

/** 時間切れの印（`details.timeout`。`readReceipt` と同じ） */
const isTimeout = (details: unknown): boolean =>
  typeof details === "object" &&
  details !== null &&
  (details as { timeout?: unknown }).timeout === true;

type Outcome =
  | { kind: "failed"; code: ReceiptReadingErrorCode }
  | { kind: "read"; candidates: ReceiptCandidates };

/** 変換 → メタデータの除去 → 要求 → AI → 検証（`readReceipt` の 2 段目と同じ関数・同じ写像） */
async function recognize(deps: ReceiptEvalDeps, c: ReceiptEvalCase): Promise<Outcome> {
  const converted = await deps.images.toAiJpeg(c.bytes, c.mediaType, RECEIPT_AI_MAX_PX);
  if (!converted.ok) {
    return {
      kind: "failed",
      code:
        converted.error.code === "RECEIPT_READ_UNSUPPORTED"
          ? RECEIPT_READING_ERROR.RECEIPT_READ_UNSUPPORTED
          : RECEIPT_READING_ERROR.RECEIPT_CONVERSION_FAILED,
    };
  }
  const stripped = stripJpegMetadata(converted.value);
  if (!stripped.ok)
    return { kind: "failed", code: RECEIPT_READING_ERROR.RECEIPT_CONVERSION_FAILED };
  const response = await deps.reader.read(buildReceiptReadingRequest(stripped.value, deps.context));
  if (!response.ok) {
    return {
      kind: "failed",
      code: isTimeout(response.error.details)
        ? RECEIPT_READING_ERROR.AI_TIMEOUT
        : RECEIPT_READING_ERROR.AI_HTTP_ERROR,
    };
  }
  const parsed = parseReceiptReading(response.value, deps.context);
  if (parsed.status === "invalid") {
    return { kind: "failed", code: RECEIPT_READING_ERROR.AI_INVALID_OUTPUT };
  }
  return { kind: "read", candidates: parsed.candidates };
}

/** 項目の一致。取引先は `normalizeReceiptText` で比べる（`compareReadingWithSaved` と同じ） */
function matches(
  field: ReceiptEvalField,
  expected: ReceiptEvalExpected,
  candidates: ReceiptCandidates,
): boolean {
  const want = expected[field];
  const got = candidates[field];
  if (want === null || got === null) return false;
  if (field === "partnerName") {
    return normalizeReceiptText(String(got)) === normalizeReceiptText(String(want));
  }
  return got === want;
}

/**
 * 例ごとに `readReceipt` の 2 段目と同じ経路（`toAiJpeg` → `stripJpegMetadata` → `buildReceiptReadingRequest` →
 * `reader.read` → `parseReceiptReading`）で候補を作り、正解と比べる。例は 1 件ずつ順に呼ぶ。
 * 出力は件数と率だけ（例の名前・値は含めない）
 */
export async function evaluateReceiptReadings(
  cases: readonly ReceiptEvalCase[],
  deps: ReceiptEvalDeps,
): Promise<ReceiptEvalResult> {
  const failures: Record<ReceiptReadingErrorCode, number> = {
    AI_TIMEOUT: 0,
    AI_HTTP_ERROR: 0,
    AI_INVALID_OUTPUT: 0,
    RECEIPT_READ_UNSUPPORTED: 0,
    RECEIPT_CONVERSION_FAILED: 0,
  };
  const counts = new Map<ReceiptEvalField, { count: number; matched: number }>(
    RECEIPT_EVAL_FIELDS.map((field) => [field, { count: 0, matched: 0 }]),
  );
  let succeeded = 0;

  for (const c of cases) {
    const outcome = await recognize(deps, c);
    if (outcome.kind === "failed") failures[outcome.code] += 1;
    else succeeded += 1;
    for (const field of RECEIPT_EVAL_FIELDS) {
      if (c.expected[field] === null) continue;
      const entry = counts.get(field);
      if (entry === undefined) continue;
      entry.count += 1;
      if (outcome.kind === "read" && matches(field, c.expected, outcome.candidates)) {
        entry.matched += 1;
      }
    }
  }

  return {
    caseCount: cases.length,
    succeededRate: perMille(succeeded, cases.length),
    failures,
    fields: RECEIPT_EVAL_FIELDS.map((field) => {
      const entry = counts.get(field) ?? { count: 0, matched: 0 };
      return { field, count: entry.count, matchRate: perMille(entry.matched, entry.count) };
    }),
  };
}

/** 目標のある項目の達成。件数 0（正解がない）は未達 */
export function receiptEvalTargets(
  result: ReceiptEvalResult,
): { field: ReceiptEvalField; target: number; met: boolean }[] {
  return result.fields.flatMap((f) => {
    const target = RECEIPT_EVAL_TARGETS[f.field];
    return target === undefined
      ? []
      : [{ field: f.field, target, met: f.count > 0 && f.matchRate >= target }];
  });
}
