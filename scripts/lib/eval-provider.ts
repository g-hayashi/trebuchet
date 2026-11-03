import type { SuggestionProvider } from "../../packages/domain/src/ports.ts";

type Route = "local" | "external";
type FailureKind =
  | "http"
  | "timeout"
  | "connection"
  | "response_read"
  | "response_empty"
  | "unavailable"
  | "provider"
  | "exception";

/** CLIだけの安全な診断。元の例外・本文・URL・キーは保持しない。 */
export class EvalProviderError extends Error {
  readonly route: Route;
  readonly kind: FailureKind;
  readonly status: number | undefined;

  constructor(route: Route, kind: FailureKind, status?: number) {
    super(`AI評価失敗: ${route} ${kind}${status === undefined ? "" : ` HTTP ${status}`}`);
    this.route = route;
    this.kind = kind;
    this.status = status;
  }
}

/** 本番providerが作る固定文だけを照合し、任意の失敗本文を出力しない。 */
function failure(route: Route, message: string): EvalProviderError {
  const http = /^AI がエラーを返しました（HTTP ([1-5]\d{2})）$/u.exec(message);
  if (http !== null) return new EvalProviderError(route, "http", Number(http[1]));
  const kinds: Readonly<Record<string, FailureKind>> = {
    "AI の応答が時間内に返りませんでした": "timeout",
    "AI に接続できません": "connection",
    "AI の応答を読めません": "response_read",
    "AI の応答に本文がありません": "response_empty",
    "AI を使えません": "unavailable",
  };
  return new EvalProviderError(
    route,
    Object.hasOwn(kinds, message) ? (kinds[message] as FailureKind) : "provider",
  );
}

/** 通信・利用不可は即停止。成功時の出力の検証は本番のparseSuggestionに任せる。 */
export function createEvalProviderGuard(
  progress: (phase: "started" | "completed", count: number) => void,
): (provider: SuggestionProvider, route: Route) => SuggestionProvider {
  let started = 0;
  let completed = 0;
  return (provider, route) => ({
    async available() {
      let ready: boolean;
      try {
        ready = await provider.available();
      } catch {
        throw new EvalProviderError(route, "exception");
      }
      if (!ready) throw new EvalProviderError(route, "unavailable");
      return true;
    },
    async suggest(payload, context) {
      progress("started", ++started);
      let result: Awaited<ReturnType<SuggestionProvider["suggest"]>>;
      try {
        result = await provider.suggest(payload, context);
      } catch {
        throw new EvalProviderError(route, "exception");
      }
      if (!result.ok) throw failure(route, result.error.message);
      progress("completed", ++completed);
      return result;
    },
  });
}
