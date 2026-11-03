import type { TaxCategoryCode } from "@trebuchet/schema";
import { INDIVIDUAL_ACCOUNTS } from "../../../src/seed/accounts.individual.ts";
import type { StatementEvalCase } from "../../../src/statements/eval-runner.ts";
import { normalizeContent } from "../../../src/statements/normalize.ts";
import type { Account } from "../../../src/types.ts";

export const STATEMENT_EVAL_SPLIT_DATE = "2026-01-01";
export const STATEMENT_EVAL_ACCOUNTS: Account[] = INDIVIDUAL_ACCOUNTS.map((a) => ({
  ...a,
  id: `eval-account-${a.code}`,
  isSystem: true,
  isActive: true,
}));

/** 全項目をこの評価用に作った合成入力。実データからの転記はない。 */
export function createStatementEvalCase(
  id: string,
  date: string,
  content: string,
  code = "5130",
  taxCategory: TaxCategoryCode = "PURCHASE_10",
  amount = -3300,
  purpose: "business" | "private" = "business",
): StatementEvalCase {
  const accountId = "eval-bank";
  return {
    scene: "statement",
    sample: {
      statementId: id,
      date,
      statementAccountId: accountId,
      normalizedContent: normalizeContent(content),
      truth: {
        counterAccountId: `eval-account-${code}`,
        taxCategory,
        partnerId: null,
        purpose,
      },
    },
    work: {
      account: {
        id: accountId,
        name: "合成評価口座",
        usage: "mixed",
        kind: "bank",
        accountId: "eval-account-1020",
        subAccountId: null,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      record: {
        id,
        batchId: "eval-batch",
        statementAccountId: accountId,
        stableKey: id,
        externalId: null,
        date,
        amount,
        content,
        normalizedContent: normalizeContent(content),
        categoryMajor: null,
        categoryMinor: null,
        memo: "合成評価メモ（AIに送らない）",
        transferFlag: false,
        changedJson: null,
        changedAckAt: null,
        excludedAt: null,
        excludedReason: null,
        createdAt: "2025-01-01T00:00:00Z",
      },
    },
  };
}

export const STATEMENT_EVAL_CASES: StatementEvalCase[] = [
  createStatementEvalCase("train-ad", "2025-12-01", "合成広告サービスA"),
  createStatementEvalCase("train-network", "2025-12-02", "合成回線サービスB", "5120"),
  createStatementEvalCase("train-rent", "2025-12-03", "合成事務所C 賃料", "5230"),
  createStatementEvalCase(
    "train-private",
    "2025-12-04",
    "合成私用購入D",
    "3090",
    "OUT_OF_SCOPE",
    -2200,
    "private",
  ),
  createStatementEvalCase("rule-ad", "2026-01-02", "合成広告サービスA"),
  createStatementEvalCase("rule-network", "2026-01-03", "合成回線サービスB", "5120"),
  createStatementEvalCase("rule-rent", "2026-01-04", "合成事務所C 賃料", "5230"),
  createStatementEvalCase(
    "rule-private",
    "2026-01-05",
    "合成私用購入D",
    "3090",
    "OUT_OF_SCOPE",
    -2200,
    "private",
  ),
  createStatementEvalCase("ai-ad", "2026-01-06", "合成広告社E 検索広告掲載料"),
  createStatementEvalCase("ai-network", "2026-01-07", "合成通信社F インターネット利用料", "5120"),
  createStatementEvalCase("ai-travel", "2026-01-08", "合成鉄道G 出張運賃", "5110"),
  createStatementEvalCase("ai-supply", "2026-01-09", "合成文具社H 業務用コピー用紙", "5170"),
  createStatementEvalCase("ai-power", "2026-01-10", "合成電力社I 事務所電気料金", "5100"),
  createStatementEvalCase("ai-rent", "2026-01-11", "合成不動産社J 事務所家賃", "5230"),
  createStatementEvalCase(
    "ai-sales",
    "2026-01-12",
    "合成開発業務 売上入金",
    "4010",
    "SALES_10",
    55000,
  ),
  createStatementEvalCase(
    "ai-refund",
    "2026-01-13",
    "合成文具社K 業務用文具返品返金",
    "5170",
    "PURCHASE_10",
    1100,
  ),
  createStatementEvalCase(
    "ai-private",
    "2026-01-14",
    "合成販売店L 家族用おもちゃ 私用",
    "3090",
    "OUT_OF_SCOPE",
    -2200,
    "private",
  ),
  createStatementEvalCase(
    "ai-owner",
    "2026-01-15",
    "個人の貯蓄から事業口座へ自己資金補充",
    "3010",
    "OUT_OF_SCOPE",
    10000,
    "private",
  ),
  createStatementEvalCase(
    "ai-mask",
    "2026-01-16",
    "合成広告社M 広告費 contact@example.invalid 98765432",
  ),
  createStatementEvalCase("ai-phone", "2026-01-17", "合成通信社N 通信料 03-0000-0000", "5120"),
];
