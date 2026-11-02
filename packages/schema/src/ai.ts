import { z } from "zod";
import { DateString, TaxCategoryCode, Yen } from "./primitives.ts";
import { StatementAmountSign, StatementColumnRole } from "./statements.ts";

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

/**
 * 端末内の AI による列の対応の案（007/R10）。`roles` は列の順に役割を並べる（役割に当たらない列は `none`）。
 * 出力を短くするため、列の番号（index）も理由（reason）も書かせない。
 * 列数との一致・重複・必須の役割はドメインの `parseColumnSuggestion` が検査する
 */
export const AiColumnSuggestion = z.object({
  roles: z.array(z.union([StatementColumnRole, z.literal("none")])),
  amountSign: StatementAmountSign.nullable().optional(),
  confidence: z.number().int().min(0).max(100),
});
export type AiColumnSuggestion = z.infer<typeof AiColumnSuggestion>;

/**
 * 外部の AI による証憑の読み取りの出力（010/R14）。項目ごとに null（候補なし）を許す。
 * ドメインの `parseReceiptReading` が、項目ごとに `AiReceiptReading.shape.<項目>` で検証し、
 * 合わない項目だけ「候補なし」にする。科目・税区分は一覧にあるものだけを採る。
 * `reason` は候補の根拠の短い説明（画面にだけ出す。保存しない）で、200 字まで
 */
export const AiReceiptReading = z.object({
  transactionDate: DateString.nullable(),
  amount: Yen.nullable(),
  partnerName: z.string().min(1).max(100).nullable(),
  accountCode: z.string().min(1).nullable(),
  taxCategory: TaxCategoryCode.nullable(),
  confidence: z.number().int().min(0).max(100),
  reason: z.string().max(200),
});
export type AiReceiptReading = z.infer<typeof AiReceiptReading>;

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
