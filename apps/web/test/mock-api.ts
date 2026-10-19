import type { ErrorCode } from "@trebuchet/schema";
import { vi } from "vitest";

/** query はクエリ文字列（キーと値）。body は JSON のボディ、form は multipart/form-data のボディ */
export type ApiCall = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  form?: FormData | undefined;
};
export type ApiReply = { status: number; body: unknown };
type Handler = (call: ApiCall) => ApiReply | Promise<ApiReply>;

export const ok = (body: unknown, status = 200): ApiReply => ({ status, body });

/** contracts/http-api.md のエラー形式の応答 */
export const apiError = (
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiReply => ({ status, body: { error: { code, message, ...(details && { details }) } } });

/**
 * fetch を差し替え、"GET /api/..." の形のキーで応答を返す。受けた呼び出しを順に記録して返す。
 * 後片付けは vi.unstubAllGlobals() で行う
 */
export function mockApi(routes: Record<string, Handler>): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const form = init?.body instanceof FormData ? init.body : undefined;
      const call: ApiCall = {
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        form,
      };
      calls.push(call);
      const handler = routes[`${method} ${url.pathname}`];
      const reply = handler
        ? await handler(call)
        : ok({ message: `${method} ${url.pathname} は未定義です` }, 500);
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

export type FormFieldSummary = string | { name: string; type: string; size: number };

/**
 * multipart のボディを、比べやすい形にする。ファイルは名前・種類・大きさ、他のフィールドは文字列のまま。
 * 同じ名前のフィールドが複数あるときは配列にする
 */
export function formFields(
  form: FormData | undefined,
): Record<string, FormFieldSummary | FormFieldSummary[]> | undefined {
  if (!form) return undefined;
  const fields: Record<string, FormFieldSummary | FormFieldSummary[]> = {};
  for (const [key, value] of form.entries()) {
    const summary: FormFieldSummary =
      typeof value === "string" ? value : { name: value.name, type: value.type, size: value.size };
    const prev = fields[key];
    fields[key] =
      prev === undefined ? summary : [...(Array.isArray(prev) ? prev : [prev]), summary];
  }
  return fields;
}
