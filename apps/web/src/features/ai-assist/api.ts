import type { JournalAiSuggestionInput } from "@trebuchet/schema";
import { api, unwrap } from "@/lib/api";

// 仕訳の入力への AI の候補（011/R19。011 contracts/http-api.md §1 の POST /journals/ai-suggestion）。
// 送るのは日付・金額・摘要だけで、サーバーが mask を通して外部の AI へ渡す。仕訳は保存しない

/** 候補を求める。`suggestion: null` は候補なし（理由は `reason`） */
export const postJournalAiSuggestion = async (entityId: string, json: JournalAiSuggestionInput) =>
  unwrap(
    await api.api.entities[":entityId"].journals["ai-suggestion"].$post({
      param: { entityId },
      json,
    }),
  );
