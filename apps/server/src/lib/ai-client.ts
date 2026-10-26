import {
  buildPrompt,
  domainError,
  err,
  ok,
  type SuggestionContext,
  type SuggestionPayload,
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

const unavailable = () => err(domainError("AI_NOT_CONFIGURED", "AI を使えません"));
const failed = (message: string) => err(domainError("VALIDATION", message));

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

/** OpenAI 互換の `SuggestionProvider`。`suggest` は `message.content` の文字列をそのまま返す */
export function createOpenAiProvider(options: AiProviderOptions): SuggestionProvider {
  const post = async (
    endpoint: AiEndpoint,
    payload: SuggestionPayload,
    context: SuggestionContext,
    withFormat: boolean,
  ): Promise<{ response: Response } | { error: string }> => {
    const prompt = buildPrompt(payload, context.accounts, context.taxCategories);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (endpoint.apiKey !== undefined) headers.authorization = `Bearer ${endpoint.apiKey}`;
    const body = {
      model: endpoint.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0,
      stream: false,
      ...(withFormat ? { response_format: responseFormat(context) } : {}),
    };
    try {
      const response = await options.fetch(
        `${endpoint.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`,
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
      return {
        error: isTimeout(e) ? "AI の応答が時間内に返りませんでした" : "AI に接続できません",
      };
    }
  };

  return {
    available: options.available,
    async suggest(payload, context) {
      const endpoint = await options.endpoint();
      if (endpoint === undefined) return unavailable();

      // instanceof Response で見分けない（@hono/node-server の serve が global.Response を置き換えるため）
      let sent = await post(endpoint, payload, context, true);
      // response_format を受けない接続先は 400 で断る。付けずに 1 回だけ再試行する
      if ("response" in sent && sent.response.status === 400) {
        sent = await post(endpoint, payload, context, false);
      }
      if ("error" in sent) return failed(sent.error);
      const res = sent.response;
      if (!res.ok) return failed(`AI がエラーを返しました（HTTP ${res.status}）`);

      let content: unknown;
      try {
        const json = (await res.json()) as {
          choices?: { message?: { content?: unknown } }[];
        };
        content = json.choices?.[0]?.message?.content;
      } catch {
        return failed("AI の応答を読めません");
      }
      if (typeof content !== "string") return failed("AI の応答に本文がありません");
      return ok(content);
    },
  };
}
