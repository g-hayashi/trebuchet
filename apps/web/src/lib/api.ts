import { QueryClient } from "@tanstack/react-query";
import { type ErrorCode, ErrorResponse } from "@trebuchet/schema";
import type { AppType } from "@trebuchet/server";
import { hc } from "hono/client";

export const api = hc<AppType>("/");

/** API のエラー（contracts/http-api.md のエラー形式） */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | "INTERNAL";
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: ErrorCode | "INTERNAL",
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type JsonBody<R> = R extends { json(): Promise<infer J> } ? J : never;

/** 成功ならボディを返し、失敗なら ApiError を投げる */
export async function unwrap<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  res: R,
): Promise<Exclude<JsonBody<R>, ErrorResponse>> {
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) return body as Exclude<JsonBody<R>, ErrorResponse>;
  const parsed = ErrorResponse.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    throw new ApiError(res.status, code, message, details);
  }
  throw new ApiError(res.status, "INTERNAL", `HTTP ${res.status}`);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});
