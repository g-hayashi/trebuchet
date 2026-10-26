import { AiSuggestion } from "@trebuchet/schema";
import { type Account, ok, type Result, validation } from "../types.ts";
import { STATEMENT_ACCOUNT_CODES } from "./journal-shape.ts";
import type { AiPayload } from "./mask.ts";

// AI への要求と出力の検証（006 R10、INV-46）。呼び出し（HTTP、プロセス）はドメインの外

/** 相手の科目の候補（名前とコードだけ。AI に送る形） */
export type PromptAccount = Pick<Account, "code" | "name">;

/** 要求（OpenAI 互換の system・user の 2 メッセージ） */
export type AiPrompt = { system: string; user: string };

/** 検証を通った AI の出力。`accountId` は `accountCode` から引いた科目の ID */
export type ParsedSuggestion = AiSuggestion & { accountId: string };

/**
 * 相手になりうる科目か。使用中で、事業主貸・事業主借でないもの。
 * 私用は科目ではなく `purpose = private` で表す（事業主貸・事業主借の行は仕訳の案が作る。R5）
 */
export function isCounterAccount(account: Pick<Account, "code" | "isActive">): boolean {
  return (
    account.isActive &&
    account.code !== STATEMENT_ACCOUNT_CODES.ownerDrawing &&
    account.code !== STATEMENT_ACCOUNT_CODES.ownerContribution
  );
}

/** 相手になりうる有効な科目だけを残す（`buildPrompt` に渡す・`parseSuggestion` が使う） */
export function counterAccounts<A extends Pick<Account, "code" | "isActive">>(
  accounts: readonly A[],
): A[] {
  return accounts.filter(isCounterAccount);
}

/**
 * 要求を作る。system に科目の一覧（コードと名前。`accounts` は `counterAccounts` を通したもの）、
 * 税区分のコード、出力の形。user に明細 1 件（`AiPayload` の JSON）
 */
export function buildPrompt(
  payload: AiPayload,
  accounts: readonly PromptAccount[],
  taxCategories: readonly string[],
): AiPrompt {
  const system = [
    "あなたは日本の個人事業主の経理を手伝います。与えられた銀行・カード・現金の明細 1 件に対し、",
    "仕訳の相手の勘定科目、税区分、事業か私用かの判定を推定してください。",
    "",
    "勘定科目（コード 名前）:",
    ...accounts.map((a) => `${a.code} ${a.name}`),
    "",
    `税区分のコード: ${taxCategories.join(", ")}`,
    "",
    "出力は次の形の JSON オブジェクトだけにしてください（前後に文章を付けない）:",
    '{"accountCode": 勘定科目のコード（上の一覧のもの）, "taxCategory": 税区分のコード（上のもの）,',
    ' "purpose": "business" か "private", "confidence": 0〜100 の整数, "reason": 根拠を 200 字以内で}',
    "一覧にないコードを作らないでください。分からないときは confidence を低くしてください。",
  ].join("\n");
  return { system, user: JSON.stringify(payload) };
}

/** JSON の文字列（コードフェンス・前後の文章つきも）を読む。読めなければ undefined */
function readJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * AI の出力を検証する（INV-46）。`AiSuggestion`（Zod）の形で、科目のコードが `accounts` のうち相手になりうる
 * 有効な科目、税区分が既知のコードのものだけを通す。それ以外は失敗（候補は none にする）。
 * `raw` は JSON の文字列でも、読み取り済みの値でもよい
 */
export function parseSuggestion(
  raw: unknown,
  accounts: readonly Pick<Account, "id" | "code" | "isActive">[],
): Result<ParsedSuggestion> {
  const value = typeof raw === "string" ? readJson(raw) : raw;
  if (value === undefined) return validation("AI の出力を JSON として読めません");
  const parsed = AiSuggestion.safeParse(value);
  if (!parsed.success) return validation("AI の出力が決められた形ではありません");
  const account = counterAccounts(accounts).find((a) => a.code === parsed.data.accountCode);
  if (account === undefined) {
    return validation("AI の出力の勘定科目が、相手になりうる有効な科目にありません", {
      field: "accountCode",
    });
  }
  return ok({ ...parsed.data, accountId: account.id });
}
