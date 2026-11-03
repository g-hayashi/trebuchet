import type { ErrorCode } from "@trebuchet/schema";
import { vi } from "vitest";
import { receiptDetail, receiptReading } from "./receipts-fixtures";

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

/** 認証の状態（004・008）の既定の応答。設定済み・解錠済み。個別のテストは同じキーで上書きできる */
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

/** AI の設定（006 US5）の既定の応答。端末内の AI が使えて、外部は使わない */
const DEFAULT_AI_SETTINGS = {
  localEnabled: true,
  localAvailable: true,
  externalEnabled: false,
  externalBaseUrl: null,
  externalModel: null,
  receiptImagesEnabled: false,
  apiKeySet: false,
};

const DEFAULT_ROUTES: Record<string, Handler> = {
  "GET /api/auth/status": () => ok(DEFAULT_AUTH_STATUS),
  // 再認証（008）。パスキーの追加・削除と回復キーの再発行の前に、画面が呼ぶ。成功する
  "POST /api/auth/reauth/options": () => ok({ challenge: "reauth" }),
  "POST /api/auth/reauth/verify": () => ({ status: 204, body: undefined }),
  // 全画面の上部の知らせ（004）が読む。設定済みで、知らせなし
  "GET /api/backup/status": () => ok(DEFAULT_BACKUP_STATUS),
  // リモート（004 US4）。無効・名前なし
  "GET /api/settings/remote": () => ok({ enabled: false, host: null }),
  // tailscale の CLI の状態（004 US4）。未インストール
  "GET /api/settings/remote/tailscale": () =>
    ok({ installed: false, running: false, dnsName: null, serving: false }),
  // ペアリングの案内が数える、パスキーの一覧
  "GET /api/auth/passkeys": () => ok({ passkeys: [] }),
  // AI の設定（006 US5）。端末内だけを使い、外部は未設定
  "GET /api/settings/ai": () => ok(DEFAULT_AI_SETTINGS),
};

/**
 * 事業体の下の API（`/api/entities/:entityId` を除いたパス）の既定の応答。事業体の ID によらない。
 * 個別のテストが同じパスのキーを渡したときは、そちらを使う。005 の請求の設定・条件は、
 * 取引先の画面など既存の画面が読むので、既存のテストが落ちないよう空の応答を置く
 */
const DEFAULT_ENTITY_ROUTES: Record<string, Handler> = {
  "GET /journal-draft": () => ok({ draft: null, updatedAt: null }),
  "PUT /journal-draft": () => ok({ updatedAt: "2026-10-31T01:00:00.000Z" }),
  "DELETE /journal-draft": () => ok(undefined, 204),
  "GET /journals/suggestions": () => ok({ suggestions: [] }),
  "GET /fiscal-periods": () => ok({ fiscalPeriods: [] }),
  // ホーム（011 US1）。作業は 0 件、今日を含む会計期間なし、仕訳・取込なし
  "GET /home": () =>
    ok({
      tasks: {
        status: "ok",
        value: {
          unprocessedStatements: 0,
          unlinkedReceipts: 0,
          unpaidInvoices: 0,
          overdueInvoices: 0,
          blockedRecurring: 0,
          blueReturnWarnings: 0,
        },
      },
      figures: { status: "ok", value: null },
      recentJournals: { status: "ok", value: [] },
      lastStatementImportAt: { status: "ok", value: null },
    }),
  "GET /invoice-settings": () => ok({ settings: null, minimumNextSeq: 1 }),
  "GET /billing-terms": () => ok({ terms: [] }),
  // 工数・請求書の一覧（US1）。仕訳の詳細は出所を読む（`:id` は 1 つのパスの区切り）
  "GET /work-hours": () => ok({ entries: [] }),
  "GET /invoices": () => ok({ invoices: [], outstandingByPartner: [] }),
  "POST /invoices/calculate": ({ body }) => {
    const input = body as {
      priceMode: string;
      items: { amount: number; taxRate: number | null }[];
    };
    const subtotal = input.items.reduce((sum, item) => sum + item.amount, 0);
    return ok({ subtotal, total: subtotal, taxBreakdown: [] });
  },
  "GET /journals/:id/origin": () => ok({ origin: null }),
  // 請求書の詳細の消し込みの入力（US2）が入金先の科目・補助科目を読む
  "GET /accounts": () => ok({ accounts: [] }),
  "GET /accounts/:id/sub-accounts": () => ok({ subAccounts: [] }),
  // 定期仕訳（US3）。事業体の画面の上部の知らせが status を読む（`/recurring-journals/:id` より具体的なので先に当たる）
  "GET /recurring-journals": () => ok({ recurring: [] }),
  "GET /recurring-journals/status": () => ok({ unacknowledged: [], blocked: [] }),
  // 固定資産台帳の画面（009 US3）が開業費の一覧を読む。開業費はまだない
  "GET /deferred-assets": () => ok({ deferredAssets: [] }),
  // 明細の取込（006 US1）。取込元の口座と取込の履歴は空
  "GET /statement-accounts": () => ok({ accounts: [] }),
  "GET /statements/imports": () => ok({ batches: [] }),
  // 明細の取込（007 US1）の表の判定。日付・内容・金額のタブ区切りで、年のない日付
  "POST /statements/imports/layout": () =>
    ok({
      encoding: "utf-8",
      delimiter: "\t",
      headerRow: 0,
      header: ["日付", "内容", "金額（円）"],
      columnCount: 3,
      rowCount: 1,
      sampleRows: [["05/10(日)", "ショップ001", "-1,200"]],
      needsYear: true,
      suggestedColumns: { date: 0, content: 1, amount: 2 },
      match: { kind: "none" },
    }),
  // 列の対応の案（007 US4。端末内の AI）。案なし（理由もなし）
  "POST /statements/imports/column-suggestion": () => ok({ suggestion: null }),
  // 取込元（007 US2。列の対応の保存）。保存したものはまだない
  "GET /statement-sources": () => ok({ sources: [] }),
  // ジョブ（評価）の状態は完了
  // 明細の一覧・しきい値の設定（US2）。一覧は空、設定は既定の値
  "GET /statements": () => ok({ statements: [] }),
  // 推定のルール（US3）。一覧は空
  "GET /inference-rules": () => ok({ rules: [] }),
  // 評価の履歴（US5）。実行はまだない
  // 証憑（010 US1）。一覧は空。詳細は電子取引の 1 件で、PATCH は送られた値を当てて version を進める
  "GET /receipts": () => ok({ receipts: [], nextCursor: null }),
  "GET /receipts/:receiptId": () => ok({ receipt: receiptDetail() }),
  // 仕訳に結びつける候補（010 US3）。候補なし。仕訳の一覧・詳細の既定の応答は各テストが持つので、
  // 証憑の項目（一覧の `receiptCount`、詳細の `receipts`）は画面が省略を 0・空として扱う
  "GET /receipts/:receiptId/journal-candidates": () => ok({ candidates: [] }),
  // 証憑の履歴（010 US5）。追加の 1 件だけ
  "GET /receipts/:receiptId/history": () =>
    ok({
      history: [
        {
          occurredAt: "2026-10-20T09:00:00.000Z",
          targetType: "receipt",
          action: "create",
          reason: null,
          before: null,
          after: null,
        },
      ],
    }),
  // 外部の AI の読み取り（010 US4）。設定が無効なら画面は呼ばない。呼ばれたら候補なしの成功を返す
  "POST /receipts/:receiptId/readings": () => ok({ reading: receiptReading() }, 201),
  "PATCH /receipts/:receiptId": ({ body }) => {
    const { version, ...values } = body as { version: number } & Record<string, unknown>;
    return ok({ receipt: { ...receiptDetail(), ...values, version: version + 1 } });
  },
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
 * `GET /api/auth/status` は、指定がなければ設定済み・解錠済みの応答を返す。
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
