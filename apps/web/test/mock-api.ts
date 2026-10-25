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

/** 認証の状態（004）の既定の応答。登録済み・サインイン済み。個別のテストは同じキーで上書きできる */
export const DEFAULT_AUTH_STATUS = {
  registered: true,
  signedIn: true,
  rpId: "localhost",
  remote: { enabled: false, host: null },
  recoveryAcknowledged: true,
};

/** バックアップの状態（004）の既定の応答。設定済みで、知らせなし */
const DEFAULT_BACKUP_STATUS = {
  configured: true,
  folder: "/Users/me/backup",
  lastSuccess: null,
  lastCheck: null,
  lastRun: null,
  alert: null,
  running: false,
};

const DEFAULT_ROUTES: Record<string, Handler> = {
  "GET /api/auth/status": () => ok(DEFAULT_AUTH_STATUS),
  // 全画面の上部の知らせ（004）が読む。設定済みで、知らせなし
  "GET /api/backup/status": () => ok(DEFAULT_BACKUP_STATUS),
};

/**
 * 事業体の下の API（`/api/entities/:entityId` を除いたパス）の既定の応答。事業体の ID によらない。
 * 個別のテストが同じパスのキーを渡したときは、そちらを使う。005 の請求の設定・条件は、
 * 取引先の画面など既存の画面が読むので、既存のテストが落ちないよう空の応答を置く
 */
const DEFAULT_ENTITY_ROUTES: Record<string, Handler> = {
  "GET /invoice-settings": () => ok({ settings: null, minimumNextSeq: 1 }),
  "GET /billing-terms": () => ok({ terms: [] }),
  // 工数・請求書の一覧（US1）。仕訳の詳細は出所を読む（`:id` は 1 つのパスの区切り）
  "GET /work-hours": () => ok({ entries: [] }),
  "GET /invoices": () => ok({ invoices: [], outstandingByPartner: [] }),
  "GET /journals/:id/origin": () => ok({ origin: null }),
  // 請求書の詳細の消し込みの入力（US2）が入金先の科目・補助科目を読む
  "GET /accounts": () => ok({ accounts: [] }),
  "GET /accounts/:id/sub-accounts": () => ok({ subAccounts: [] }),
  // 定期仕訳（US3）。事業体の画面の上部の知らせが status を読む（`/recurring-journals/:id` より具体的なので先に当たる）
  "GET /recurring-journals": () => ok({ recurring: [] }),
  "GET /recurring-journals/status": () => ok({ unacknowledged: [], blocked: [] }),
  // 明細の取込（006 US1）。取込元の口座と取込の履歴は空
  "GET /statement-accounts": () => ok({ accounts: [] }),
  "GET /statements/imports": () => ok({ batches: [] }),
  // 明細の一覧・しきい値の設定（US2）。一覧は空、設定は既定の値
  "GET /statements": () => ok({ statements: [] }),
  "GET /statement-settings": () =>
    ok({
      settings: { bulkThreshold: 80, externalThreshold: 60, updatedAt: "2026-10-26T00:00:00.000Z" },
    }),
};

/** `:name` を 1 つのパスの区切りに当てはめて、事業体の下のパスの既定の応答を探す */
function defaultEntityHandler(method: string, entityPath: string): Handler | undefined {
  const exact = DEFAULT_ENTITY_ROUTES[`${method} ${entityPath}`];
  if (exact) return exact;
  for (const [key, handler] of Object.entries(DEFAULT_ENTITY_ROUTES)) {
    if (!key.includes(":")) continue;
    const pattern = new RegExp(`^${key.replace(/:[A-Za-z]+/g, "[^/]+")}$`);
    if (pattern.test(`${method} ${entityPath}`)) return handler;
  }
  return undefined;
}

/**
 * fetch を差し替え、"GET /api/..." の形のキーで応答を返す。受けた呼び出しを順に記録して返す。
 * `GET /api/auth/status` は、指定がなければ登録済み・サインイン済みの応答を返す。
 * 後片付けは vi.unstubAllGlobals() で行う
 */
export function mockApi(given: Record<string, Handler>): ApiCall[] {
  const routes = { ...DEFAULT_ROUTES, ...given };
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
      const entityPath = url.pathname.replace(/^\/api\/entities\/[^/]+/, "");
      const handler =
        routes[`${method} ${url.pathname}`] ?? defaultEntityHandler(method, entityPath);
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
