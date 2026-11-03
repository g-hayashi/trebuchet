import { domainError } from "@trebuchet/domain";
import { AiSettingsInput } from "@trebuchet/schema";
import { Hono } from "hono";
import type { RouteOptions } from "../deps.ts";
import { fail } from "../errors.ts";
import { AI_API_KEY_SECRET } from "../lib/ai-client.ts";
import { type AiRuntime, readApiKey } from "../lib/ai-runtime.ts";
import { validate } from "../validator.ts";

/**
 * `/api/settings` の下の AI の接続の設定（006。contracts/http-api.md §7。端末の設定）。
 * API キーはキーチェーンにだけ置き、応答・DB・ログに出さない（`apiKeySet` だけ返す）
 */
export function aiSettingsRoutes({ clock, ai }: RouteOptions & { ai: AiRuntime }) {
  /** §7.1 の形（API キーそのものは持たない） */
  const view = async () => {
    const s = ai.settings().get();
    return {
      localEnabled: s.localEnabled,
      localAvailable: await ai.fm.available(),
      externalEnabled: s.externalEnabled,
      externalBaseUrl: s.externalBaseUrl,
      externalModel: s.externalModel,
      receiptImagesEnabled: s.receiptImagesEnabled,
      apiKeySet: (await readApiKey(ai.secrets)) !== undefined,
    };
  };

  return new Hono()
    .get("/ai", async (c) => c.json(await view(), 200))
    .put("/ai", validate("json", AiSettingsInput), async (c) => {
      const input = c.req.valid("json");
      const externalBaseUrl = input.externalBaseUrl ?? null;
      const externalModel = input.externalModel ?? null;
      // apiKey: 省略は変えない、空文字は削除、それ以外は置き換え
      const keySetAfter =
        input.apiKey === undefined
          ? (await readApiKey(ai.secrets)) !== undefined
          : input.apiKey !== "";

      // 証憑の画像の送信は外部の AI が有効なときだけ真にできる（010 R15。DB の CHECK も同じ）
      if (input.receiptImagesEnabled && !input.externalEnabled) {
        return fail(
          c,
          domainError("AI_NOT_CONFIGURED", "証憑の画像を送るには、外部の AI を有効にしてください", {
            fields: ["externalEnabled"],
          }),
        );
      }

      if (input.externalEnabled) {
        const fields = [
          ...(externalBaseUrl === null ? ["externalBaseUrl"] : []),
          ...(externalModel === null ? ["externalModel"] : []),
          ...(keySetAfter ? [] : ["apiKey"]),
        ];
        if (fields.length > 0) {
          return fail(
            c,
            domainError(
              "AI_NOT_CONFIGURED",
              "外部の AI の接続先・モデル・API キーがそろっていません",
              {
                fields,
              },
            ),
          );
        }
      }

      // キーチェーン → 設定の順。キーチェーンが失敗したら設定は変えない
      if (input.apiKey === "") await ai.secrets.delete(AI_API_KEY_SECRET);
      else if (input.apiKey !== undefined) await ai.secrets.set(AI_API_KEY_SECRET, input.apiKey);
      ai.settings().save(
        {
          localEnabled: input.localEnabled,
          externalEnabled: input.externalEnabled,
          externalBaseUrl,
          externalModel,
          // 外部が有効のときだけ true（上の検査）。外部を無効にする保存では偽（入力も偽）
          receiptImagesEnabled: input.receiptImagesEnabled,
        },
        clock.now(),
      );
      return c.json(await view(), 200);
    });
}
