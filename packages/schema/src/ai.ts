import { z } from "zod";
import { TaxCategoryCode } from "./primitives.ts";

// 006-mfme-ai-journal（research R10・R12、contracts/http-api.md §7）

/** AI の出力（候補の根拠）。科目のコードの有効性などはドメインの `parseSuggestion` が検査する */
export const AiSuggestion = z.object({
  accountCode: z.string().min(1),
  taxCategory: TaxCategoryCode,
  purpose: z.enum(["business", "private"]),
  confidence: z.number().int().min(0).max(100),
  reason: z.string().max(200),
});
export type AiSuggestion = z.infer<typeof AiSuggestion>;

/** 外部の接続先の URL は `https://` か localhost（127.0.0.1・[::1]）の `http://` だけ */
export function isAllowedAiBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}

const AiBaseUrl = z
  .string()
  .max(500)
  .refine(isAllowedAiBaseUrl, "接続先の URL は https:// か localhost だけです");

/** PUT /settings/ai。`apiKey` はキーチェーンへ入れる（空文字で削除）。応答には出さない */
export const AiSettingsInput = z.object({
  localEnabled: z.boolean(),
  externalEnabled: z.boolean(),
  externalBaseUrl: AiBaseUrl.optional(),
  externalModel: z.string().min(1).max(200).optional(),
  apiKey: z.string().max(500).optional(),
});
export type AiSettingsInput = z.infer<typeof AiSettingsInput>;

/** GET /settings/ai（API キーそのものは持たない） */
export const AiSettings = z.object({
  localEnabled: z.boolean(),
  localAvailable: z.boolean(),
  externalEnabled: z.boolean(),
  externalBaseUrl: z.string().nullable(),
  externalModel: z.string().nullable(),
  apiKeySet: z.boolean(),
});
export type AiSettings = z.infer<typeof AiSettings>;
