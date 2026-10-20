import { z } from "zod";

export const ErrorCode = z.enum([
  "VALIDATION",
  "UNBALANCED",
  "ACCOUNT_INACTIVE",
  "ACCOUNT_NOT_FOUND",
  "OUT_OF_PERIOD",
  "PERIOD_CLOSED",
  "REASON_REQUIRED",
  "VERSION_CONFLICT",
  "ACCOUNT_IN_USE",
  "TAX_SETTING_GAP",
  "TAX_METHOD_UNSUPPORTED",
  "ENTITY_NOT_FOUND",
  "JOURNAL_NOT_FOUND",
  "JOURNAL_VOIDED",
  // 002-freee-import（contracts/http-api.md）
  "IMPORT_UNKNOWN_FORMAT",
  "IMPORT_WRONG_KIND",
  "IMPORT_FILE_CHANGED",
  "IMPORT_PLAN_CHANGED",
  "IMPORT_NOT_READY",
  "IMPORT_BATCH_VOIDED",
  "CORRECTED_JOURNALS",
  "IMPORT_BATCH_NOT_FOUND",
  "FILE_TOO_LARGE",
  // 003-tax-return（contracts/http-api.md）
  "ENTITY_KIND_UNSUPPORTED",
  "HOME_USE_BASIS_REQUIRED",
  "HOME_USE_CHANGE_REASON_REQUIRED",
  "SMALL_ASSET_OVER_THRESHOLD",
  "SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED",
  "SMALL_ASSET_NOT_APPLICABLE",
  "DEPRECIATION_METHOD_UNSUPPORTED",
  "HOME_USE_ACCOUNT_INVALID",
  "ASSET_ACCOUNT_INVALID",
  "REPORT_LINE_INVALID",
  "ADJUSTMENT_NOT_NEEDED",
  "ADJUSTMENT_CHANGED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorDetails = z.record(z.string(), z.unknown());
export type ErrorDetails = z.infer<typeof ErrorDetails>;

/** API のエラーレスポンス（contracts/http-api.md） */
export const ErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: ErrorDetails.optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const WarningCode = z.enum([
  "POSSIBLE_DUPLICATE",
  "NEGATIVE_BALANCE",
  "OPENING_BALANCE_MISSING",
]);
export type WarningCode = z.infer<typeof WarningCode>;

export const Warning = z.object({
  code: WarningCode,
  message: z.string(),
  details: ErrorDetails.optional(),
});
export type Warning = z.infer<typeof Warning>;
