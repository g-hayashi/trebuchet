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

/** `error` が、エラーコード `code` の ApiError か */
export function isApiError<C extends ApiError["code"]>(
  error: unknown,
  code: C,
): error is ApiError & { readonly code: C } {
  return error instanceof ApiError && error.code === code;
}

/** 事業体の API のパス。hc の型つきの呼び出しを使えない箇所（multipart、ダウンロードの URL）で使う */
export const entityPath = (entityId: string) => `/api/entities/${encodeURIComponent(entityId)}`;

type JsonBody<R> = R extends { json(): Promise<infer J> } ? J : never;

/**
 * API が 401 UNAUTHENTICATED か 401 LOCKED（施錠中。008）を返したときに window へ送るイベント。
 * 認証の状態を持つ AuthGate が受けて、状態を取り直し、解錠の画面に戻す
 */
export const UNAUTHENTICATED_EVENT = "trebuchet:unauthenticated";

/** 成功ならボディを返し、失敗なら ApiError を投げる */
export async function unwrap<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  res: R,
): Promise<Exclude<JsonBody<R>, ErrorResponse>> {
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) return body as Exclude<JsonBody<R>, ErrorResponse>;
  const parsed = ErrorResponse.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    if (res.status === 401 && (code === "UNAUTHENTICATED" || code === "LOCKED")) {
      window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    }
    throw new ApiError(res.status, code, message, details);
  }
  throw new ApiError(res.status, "INTERNAL", `HTTP ${res.status}`);
}

type QueryFactory = (...args: never[]) => { queryFn?: unknown };
/** クエリの結果の型 */
export type QueryData<Q extends QueryFactory> = Awaited<
  ReturnType<Extract<ReturnType<Q>["queryFn"], (...args: never[]) => unknown>>
>;
/** クエリの結果の型（配列ならその要素の型） */
export type QueryItem<Q extends QueryFactory> =
  QueryData<Q> extends readonly (infer I)[] ? I : QueryData<Q>;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});
