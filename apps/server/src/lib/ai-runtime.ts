import type { AiSettingsRecord } from "@trebuchet/db";
import type {
  ColumnSuggestionProvider,
  ReceiptReader,
  SecretStore,
  SuggestionProvider,
} from "@trebuchet/domain";
import {
  AI_API_KEY_SECRET,
  createColumnProvider,
  createOpenAiProvider,
  createReceiptReader,
  EXTERNAL_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
} from "./ai-client.ts";
import type { FmServer } from "./fm-server.ts";

/** 端末内の AI（`fm serve`）のモデル名。候補の `model` にも記録する */
export const LOCAL_AI_MODEL = "system";

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
  /** 列の対応の案（007）。端末内の AI だけ。設定で無効なら route が使わない */
  columns: ColumnSuggestionProvider;
  /** 証憑の画像の読み取り（010）。外部の endpoint だけ。設定が無効なら `model()` が undefined */
  receipts: ReceiptReader;
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
 * 端末内: 設定で有効、かつ `fm models` に `✓ system` がある。`fm serve` は最初の推定で起動する。
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

  // 証憑の読み取り（010 R13）: 外部の AI と証憑の画像の送信がともに有効で、URL・モデル・キーがそろうときだけ。
  // 無効なら endpoint が undefined になり、`model()` も undefined（domain の `readReceipt` が AI_NOT_CONFIGURED にする）
  const receipts = createReceiptReader({
    fetch: options.fetch,
    endpoint: async () =>
      options.settings().get().receiptImagesEnabled ? externalEndpoint() : undefined,
  });

  const localAvailable = async () =>
    options.settings().get().localEnabled && (await options.fm.available());
  const localEndpoint = async () => {
    if (!options.settings().get().localEnabled) return undefined;
    const baseUrl = await options.fm.ensureStarted();
    return baseUrl === undefined ? undefined : { baseUrl, model: LOCAL_AI_MODEL };
  };

  const local = createOpenAiProvider({
    fetch: options.fetch,
    timeoutMs: LOCAL_TIMEOUT_MS,
    available: localAvailable,
    endpoint: localEndpoint,
  });
  // 列の案は端末内の endpoint だけを渡す（外部の接続先・API キーは渡さない。007 FR-018）
  const columns = createColumnProvider({
    fetch: options.fetch,
    available: localAvailable,
    localEndpoint,
  });

  return {
    settings: options.settings,
    secrets: options.secrets,
    fm: options.fm,
    providers: { local, external },
    columns,
    receipts,
  };
}
