import type { DomainError, Result } from "@trebuchet/domain";
import { RepositoryConflictError } from "@trebuchet/domain";
import type { ErrorCode, ErrorDetails, ErrorResponse } from "@trebuchet/schema";
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** contracts/http-api.md のエラー表 */
const ERROR_STATUS = {
  VALIDATION: 400,
  UNBALANCED: 422,
  ACCOUNT_INACTIVE: 422,
  ACCOUNT_NOT_FOUND: 422,
  OUT_OF_PERIOD: 422,
  REASON_REQUIRED: 422,
  TAX_SETTING_GAP: 422,
  TAX_METHOD_UNSUPPORTED: 422,
  PERIOD_CLOSED: 409,
  VERSION_CONFLICT: 409,
  ACCOUNT_IN_USE: 409,
  ENTITY_NOT_FOUND: 404,
  JOURNAL_NOT_FOUND: 404,
  JOURNAL_VOIDED: 409,
  IMPORT_UNKNOWN_FORMAT: 422,
  IMPORT_WRONG_KIND: 422,
  IMPORT_FILE_CHANGED: 409,
  IMPORT_PLAN_CHANGED: 409,
  IMPORT_NOT_READY: 422,
  IMPORT_BATCH_VOIDED: 409,
  CORRECTED_JOURNALS: 409,
  IMPORT_BATCH_NOT_FOUND: 404,
  FILE_TOO_LARGE: 413,
  ENTITY_KIND_UNSUPPORTED: 422,
  HOME_USE_BASIS_REQUIRED: 422,
  HOME_USE_CHANGE_REASON_REQUIRED: 422,
  SMALL_ASSET_OVER_THRESHOLD: 422,
  SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED: 422,
  SMALL_ASSET_NOT_APPLICABLE: 422,
  DEPRECIATION_METHOD_UNSUPPORTED: 422,
  HOME_USE_ACCOUNT_INVALID: 422,
  ASSET_ACCOUNT_INVALID: 422,
  REPORT_LINE_INVALID: 422,
  ADJUSTMENT_NOT_NEEDED: 422,
  ADJUSTMENT_CHANGED: 409,
  UNAUTHENTICATED: 401,
  CSRF_REJECTED: 403,
  HOST_NOT_ALLOWED: 421,
  ALREADY_REGISTERED: 409,
  WEBAUTHN_FAILED: 400,
  RECOVERY_INVALID: 400,
  RECOVERY_LOCKED: 429,
  LAST_PASSKEY: 409,
  PASSPHRASE_TOO_SHORT: 422,
  PASSPHRASE_MISMATCH: 422,
  PASSPHRASE_WRONG: 422,
  BACKUP_FOLDER_NOT_FOUND: 422,
  BACKUP_NOT_CONFIGURED: 409,
  BACKUP_RUNNING: 409,
  BACKUP_INVALID: 422,
  BACKUP_VERSION_MISMATCH: 422,
  REMOTE_HOST_INVALID: 422,
  REMOTE_NOT_CONFIGURED: 409,
  PAIRING_TOKEN_INVALID: 401,
  INVOICE_NOT_FOUND: 404,
  PAYMENT_NOT_FOUND: 404,
  RECURRING_NOT_FOUND: 404,
  BILLING_TERMS_MISSING: 422,
  INVOICE_ISSUER_INCOMPLETE: 422,
  PARTNER_INACTIVE: 422,
  PAYMENT_EXCEEDS_BALANCE: 422,
  INVOICE_SEQ_TOO_LOW: 422,
  INVOICE_DUPLICATE_MONTH: 409,
  INVOICE_VOIDED: 409,
  INVOICE_HAS_PAYMENTS: 409,
  PAYMENT_VOIDED: 409,
  JOURNAL_LINKED: 409,
  RECURRING_CONFIRM_REQUIRED: 409,
} as const satisfies Record<ErrorCode, ContentfulStatusCode>;

export function errorBody(error: DomainError): ErrorResponse {
  const { code, message, details } = error;
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** ドメインのエラーをレスポンスにする。ルートからは `return fail(c, r.error)` で使う */
export function fail(c: Context, error: DomainError) {
  return c.json(errorBody(error), ERROR_STATUS[error.code]);
}

/**
 * ユースケースの結果をレスポンスにする。失敗は `fail`、成功は `onOk` が返すレスポンス
 * （`return respond(c, result, (v) => c.json({ account: v }, 201))`）。
 * 成功のレスポンスをルート側で作るので、hc の型（ステータスと本文）はそのまま保たれる
 */
export function respond<T, R>(c: Context, result: Result<T>, onOk: (value: T) => R) {
  return result.ok ? onOk(result.value) : fail(c, result.error);
}

/** ルートの外（ミドルウェアなど）から投げるためのドメインエラー */
export class DomainException extends Error {
  readonly error: DomainError;
  constructor(error: DomainError) {
    super(error.message);
    this.name = "DomainException";
    this.error = error;
  }
}

/** Standard Schema・Zod の issue の形（server は zod に直接依存しないため、形で受け取る） */
export type IssueLike = {
  path?: readonly (PropertyKey | { key: PropertyKey })[] | undefined;
  message: string;
};

/**
 * 入力の検証エラー（400 VALIDATION）。Zod の issue を `details.issues` に写す。
 * `pathPrefix` は path の先頭に足す（multipart のフィールド名など）
 */
export function validationError(
  issues: readonly IssueLike[],
  pathPrefix: readonly string[] = [],
): DomainError {
  const details: ErrorDetails = {
    issues: issues.map((i) => ({
      path: [
        ...pathPrefix,
        ...(i.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)),
      ],
      message: i.message,
    })),
  };
  return { code: "VALIDATION", message: "入力が正しくありません", details };
}

export const onError: ErrorHandler = (e, c) => {
  if (e instanceof DomainException) return fail(c, e.error);
  if (e instanceof RepositoryConflictError) {
    return fail(c, { code: "VERSION_CONFLICT", message: e.message });
  }
  if (e instanceof HTTPException) return e.getResponse();
  console.error(e);
  return c.json({ error: { code: "INTERNAL", message: "サーバーでエラーが発生しました" } }, 500);
};
