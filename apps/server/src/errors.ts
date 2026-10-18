import type { DomainError } from "@trebuchet/domain";
import { RepositoryConflictError } from "@trebuchet/domain";
import type { ErrorCode, ErrorDetails, ErrorResponse } from "@trebuchet/schema";
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** contracts/http-api.md のエラー表 */
export const ERROR_STATUS = {
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
} as const satisfies Record<ErrorCode, ContentfulStatusCode>;

export type ErrorStatus = (typeof ERROR_STATUS)[ErrorCode];

export function errorBody(error: DomainError): ErrorResponse {
  const { code, message, details } = error;
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** ドメインのエラーをレスポンスにする。ルートからは `return fail(c, r.error)` で使う */
export function fail(c: Context, error: DomainError) {
  return c.json(errorBody(error), ERROR_STATUS[error.code]);
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

type IssueLike = { path: readonly PropertyKey[]; message: string };

/** Zod の ZodError（server は zod に直接依存しないため、形で判定する） */
function isZodError(e: unknown): e is Error & { issues: IssueLike[] } {
  return (
    e instanceof Error && e.name === "ZodError" && Array.isArray((e as { issues?: unknown }).issues)
  );
}

function zodDetails(e: { issues: IssueLike[] }): ErrorDetails {
  return {
    issues: e.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
  };
}

export const onError: ErrorHandler = (e, c) => {
  if (e instanceof DomainException) return fail(c, e.error);
  if (e instanceof RepositoryConflictError) {
    return fail(c, { code: "VERSION_CONFLICT", message: e.message });
  }
  if (isZodError(e)) {
    return fail(c, {
      code: "VALIDATION",
      message: "入力が正しくありません",
      details: zodDetails(e),
    });
  }
  if (e instanceof HTTPException) return e.getResponse();
  console.error(e);
  return c.json({ error: { code: "INTERNAL", message: "サーバーでエラーが発生しました" } }, 500);
};
