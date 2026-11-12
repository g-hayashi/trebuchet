import { queryOptions } from "@tanstack/react-query";
import type { AiSettingsInput } from "@trebuchet/schema";
import { api, unwrap } from "@/lib/api";

// AI の接続の設定の API（006 contracts/http-api.md §7。端末の設定なので事業体によらない）

const settings = api.api.settings.ai;

export const aiSettingsKeys = {
  all: ["settings", "ai"] as const,
};

/** 応答に API キーそのものは含まれない（`apiKeySet` だけ） */
export const aiSettingsQuery = () =>
  queryOptions({
    queryKey: aiSettingsKeys.all,
    queryFn: async () => unwrap(await settings.$get()),
  });

/** 保存する（006 §7.2）。`apiKey` は省略で変えない、空文字で削除 */
export const putAiSettings = async (json: AiSettingsInput) => unwrap(await settings.$put({ json }));
