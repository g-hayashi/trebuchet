import {
  buildPrompt,
  COLUMN_TIMEOUT_DETAIL,
  type ColumnSuggestionProvider,
  domainError,
  err,
  ok,
  type ReceiptReader,
  type Result,
  type SuggestionContext,
  type SuggestionProvider,
} from "@trebuchet/domain";

// OpenAI 互換の Chat Completions で AI に推定させる（006 R10。端末内の `fm serve` と外部で同じ実装）。
// 依存は足さず fetch で呼ぶ。出力の検証はドメインの `parseSuggestion`（INV-46）。ここは生の文字列を返すだけ。
// API キーはヘッダーにだけ載せ、エラーのメッセージ・ログに出さない

/** API キーをキーチェーンに入れるときの名前（service） */
export const AI_API_KEY_SECRET = "trebuchet-ai-api-key";

/** 時間切れ（R10）: 端末内 30 秒、外部 60 秒 */
export const LOCAL_TIMEOUT_MS = 30_000;
export const EXTERNAL_TIMEOUT_MS = 60_000;

/** 呼び出し先。`apiKey` がなければ Authorization を付けない（端末内） */
export type AiEndpoint = { baseUrl: string; model: string; apiKey?: string | undefined };

export type AiProviderOptions = {
  fetch: typeof fetch;
  timeoutMs: number;
  /** 使えるか（接続先・モデル・キーがそろっているか、`fm` が使えるか） */
  available(): Promise<boolean>;
  /** 呼ぶたびに引く（設定の変更がすぐ効く）。使えなければ undefined */
  endpoint(): Promise<AiEndpoint | undefined>;
};

type Failure = { message: string; timeout?: boolean };

const unavailable = () => err(domainError("AI_NOT_CONFIGURED", "AI を使えません"));
const failed = (message: string, timeout = false) =>
  err(
    timeout
      ? domainError("VALIDATION", message, COLUMN_TIMEOUT_DETAIL)
      : domainError("VALIDATION", message),
  );

/** `response_format` の `json_schema`（受けない接続先もある。出力は必ず検証する） */
function responseFormat(context: SuggestionContext) {
  return {
    type: "json_schema",
    json_schema: {
      name: "journal_suggestion",
      strict: true,
      schema: {
        type: "object",
        properties: {
          accountCode: { type: "string" },
          taxCategory: { type: "string", enum: [...context.taxCategories] },
          purpose: { type: "string", enum: ["business", "private"] },
          confidence: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["accountCode", "taxCategory", "purpose", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  };
}

const isTimeout = (e: unknown) =>
  e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");

type Choice = { message?: { content?: unknown }; delta?: { content?: unknown } };

/** 応答の本文から `content` を取り出す。1 つの JSON（`message.content`）か、SSE（`data:` の行の `delta.content` をつなげる） */
function contentOf(text: string): unknown {
  if (!text.trimStart().startsWith("data:")) {
    return (JSON.parse(text) as { choices?: Choice[] }).choices?.[0]?.message?.content;
  }
  let joined: string | undefined;
  for (const line of text.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (data === "" || data === "[DONE]") continue;
    const piece = (JSON.parse(data) as { choices?: Choice[] }).choices?.[0]?.delta?.content;
    if (typeof piece === "string") joined = (joined ?? "") + piece;
  }
  return joined;
}

/** `content` の部品（画像つきの要求。010 の証憑の読み取りだけが使う。006・007 は文字列のまま） */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" | "low" | "auto" } };

/** Chat Completions の要求（呼び出しごとの部分）。`responseFormat` は `response_format` の値（受けない接続先には付けずに再試行する） */
export type ChatRequest = {
  messages: { role: "system" | "user"; content: string | ChatContentPart[] }[];
  responseFormat?: object | undefined;
};

/**
 * OpenAI 互換の Chat Completions を 1 回呼び、`message.content` の文字列をそのまま返す（検証は呼び出し側）。
 * `response_format` を受けない接続先（400）には、付けずに 1 回だけ再試行する。時間切れは `COLUMN_TIMEOUT_DETAIL`
 * つきの失敗（007 の列の案が `timeout` と他の失敗を見分ける）。エラーのメッセージに URL・API キー・応答の本文を出さない
 */
export async function chatCompletion(
  options: { fetch: typeof fetch; timeoutMs: number },
  endpoint: AiEndpoint,
  request: ChatRequest,
): Promise<Result<string>> {
  const post = async (
    withFormat: boolean,
  ): Promise<{ response: Response } | { error: Failure }> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (endpoint.apiKey !== undefined) headers.authorization = `Bearer ${endpoint.apiKey}`;
    const body = {
      model: endpoint.model,
      messages: request.messages,
      // stream は送らない（fm serve は stream: false に応答しない。省くと SSE で返すので読み分ける）
      temperature: 0,
      ...(withFormat && request.responseFormat !== undefined
        ? { response_format: request.responseFormat }
        : {}),
    };
    try {
      const response = await options.fetch(
        // 末尾の /v1 は付けても付けなくてもよい（画面の例は /v1 つき。fm serve は /v1 なし）
        `${endpoint.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs),
        },
      );
      return { response };
    } catch (e) {
      // 元のエラーのメッセージは出さない（URL・内部の事情が混じる）
      return isTimeout(e)
        ? { error: { message: "AI の応答が時間内に返りませんでした", timeout: true } }
        : { error: { message: "AI に接続できません" } };
    }
  };

  // instanceof Response で見分けない（@hono/node-server の serve が global.Response を置き換えるため）
  let sent = await post(true);
  // response_format を受けない接続先は 400 で断る。付けずに 1 回だけ再試行する
  if ("response" in sent && sent.response.status === 400) sent = await post(false);
  if ("error" in sent) return failed(sent.error.message, sent.error.timeout === true);
  const res = sent.response;
  if (!res.ok) return failed(`AI がエラーを返しました（HTTP ${res.status}）`);

  let content: unknown;
  try {
    content = contentOf(await res.text());
  } catch (e) {
    // fm は SSE で返すので fetch は先に解決し、時間切れは本文の読み取りの途中で来る
    return isTimeout(e)
      ? failed("AI の応答が時間内に返りませんでした", true)
      : failed("AI の応答を読めません");
  }
  if (typeof content !== "string") return failed("AI の応答に本文がありません");
  return ok(content);
}

/** OpenAI 互換の `SuggestionProvider`。`suggest` は `message.content` の文字列をそのまま返す */
export function createOpenAiProvider(options: AiProviderOptions): SuggestionProvider {
  return {
    available: options.available,
    async suggest(payload, context) {
      const endpoint = await options.endpoint();
      if (endpoint === undefined) return unavailable();
      const prompt = buildPrompt(payload, context.accounts, context.taxCategories);
      return chatCompletion(options, endpoint, {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        responseFormat: responseFormat(context),
      });
    },
  };
}

/** 証憑の読み取りの時間切れ（010/R13）: 画像は文字より遅い。外部の 60 秒より長く 90 秒 */
export const RECEIPT_READ_TIMEOUT_MS = 90_000;

export type ReceiptReaderOptions = {
  fetch: typeof fetch;
  /**
   * 外部の接続先。呼ぶたびに引く（設定の変更がすぐ効く）。外部の AI と証憑の画像の送信がともに有効で、
   * URL・モデル・API キーがそろうときだけ返す。そうでなければ undefined。端末内（`fm`）の接続先は受け取らない（FR-014）
   */
  endpoint(): Promise<AiEndpoint | undefined>;
  /** 既定は `RECEIPT_READ_TIMEOUT_MS`（テストが短くする） */
  timeoutMs?: number | undefined;
};

/**
 * 外部の endpoint だけを呼ぶ `ReceiptReader`（010/R13、INV-66 の例外を閉じ込める 1 か所）。
 * 006 の `createOpenAiProvider`・`buildAiPayload` は通らない。`read` は例外を投げず `Result` で返し、
 * 時間切れは `COLUMN_TIMEOUT_DETAIL` つきの失敗（domain の `readReceipt` が `timeout`・`AI_TIMEOUT` にする）
 */
export function createReceiptReader(options: ReceiptReaderOptions): ReceiptReader {
  return {
    async model() {
      return (await options.endpoint())?.model;
    },
    async read(request) {
      const endpoint = await options.endpoint();
      if (endpoint === undefined) return unavailable();
      const base64 = Buffer.from(request.image.bytes).toString("base64");
      return chatCompletion(
        { fetch: options.fetch, timeoutMs: options.timeoutMs ?? RECEIPT_READ_TIMEOUT_MS },
        endpoint,
        {
          messages: [
            { role: "system", content: request.system },
            {
              role: "user",
              content: [
                { type: "text", text: request.choices },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${request.image.mediaType};base64,${base64}`,
                    detail: "high",
                  },
                },
              ],
            },
          ],
          responseFormat: {
            type: "json_schema",
            json_schema: { name: "receipt_reading", strict: true, schema: request.schema },
          },
        },
      );
    },
  };
}

/** 列の案の時間切れ（007/R10）: 端末内 20 秒 */
export const COLUMN_TIMEOUT_MS = 20_000;

export type ColumnProviderOptions = {
  fetch: typeof fetch;
  /** 端末内の AI が使えるか（設定で有効、かつ `fm` が使える） */
  available(): Promise<boolean>;
  /**
   * 端末内の接続先（`fm serve`）。呼ぶたびに引く。使えなければ undefined。
   * 外部の接続先・API キーを受け取る引数は持たない（FR-018）。API キーは付けない
   */
  localEndpoint(): Promise<{ baseUrl: string; model: string } | undefined>;
};

/** 端末内の AI だけを呼ぶ `ColumnSuggestionProvider`（007/R10）。`suggestColumns` は `message.content` の文字列を返す */
export function createColumnProvider(options: ColumnProviderOptions): ColumnSuggestionProvider {
  return {
    available: options.available,
    async suggestColumns(prompt) {
      const local = await options.localEndpoint();
      if (local === undefined) return unavailable();
      return chatCompletion(
        { fetch: options.fetch, timeoutMs: COLUMN_TIMEOUT_MS },
        { baseUrl: local.baseUrl, model: local.model },
        {
          messages: prompt.messages,
          responseFormat: {
            type: "json_schema",
            json_schema: { name: "column_suggestion", strict: true, schema: prompt.schema },
          },
        },
      );
    },
  };
}
