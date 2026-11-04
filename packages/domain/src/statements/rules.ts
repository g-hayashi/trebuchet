import type { InferenceRuleView } from "@trebuchet/schema";
import type { Account, InferenceRule, Journal, JournalLine } from "../types.ts";
import { STATEMENT_ACCOUNT_CODES } from "./journal-shape.ts";
import { normalizeContent } from "./normalize.ts";

/** 推定のルール（006 R9、§1.6、FR-022〜024）。純関数 */

/** ルールが決める仕訳の中身（相手の科目・補助科目・税区分・取引先・判定・摘要の型） */
export type RuleBody = Pick<
  InferenceRule,
  | "counterAccountId"
  | "counterSubAccountId"
  | "partnerId"
  | "taxCategory"
  | "purpose"
  | "descriptionTemplate"
>;

/** ルールの一意のキー（正規化した内容, 取込元の口座。null はすべての口座） */
export type RuleKey = Pick<InferenceRule, "normalizedContent" | "statementAccountId">;

const BODY_KEYS = [
  "counterAccountId",
  "counterSubAccountId",
  "partnerId",
  "taxCategory",
  "purpose",
  "descriptionTemplate",
] as const satisfies readonly (keyof RuleBody)[];

const sameBody = (a: RuleBody, b: RuleBody): boolean => BODY_KEYS.every((k) => a[k] === b[k]);

const bodyOf = (r: RuleBody): RuleBody => ({
  counterAccountId: r.counterAccountId,
  counterSubAccountId: r.counterSubAccountId,
  partnerId: r.partnerId,
  taxCategory: r.taxCategory,
  purpose: r.purpose,
  descriptionTemplate: r.descriptionTemplate,
});

/**
 * 明細に使うルールを選ぶ。正規化した内容が同じで、口座が同じか「すべての口座」のもの。
 * 同じ口座のルールを優先する。停止中（`paused`）は使わない
 */
export function ruleFor(
  statement: { normalizedContent: string; statementAccountId: string },
  rules: readonly InferenceRule[],
): InferenceRule | undefined {
  const usable = rules.filter(
    (r) => r.status === "active" && r.normalizedContent === statement.normalizedContent,
  );
  return (
    usable.find((r) => r.statementAccountId === statement.statementAccountId) ??
    usable.find((r) => r.statementAccountId === null)
  );
}

/** 確信度 = `min(95, 50 + 10 × hits) − 20 × overrides`。0 未満は 0。整数 */
export function ruleConfidence(rule: Pick<InferenceRule, "hits" | "overrides">): number {
  return Math.max(0, Math.min(95, 50 + 10 * rule.hits) - 20 * rule.overrides);
}

/** 画面・API の形（確信度つき） */
export function toRuleView(rule: InferenceRule): InferenceRuleView {
  return { ...rule, confidence: ruleConfidence(rule) };
}

export type RuleApproval = RuleKey & { body: RuleBody };

export type LearnedRule = RuleKey & RuleBody & { hits: number; overrides: number };

/**
 * 承認から学ぶ。ルールがなければ新規（`hits` 1）、同じ内容なら `hits` を加算、違う内容なら
 * `overrides` を加算して承認の内容に置き換える（`hits` は変えない）。結果は承認の内容と一致する。
 * `managedBy` が `user` のルールは変えない（`action` は `none`、結果は今のルールの内容。011 R9・INV-71）。
 * `rule` は承認の口座のルール（なければ null）。状態・出所・日時は呼び出し側が引き継ぐ
 */
export function learnRule(
  rule: InferenceRule | null,
  approval: RuleApproval,
): { action: "create" | "update" | "none"; rule: LearnedRule } {
  const key = {
    normalizedContent: approval.normalizedContent,
    statementAccountId: approval.statementAccountId,
  };
  const body = bodyOf(approval.body);
  if (rule === null) return { action: "create", rule: { ...key, ...body, hits: 1, overrides: 0 } };
  if (rule.managedBy === "user") {
    return {
      action: "none",
      rule: {
        normalizedContent: rule.normalizedContent,
        statementAccountId: rule.statementAccountId,
        ...bodyOf(rule),
        hits: rule.hits,
        overrides: rule.overrides,
      },
    };
  }
  const same = sameBody(rule, body);
  return {
    action: "update",
    rule: {
      ...key,
      ...body,
      hits: rule.hits + (same ? 1 : 0),
      overrides: rule.overrides + (same ? 0 : 1),
    },
  };
}

// ---- 初期作成（R9、FR-023） ----

export type SeededRule = RuleKey & RuleBody & { hits: number; overrides: 0 };

const SEED_SOURCES = new Set<string>(["manual", "import_freee"]);
/** 現金・預金・未払金（明細の口座になる科目） */
const MONEY_CODES: ReadonlySet<string> = new Set([
  STATEMENT_ACCOUNT_CODES.cash,
  STATEMENT_ACCOUNT_CODES.ordinaryDeposit,
  STATEMENT_ACCOUNT_CODES.accountsPayable,
]);
const OWNER_CODES: ReadonlySet<string> = new Set([
  STATEMENT_ACCOUNT_CODES.ownerContribution,
  STATEMENT_ACCOUNT_CODES.ownerDrawing,
]);

/**
 * 既存の仕訳から初期のルールを作る。対象は有効な `manual`・`import_freee` の仕訳のうち、
 * 現金・預金・未払金の行が 1 つと相手の行が 1 つのもの。行の摘要（相手の行、なければ口座の側の行）を
 * 内容とみなして集め、正規化した内容が同じものが 2 件以上あり、最も多い組み合わせが 3/4 以上を占める内容だけを
 * ルール（口座は「すべて」、`hits` はその組み合わせの件数）にする。相手が事業主貸・事業主借なら判定は私用
 */
export function seedRules(
  journals: readonly Journal[],
  accounts: readonly Pick<Account, "id" | "code">[],
): SeededRule[] {
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]));
  const isMoney = (l: JournalLine) => MONEY_CODES.has(codeOf.get(l.accountId) ?? "");
  const groups = new Map<string, Map<string, { body: RuleBody; count: number }>>();

  for (const j of journals) {
    if (j.status !== "active" || !SEED_SOURCES.has(j.source) || j.lines.length !== 2) continue;
    const money = j.lines.filter(isMoney);
    const counter = j.lines.find((l) => !isMoney(l));
    if (money.length !== 1 || counter === undefined || money[0] === undefined) continue;
    const description = counter.description?.trim() || money[0].description?.trim() || "";
    const content = normalizeContent(description);
    if (content === "") continue;
    const body: RuleBody = {
      counterAccountId: counter.accountId,
      counterSubAccountId: counter.subAccountId,
      partnerId: counter.partnerId,
      taxCategory: counter.taxCategory,
      purpose: OWNER_CODES.has(codeOf.get(counter.accountId) ?? "") ? "private" : "business",
      descriptionTemplate: null,
    };
    const comboKey = JSON.stringify(BODY_KEYS.map((k) => body[k]));
    const combos = groups.get(content) ?? new Map();
    const entry = combos.get(comboKey) ?? { body, count: 0 };
    entry.count += 1;
    combos.set(comboKey, entry);
    groups.set(content, combos);
  }

  const seeded: SeededRule[] = [];
  for (const [content, combos] of groups) {
    const total = [...combos.values()].reduce((sum, c) => sum + c.count, 0);
    const top = [...combos.values()].reduce((a, b) => (b.count > a.count ? b : a));
    if (total < 2 || top.count * 4 < total * 3) continue;
    seeded.push({
      normalizedContent: content,
      statementAccountId: null,
      ...top.body,
      hits: top.count,
      overrides: 0,
    });
  }
  return seeded.sort((a, b) => a.normalizedContent.localeCompare(b.normalizedContent));
}
