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
