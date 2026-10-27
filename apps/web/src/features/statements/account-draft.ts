import type {
  StatementAccountInput,
  StatementAccountKind,
  StatementAccountSuggestion,
  StatementAccountUsage,
} from "@trebuchet/schema";

/**
 * 取込の確認で、未対応の口座に決めている途中の対応（007 US3）。未選択は空文字。
 * 確定のとき、そろった口座だけを `StatementAccountInput` にして commit の `accounts` で送る
 */
export type AccountDraft = {
  usage: StatementAccountUsage | "";
  kind: StatementAccountKind | "";
  accountId: string;
  subAccountId: string;
};

/**
 * 口座の推定を初期値にする。案がなければすべて未選択。用途は案があるときだけ入れる（なければ選んでもらう）。
 * 案が `private` でも科目・補助科目は入っている（`inputFromDraft` が送るときに外す）
 */
export function draftFromSuggestion(suggestion: StatementAccountSuggestion | null): AccountDraft {
  if (suggestion === null) return { usage: "", kind: "", accountId: "", subAccountId: "" };
  return {
    usage: suggestion.usage ?? "",
    kind: suggestion.kind,
    accountId: suggestion.accountId,
    subAccountId: suggestion.subAccountId ?? "",
  };
}

/**
 * 送れる形にする。用途・種類が未選択、または `private` 以外で科目が未選択なら `undefined`（確定できない）。
 * `private` は科目・補助科目を持たないので外す
 */
export function inputFromDraft(draft: AccountDraft): StatementAccountInput | undefined {
  if (draft.usage === "" || draft.kind === "") return undefined;
  if (draft.usage === "private") return { usage: "private", kind: draft.kind };
  if (draft.accountId === "") return undefined;
  return {
    usage: draft.usage,
    kind: draft.kind,
    accountId: draft.accountId,
    ...(draft.subAccountId === "" ? {} : { subAccountId: draft.subAccountId }),
  };
}
