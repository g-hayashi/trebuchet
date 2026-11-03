import { AiReceiptReading, type TaxCategoryCode } from "@trebuchet/schema";
import type { SuggestionContext } from "../ports.ts";
import { readAiJson } from "../statements/prompt.ts";
import type { ReceiptReadingRow } from "../types.ts";
import { normalizeReceiptText } from "./search.ts";

// 外部の AI の出力の検証と、保存した値・登録した仕訳との比べ（010 research R14、FR-016・017、INV-67）。
// 候補は応答として返すだけで、証憑の値は変えない（保存は利用者の更新だけ）

/**
 * `receipt_readings.error_code` に記録する文字列の定数（R13 の写像。`ErrorCode` ではない）。
 * 変換が PDF を描けない → `RECEIPT_READ_UNSUPPORTED`、変換・メタデータの除去の失敗 → `RECEIPT_CONVERSION_FAILED`、
 * AI の時間切れ → `AI_TIMEOUT`、AI の通信・HTTP の失敗 → `AI_HTTP_ERROR`、出力が JSON でない → `AI_INVALID_OUTPUT`
 */
export const RECEIPT_READING_ERROR = {
  AI_TIMEOUT: "AI_TIMEOUT",
  AI_HTTP_ERROR: "AI_HTTP_ERROR",
  AI_INVALID_OUTPUT: "AI_INVALID_OUTPUT",
  RECEIPT_READ_UNSUPPORTED: "RECEIPT_READ_UNSUPPORTED",
  RECEIPT_CONVERSION_FAILED: "RECEIPT_CONVERSION_FAILED",
} as const;
export type ReceiptReadingErrorCode =
  (typeof RECEIPT_READING_ERROR)[keyof typeof RECEIPT_READING_ERROR];

/** 検証を通った候補（なければ null） */
export type ReceiptCandidates = {
  transactionDate: string | null;
  amount: number | null;
  partnerName: string | null;
  accountCode: string | null;
  taxCategory: TaxCategoryCode | null;
};

export type ParsedReceiptReading = {
  /** `invalid`: 応答を JSON のオブジェクトとして読めない（候補は全部 null） */
  status: "succeeded" | "invalid";
  candidates: ReceiptCandidates;
  confidence: number | null;
  /** 候補の根拠の短い説明（200 字まで。超えれば null。保存しない） */
  reason: string | null;
};

const NO_CANDIDATES: ReceiptCandidates = {
  transactionDate: null,
  amount: null,
  partnerName: null,
  accountCode: null,
  taxCategory: null,
};

const EXPECTED_KEYS = [
  "transactionDate",
  "amount",
  "partnerName",
  "accountCode",
  "taxCategory",
  "confidence",
  "reason",
] as const;

const invalid = (): ParsedReceiptReading => ({
  status: "invalid",
  candidates: { ...NO_CANDIDATES },
  confidence: null,
  reason: null,
});

/** 検証を通れば値、そうでなければ null（項目ごと。`schema` は `AiReceiptReading.shape` の 1 項目） */
function pick<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * AI の応答（`message.content`。JSON の文字列でも、読み取り済みの値でもよい）を検証する（INV-67）。
 * JSON のオブジェクトとして読めなければ `invalid` で全部 null。読めれば**項目ごとに** `AiReceiptReading` の
 * 該当の Zod で検証し、合わない項目だけ候補なしにする（FR-016）。科目は `context.accounts` のコード、
 * 税区分は `context.taxCategories` にあるものだけ。取引先は前後の空白を除く。応答が期待する項目名を
 * 1 つも持たないオブジェクト（`{}` など）も `invalid`
 */
export function parseReceiptReading(
  raw: unknown,
  context: SuggestionContext,
): ParsedReceiptReading {
  const value = typeof raw === "string" ? readAiJson(raw) : raw;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const obj = value as Record<string, unknown>;
  if (!EXPECTED_KEYS.some((key) => key in obj)) return invalid();

  const { shape } = AiReceiptReading;
  const partner = typeof obj.partnerName === "string" ? obj.partnerName.trim() : obj.partnerName;
  const accountCode = pick(shape.accountCode, obj.accountCode);
  const taxCategory = pick(shape.taxCategory, obj.taxCategory);
  const reason = pick(shape.reason, obj.reason);
  return {
    status: "succeeded",
    candidates: {
      transactionDate: pick(shape.transactionDate, obj.transactionDate),
      amount: pick(shape.amount, obj.amount),
      partnerName: pick(shape.partnerName, partner),
      accountCode:
        accountCode !== null && context.accounts.some((a) => a.code === accountCode)
          ? accountCode
          : null,
      taxCategory:
        taxCategory !== null && context.taxCategories.includes(taxCategory) ? taxCategory : null,
    },
    confidence: pick(shape.confidence, obj.confidence),
    reason: reason === null || reason.trim().length === 0 ? null : reason,
  };
}

/** 記録した読み取りの候補（`status` が `succeeded` でなければ全部 null） */
export const candidatesOf = (row: ReceiptReadingRow): ReceiptCandidates => ({
  transactionDate: row.candDate,
  amount: row.candAmount,
  partnerName: row.candPartner,
  accountCode: row.candAccountCode,
  taxCategory: row.candTaxCategory,
});

/** 利用者が保存した値（未入力は null） */
export type SavedReceiptValues = {
  transactionDate: string | null;
  amount: number | null;
  partnerName: string | null;
};

export type SavedComparison = {
  dateMatch: boolean | null;
  amountMatch: boolean | null;
  partnerMatch: boolean | null;
};

/**
 * 候補と保存した値の比べ（FR-017）。日付・金額は等しいか、取引先は `normalizeReceiptText` で比べる。
 * 候補が null、または保存した値が null（利用者がまだ決めていない）の項目は比べない（null）
 */
export function compareReadingWithSaved(
  candidates: ReceiptCandidates,
  saved: SavedReceiptValues,
): SavedComparison {
  const same = <T>(candidate: T | null, value: T | null, eq: (a: T, b: T) => boolean) =>
    candidate === null || value === null ? null : eq(candidate, value);
  const equal = <T>(a: T, b: T) => a === b;
  return {
    dateMatch: same(candidates.transactionDate, saved.transactionDate, equal),
    amountMatch: same(candidates.amount, saved.amount, equal),
    partnerMatch: same(
      candidates.partnerName,
      saved.partnerName,
      (a, b) => normalizeReceiptText(a) === normalizeReceiptText(b),
    ),
  };
}

/** 登録した仕訳の行（科目はコード。税区分） */
export type JournalLineCodes = { accountCode: string; taxCategory: string };

export type JournalComparison = {
  accountMatch: boolean | null;
  taxMatch: boolean | null;
};

/** 候補と登録した仕訳の比べ（FR-017）。仕訳のどれかの行の科目コード・税区分が候補と同じか。候補が null なら null */
export function compareReadingWithJournal(
  candidates: ReceiptCandidates,
  journal: { lines: readonly JournalLineCodes[] },
): JournalComparison {
  return {
    accountMatch:
      candidates.accountCode === null
        ? null
        : journal.lines.some((l) => l.accountCode === candidates.accountCode),
    taxMatch:
      candidates.taxCategory === null
        ? null
        : journal.lines.some((l) => l.taxCategory === candidates.taxCategory),
  };
}
