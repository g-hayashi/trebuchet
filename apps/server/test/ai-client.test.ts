import {
  COLUMN_TIMEOUT_DETAIL,
  type ColumnPrompt,
  type ReceiptReadingRequest,
  type SuggestionContext,
  type SuggestionPayload,
} from "@trebuchet/domain";
import { describe, expect, it, vi } from "vitest";
import {
  AI_API_KEY_SECRET,
  type AiEndpoint,
  COLUMN_TIMEOUT_MS,
  chatCompletion,
  createColumnProvider,
  createOpenAiProvider,
  createReceiptReader,
  EXTERNAL_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
  RECEIPT_READ_TIMEOUT_MS,
} from "../src/lib/ai-client.ts";

// 006 R10: OpenAI 互換の Chat Completions を fetch で呼ぶ。実際のネットワークには出ない（偽の fetch）

const PAYLOAD: SuggestionPayload = {
  date: "2026-05-10",
  amount: 1200,
  direction: "out",
  content: "ショップ####",
  categoryMajor: "日用品",
  categoryMinor: null,
  accountKind: "bank",
  accountUsage: "business",
};

const CONTEXT: SuggestionContext = {
  accounts: [
    { code: "5100", name: "消耗品費" },
    { code: "5200", name: "旅費交通費" },
  ],
  taxCategories: ["taxable_10", "exempt"],
};

const SUGGESTION_TEXT = JSON.stringify({
  accountCode: "5100",
  taxCategory: "taxable_10",
  purpose: "business",
  confidence: 80,
  reason: "文房具の購入",
});

const completion = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** 呼び出しを記録し、応答を順に返す偽の fetch */
function fakeFetch(
  ...responses: (Response | Error | ((init: RequestInit) => Promise<Response>))[]
) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({
      url: String(input),
      init: i,
      body: JSON.parse(String(i.body ?? "{}")) as Record<string, unknown>,
    });
    const next = queue.shift() ?? new Response("", { status: 500 });
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(i);
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const provider = (
  f: typeof fetch,
  endpoint: AiEndpoint | null = {
    baseUrl: "https://api.example.com",
    model: "model-a",
    apiKey: "sk-secret-123",
  },
  timeoutMs = 1000,
) =>
  createOpenAiProvider({
    fetch: f,
    timeoutMs,
    available: async () => endpoint !== null,
    endpoint: async () => endpoint ?? undefined,
  });

describe("chatCompletion: 接続先の URL", () => {
  it.each(["https://api.example.com/openai/v1", "https://api.example.com/openai/v1/"])(
    "末尾が /v1 の URL（%s）には /v1 を重ねない",
    async (baseUrl) => {
      const { fn, calls } = fakeFetch(completion(SUGGESTION_TEXT));
      await provider(fn, { baseUrl, model: "model-a", apiKey: "sk-secret-123" }).suggest(
        PAYLOAD,
        CONTEXT,
      );
      expect(calls[0]?.url).toBe("https://api.example.com/openai/v1/chat/completions");
    },
  );
});

describe("createOpenAiProvider: 要求", () => {
  it("POST {baseUrl}/v1/chat/completions に、model・system と user のメッセージ・response_format を送る。API キーは Authorization だけ", async () => {
    const { fn, calls } = fakeFetch(completion(SUGGESTION_TEXT));
    const result = await provider(fn, {
      baseUrl: "https://api.example.com/",
      model: "model-a",
      apiKey: "sk-secret-123",
    }).suggest(PAYLOAD, CONTEXT);

    expect(result).toEqual({ ok: true, value: SUGGESTION_TEXT });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://api.example.com/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-secret-123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(call.body.model).toBe("model-a");
    const messages = call.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0]?.content).toContain("5100 消耗品費");
    expect(messages[1]?.content).toBe(JSON.stringify(PAYLOAD));
    expect((call.body.response_format as { type: string }).type).toBe("json_schema");
    // fm serve は stream: false を送ると応答しない。stream は送らない（SSE で返れば読む）
    expect(call.body).not.toHaveProperty("stream");
    // API キーは本文に入らない
    expect(JSON.stringify(call.body)).not.toContain("sk-secret-123");
  });

  it("API キーがない接続先（端末内）には Authorization を付けない", async () => {
    const { fn, calls } = fakeFetch(completion(SUGGESTION_TEXT));
    await provider(fn, { baseUrl: "http://127.0.0.1:18790", model: "system" }).suggest(
      PAYLOAD,
      CONTEXT,
    );
    expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false);
  });

  it("時間切れの既定は端末内 30 秒・外部 60 秒", () => {
    expect(LOCAL_TIMEOUT_MS).toBe(30_000);
    expect(EXTERNAL_TIMEOUT_MS).toBe(60_000);
    expect(AI_API_KEY_SECRET).toBe("trebuchet-ai-api-key");
  });
});

describe("createOpenAiProvider: 応答", () => {
  it("message.content の文字列を、検証せずそのまま返す（検証はドメインの parseSuggestion）", async () => {
    const { fn } = fakeFetch(completion("```json\n{bad}\n```"));
    expect(await provider(fn).suggest(PAYLOAD, CONTEXT)).toEqual({
      ok: true,
      value: "```json\n{bad}\n```",
    });
  });

  it("グローバルの Response が置き換えられていても（@hono/node-server の serve）、fetch の応答を読める", async () => {
    // serve は global.Response を独自のクラスに置き換えるため、fetch の応答は instanceof Response にならない
    const foreign = (res: Response) =>
      ({
        ok: res.ok,
        status: res.status,
        json: () => res.json(),
        text: () => res.text(),
      }) as unknown as Response;
    const { fn, calls } = fakeFetch(
      foreign(new Response("", { status: 400 })),
      foreign(completion(SUGGESTION_TEXT)),
    );
    const result = await provider(fn).suggest(PAYLOAD, CONTEXT);
    expect(result).toEqual({ ok: true, value: SUGGESTION_TEXT });
    expect(calls).toHaveLength(2);
  });

  it("ストリーミング（SSE）の応答は、delta.content をつなげて返す（fm serve は stream を省くと SSE で返す）", async () => {
    const chunk = (delta: Record<string, unknown>) =>
      `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta }] })}\n\n`;
    const half = Math.floor(SUGGESTION_TEXT.length / 2);
    const sse = [
      chunk({ role: "assistant" }),
      chunk({ content: SUGGESTION_TEXT.slice(0, half) }),
      chunk({ content: SUGGESTION_TEXT.slice(half) }),
      chunk({}),
      "data: [DONE]\n\n",
    ].join("");
    const { fn } = fakeFetch(
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const result = await provider(fn).suggest(PAYLOAD, CONTEXT);
    expect(result).toEqual({ ok: true, value: SUGGESTION_TEXT });
  });

  it("response_format を受けない接続先（400）には、response_format なしで 1 回だけ再試行する", async () => {
    const { fn, calls } = fakeFetch(
      new Response('{"error":"unsupported response_format"}', { status: 400 }),
      completion(SUGGESTION_TEXT),
    );
    const result = await provider(fn).suggest(PAYLOAD, CONTEXT);
    expect(result).toEqual({ ok: true, value: SUGGESTION_TEXT });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.response_format).toBeDefined();
    expect(calls[1]?.body.response_format).toBeUndefined();
  });

  it("再試行でも失敗、または 400 以外の失敗は err。メッセージに API キーも応答の本文も含めない", async () => {
    const { fn, calls } = fakeFetch(
      new Response("sk-secret-123 echoed by the server", { status: 401 }),
    );
    const result = await provider(fn).suggest(PAYLOAD, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(calls).toHaveLength(1);
    expect(result.error.message).toContain("401");
    expect(JSON.stringify(result.error)).not.toContain("sk-secret-123");
    expect(JSON.stringify(result.error)).not.toContain("echoed");
  });

  it("content が文字列でない・choices がない・JSON でない応答は err", async () => {
    for (const response of [
      completion(null),
      completion({ not: "a string" }),
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      new Response("<html>", { status: 200 }),
    ]) {
      const { fn } = fakeFetch(response);
      const result = await provider(fn).suggest(PAYLOAD, CONTEXT);
      expect(result.ok).toBe(false);
    }
  });

  it("接続エラーは err。元のエラーのメッセージ（URL や内部の事情）は出さない", async () => {
    const { fn } = fakeFetch(new TypeError("fetch failed: connect ECONNREFUSED sk-secret-123"));
    const result = await provider(fn).suggest(PAYLOAD, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(result.error)).not.toContain("sk-secret-123");
  });

  it("時間切れ（AbortSignal）は err になり、再試行しない", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const { fn, calls } = fakeFetch(hang, hang);
    const result = await provider(fn, undefined, 20).suggest(PAYLOAD, CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("時間");
    expect(calls).toHaveLength(1);
  });
});

describe("createOpenAiProvider: 使えるか", () => {
  it("available は渡された判定に従い、使えないときの suggest は fetch せず AI_NOT_CONFIGURED", async () => {
    const { fn, calls } = fakeFetch();
    const p = provider(fn, null);
    expect(await p.available()).toBe(false);
    const result = await p.suggest(PAYLOAD, CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AI_NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
  });
});

// 007/R10: 列の対応の案。端末内の endpoint だけを受け取る（外部の endpoint・API キーを受け取る引数がない。FR-018）

const COLUMN_PROMPT: ColumnPrompt = {
  messages: [
    { role: "system", content: "列の役割を答えてください" },
    { role: "user", content: '{"columnCount":3}' },
  ],
  schema: { type: "object", properties: {}, additionalProperties: false },
};

const columnProvider = (
  f: typeof fetch,
  localEndpoint: () => Promise<{ baseUrl: string; model: string } | undefined> = async () => ({
    baseUrl: "http://127.0.0.1:18790",
    model: "system",
  }),
) => createColumnProvider({ fetch: f, available: async () => true, localEndpoint });

describe("createColumnProvider", () => {
  it("20 秒の時間切れ。端末内の URL に、prompt の messages と schema（response_format）を API キーなしで送る", async () => {
    expect(COLUMN_TIMEOUT_MS).toBe(20_000);
    const { fn, calls } = fakeFetch(completion('{"ok":true}'));
    const result = await columnProvider(fn).suggestColumns(COLUMN_PROMPT);
    expect(result).toEqual({ ok: true, value: '{"ok":true}' });
    const call = calls[0] as Call;
    expect(call.url).toBe("http://127.0.0.1:18790/v1/chat/completions");
    expect(new Headers(call.init.headers).has("authorization")).toBe(false);
    expect(call.body.model).toBe("system");
    expect(call.body.messages).toEqual(COLUMN_PROMPT.messages);
    expect(call.body).not.toHaveProperty("stream");
    expect(call.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { schema: COLUMN_PROMPT.schema },
    });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("response_format を受けない接続先（400）には付けずに 1 回だけ再試行する", async () => {
    const { fn, calls } = fakeFetch(new Response("", { status: 400 }), completion("{}"));
    const result = await columnProvider(fn).suggestColumns(COLUMN_PROMPT);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.response_format).toBeUndefined();
  });

  it("時間切れは COLUMN_TIMEOUT_DETAIL つきの err。ほかの失敗には付かない", async () => {
    const timeout = fakeFetch(new DOMException("timed out", "TimeoutError"));
    const t = await columnProvider(timeout.fn).suggestColumns(COLUMN_PROMPT);
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error.details).toEqual(COLUMN_TIMEOUT_DETAIL);

    const refused = fakeFetch(new TypeError("fetch failed"));
    const r = await columnProvider(refused.fn).suggestColumns(COLUMN_PROMPT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.timeout).toBeUndefined();
  });

  it("本文の読み取り（fm は SSE で返すので fetch は先に解決する）の途中の時間切れも、timeout として返す", async () => {
    const slowBody = (name: string) => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new DOMException("timed out", name);
      },
    });
    for (const name of ["TimeoutError", "AbortError"]) {
      const { fn } = fakeFetch(async () => slowBody(name) as unknown as Response);
      const t = await columnProvider(fn).suggestColumns(COLUMN_PROMPT);
      expect(t.ok).toBe(false);
      if (!t.ok) {
        expect(t.error.details).toEqual(COLUMN_TIMEOUT_DETAIL);
        expect(t.error.message).toContain("時間内");
      }
    }
    // 時間切れ以外の読み取りの失敗は、timeout にしない
    const broken = {
      ok: true,
      status: 200,
      text: async () => {
        throw new TypeError("terminated");
      },
    };
    const { fn } = fakeFetch(async () => broken as unknown as Response);
    const r = await columnProvider(fn).suggestColumns(COLUMN_PROMPT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.timeout).toBeUndefined();
  });

  it("endpoint がなければ fetch せず AI_NOT_CONFIGURED", async () => {
    const { fn, calls } = fakeFetch();
    const result = await columnProvider(fn, async () => undefined).suggestColumns(COLUMN_PROMPT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AI_NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
  });
});

describe("chatCompletion", () => {
  it("本文（JSON か SSE）の content を返す", async () => {
    const { fn } = fakeFetch(completion("hello"));
    const result = await chatCompletion(
      { fetch: fn, timeoutMs: 1000 },
      { baseUrl: "https://api.example.com", model: "m", apiKey: "k" },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(result).toEqual({ ok: true, value: "hello" });
  });
});

describe("createReceiptReader（010 R13。外部の endpoint だけ）", () => {
  const REQUEST: ReceiptReadingRequest = {
    system: "指示文",
    choices: "勘定科目（コード 名前）:\n5100 消耗品費",
    image: { mediaType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    schema: { type: "object", properties: {} },
  };
  const ENDPOINT: AiEndpoint = {
    baseUrl: "https://api.example.com",
    model: "model-a",
    apiKey: "sk-secret-123",
  };
  const reader = (f: typeof fetch, endpoint: AiEndpoint | null = ENDPOINT, timeoutMs?: number) =>
    createReceiptReader({
      fetch: f,
      endpoint: async () => endpoint ?? undefined,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

  it("時間切れは 90 秒（外部の 60 秒より長い）", () => {
    expect(RECEIPT_READ_TIMEOUT_MS).toBe(90_000);
  });

  it("model() は endpoint のモデル名。endpoint がなければ undefined", async () => {
    const { fn } = fakeFetch();
    expect(await reader(fn).model()).toBe("model-a");
    expect(await reader(fn, null).model()).toBeUndefined();
  });

  it("system は文字列、user は text と image_url（data URL、detail: high）の配列。response_format は json_schema（strict）", async () => {
    const { fn, calls } = fakeFetch(completion("{}"));
    const result = await reader(fn).read(REQUEST);
    expect(result).toEqual({ ok: true, value: "{}" });
    const call = calls[0] as Call;
    expect(call.url).toBe("https://api.example.com/v1/chat/completions");
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer sk-secret-123");
    const messages = call.body.messages as { role: string; content: unknown }[];
    expect(messages[0]).toEqual({ role: "system", content: "指示文" });
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toEqual([
      { type: "text", text: REQUEST.choices },
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,/9j/2Q==", detail: "high" },
      },
    ]);
    expect(call.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true, schema: REQUEST.schema },
    });
    expect(JSON.stringify(call.body)).not.toContain("sk-secret-123");
  });

  it("時間切れは COLUMN_TIMEOUT_DETAIL つきの err（例外を投げない）。ほかの失敗には付かない", async () => {
    const timeout = fakeFetch(new DOMException("timed out", "TimeoutError"));
    const t = await reader(timeout.fn).read(REQUEST);
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error.details).toEqual(COLUMN_TIMEOUT_DETAIL);

    const refused = fakeFetch(new TypeError("fetch failed"));
    const r = await reader(refused.fn).read(REQUEST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.timeout).toBeUndefined();
  });

  it("endpoint がなければ fetch せず AI_NOT_CONFIGURED", async () => {
    const { fn, calls } = fakeFetch();
    const result = await reader(fn, null).read(REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AI_NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
  });
});
