import type { AiSettingsRecord } from "@trebuchet/db";
import type { SecretStore, SuggestionProvider } from "@trebuchet/domain";
import {
  AI_API_KEY_SECRET,
  createOpenAiProvider,
  EXTERNAL_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
} from "./ai-client.ts";
import type { FmServer } from "./fm-server.ts";

/** 端末内の AI（`fm serve`）のモデル名。候補の `model` にも記録する */
export const LOCAL_AI_MODEL = "fm";

/** AI の接続の設定の置き場（registry の `ai_settings`。テストは差し替える） */
export type AiSettingsStore = {
  get(): AiSettingsRecord;
  save(settings: AiSettingsRecord, at: string): void;
};

export type AiRuntimeOptions = {
  fetch: typeof fetch;
  secrets: SecretStore;
  settings: () => AiSettingsStore;
  fm: FmServer;
};

/** AI の設定・キーチェーン・`fm` と、そこから作る端末内・外部の SuggestionProvider（006 R10・R12） */
export type AiRuntime = {
  settings: () => AiSettingsStore;
  secrets: SecretStore;
  fm: FmServer;
  providers: { local: SuggestionProvider; external: SuggestionProvider };
};

/** API キーを引く。キーチェーンの失敗は「ない」と同じに扱う（理由は出さない） */
export async function readApiKey(secrets: SecretStore): Promise<string | undefined> {
  try {
    const key = await secrets.get(AI_API_KEY_SECRET);
    return key === undefined || key === "" ? undefined : key;
  } catch {
    return undefined;
  }
}

/**
 * 端末内・外部の SuggestionProvider を作る。設定とキーは呼ぶたびに読む（PUT がすぐ効く）。
 * 端末内: 設定で有効、かつ `fm available`。`fm serve` は最初の推定で起動する。
 * 外部: 設定で有効、かつ接続先・モデル・API キーがそろっている
 */
export function createAiRuntime(options: AiRuntimeOptions): AiRuntime {
  const external = createOpenAiProvider({
    fetch: options.fetch,
    timeoutMs: EXTERNAL_TIMEOUT_MS,
    available: async () => (await externalEndpoint()) !== undefined,
    endpoint: () => externalEndpoint(),
  });

  async function externalEndpoint() {
    const s = options.settings().get();
    if (!s.externalEnabled || s.externalBaseUrl === null || s.externalModel === null) {
      return undefined;
    }
    const apiKey = await readApiKey(options.secrets);
    if (apiKey === undefined) return undefined;
    return { baseUrl: s.externalBaseUrl, model: s.externalModel, apiKey };
  }

  const local = createOpenAiProvider({
    fetch: options.fetch,
    timeoutMs: LOCAL_TIMEOUT_MS,
    available: async () => options.settings().get().localEnabled && (await options.fm.available()),
    endpoint: async () => {
      if (!options.settings().get().localEnabled) return undefined;
      const baseUrl = await options.fm.ensureStarted();
      return baseUrl === undefined ? undefined : { baseUrl, model: LOCAL_AI_MODEL };
    },
  });

  return {
    settings: options.settings,
    secrets: options.secrets,
    fm: options.fm,
    providers: { local, external },
  };
}
