import type {
  InferenceRuleHistoryEntry,
  InferenceRuleListQuery,
  InferenceRuleUpdateInput,
  InferenceRuleView,
  Purpose,
  RuleHistoryAction,
  SeedRulesInput,
} from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import type { Clock, IdGenerator, StatementUnitOfWork } from "../ports.ts";
import { STATEMENT_ACCOUNT_CODES } from "../statements/journal-shape.ts";
import { learnRule, type RuleBody, seedRules, toRuleView } from "../statements/rules.ts";
import {
  domainError,
  err,
  type InferenceRule,
  type Journal,
  ok,
  type Result,
  type StatementAuditAction,
  type StatementRecord,
  validation,
} from "../types.ts";
import { journalsBetween, rebuildRuleCandidates } from "./statement-candidates.ts";
import type { StatementTx } from "./statements.ts";

// 推定ルールの学習と管理（006 US3。R9、§1.6・§1.7、FR-022〜024）。
// 書き込みは UnitOfWork の中だけ。承認からの学習は `approveCandidate` と同じ UnitOfWork で行う（INV-47）。
// どの操作も仕訳を作らない・変えない（INV-41）

type RuleDeps = { uow: StatementUnitOfWork; ids: IdGenerator; clock: Clock };

const notFound = (ruleId: string) =>
  err(domainError("INFERENCE_RULE_NOT_FOUND", "ルールが見つかりません", { ruleId }));

/** ルールを書き（追加または更新）、履歴と監査に残す */
function writeRule(
  deps: Pick<RuleDeps, "ids" | "clock">,
  tx: StatementTx,
  change: {
    before: InferenceRule | null;
    after: InferenceRule;
    action: RuleHistoryAction;
    auditAction: StatementAuditAction;
    statementId?: string | undefined;
  },
): void {
  const { before, after, action, auditAction } = change;
  if (before === null) tx.statements.insertInferenceRule(after);
  else tx.statements.updateInferenceRule(after);
  tx.statements.appendInferenceRuleHistory({
    id: deps.ids.next(),
    ruleId: after.id,
    action,
    beforeJson: before === null ? null : JSON.stringify(before),
    afterJson: JSON.stringify(after),
    statementId: change.statementId ?? null,
    at: after.updatedAt,
  });
  tx.statements.appendStatementAudit(
    auditEntry(deps, {
      targetType: "inference_rule",
      targetId: after.id,
      action: auditAction,
      before,
      after,
      at: after.updatedAt,
    }),
  );
}

// ---- 承認からの学習（R9） ----

/** 事業主貸・事業主借の科目（相手がこれなら判定は私用） */
const OWNER_CODES: ReadonlySet<string> = new Set([
  STATEMENT_ACCOUNT_CODES.ownerContribution,
  STATEMENT_ACCOUNT_CODES.ownerDrawing,
]);

export type LearnFromApproval = {
  record: StatementRecord;
  /** 登録した仕訳 */
  journal: Journal;
  /** 仕訳のうち、明細の口座の行の ID */
  ownLineId: string;
  /** 承認の入力の判定・取引先（あれば学習に優先して使う） */
  purpose?: Purpose | undefined;
  partnerId?: string | undefined;
  now: string;
};

/**
 * 承認した仕訳からルールを作るか直す（R9）。仕訳が「明細の口座の行 + 相手の行 1 つ」でなければ学ばない
 * （分割は要約できない）。承認の口座のルール（なければ新規）に `learnRule` を適用し、履歴と監査を残す。
 * その内容の未処理の明細の候補（rule・none）を作り直す。学んだルールを返す
 */
export function learnFromApproval(
  deps: Pick<RuleDeps, "ids" | "clock">,
  tx: StatementTx,
  input: LearnFromApproval,
): InferenceRuleView | null {
  const { record, journal, ownLineId, now } = input;
  if (record.normalizedContent === "") return null;
  const others = journal.lines.filter((l) => l.id !== ownLineId);
  const counter = others[0];
  if (others.length !== 1 || counter === undefined) return null;

  const derived: Purpose = OWNER_CODES.has(tx.masters.getAccount(counter.accountId)?.code ?? "")
    ? "private"
    : "business";
  const description = counter.description?.trim() || null;
  const body: RuleBody = {
    counterAccountId: counter.accountId,
    counterSubAccountId: counter.subAccountId,
    partnerId: input.partnerId ?? counter.partnerId,
    taxCategory: counter.taxCategory,
    purpose: input.purpose ?? derived,
    descriptionTemplate: description === record.content ? null : description,
  };

  const previous =
    tx.statements
      .listInferenceRules()
      .find(
        (r) =>
          r.normalizedContent === record.normalizedContent &&
          r.statementAccountId === record.statementAccountId,
      ) ?? null;
  const learned = learnRule(previous, {
    normalizedContent: record.normalizedContent,
    statementAccountId: record.statementAccountId,
    body,
  });
  const after: InferenceRule =
    previous === null
      ? {
          id: deps.ids.next(),
          ...learned.rule,
          status: "active",
          origin: "approval",
          createdAt: now,
          updatedAt: now,
        }
      : { ...previous, ...learned.rule, updatedAt: now };
  writeRule(deps, tx, {
    before: previous,
    after,
    action: learned.action === "create" ? "create" : "update",
    auditAction: learned.action,
    statementId: record.id,
  });
  rebuildRuleCandidates(deps, tx, new Set([record.normalizedContent]));
  return toRuleView(after);
}

// ---- 一覧・履歴 ----

/** ルールの一覧（内容の順。同じ内容は「すべての口座」が先）。`status` で絞り込める */
export function listRules(
  deps: Pick<RuleDeps, "uow">,
  query: InferenceRuleListQuery = {},
): Result<InferenceRuleView[]> {
  return deps.uow.run((tx) =>
    ok(
      tx.statements
        .listInferenceRules()
        .filter((r) => query.status === undefined || r.status === query.status)
        .sort(
          (a, b) =>
            a.normalizedContent.localeCompare(b.normalizedContent) ||
            (a.statementAccountId ?? "").localeCompare(b.statementAccountId ?? ""),
        )
        .map(toRuleView),
    ),
  );
}

/** ルールの履歴（追記の順）。before・after は保存した JSON をオブジェクトにして返す */
export function ruleHistory(
  deps: Pick<RuleDeps, "uow">,
  ruleId: string,
): Result<InferenceRuleHistoryEntry[]> {
  return deps.uow.run((tx) => {
    if (!tx.statements.listInferenceRules().some((r) => r.id === ruleId)) return notFound(ruleId);
    const parse = (json: string | null): unknown => (json === null ? null : JSON.parse(json));
    return ok(
      tx.statements.listInferenceRuleHistory(ruleId).map((h) => ({
        id: h.id,
        ruleId: h.ruleId,
        action: h.action,
        before: parse(h.beforeJson),
        after: parse(h.afterJson),
        statementId: h.statementId,
        at: h.at,
      })),
    );
  });
}

// ---- 初期作成（FR-023） ----

export type SeedRulesResult = {
  created: number;
  /** すべての口座の同じ内容のルールがすでにあるため作らなかった数 */
  skipped: number;
  /** `dryRun` は作る案（`id` は空）、実行は作ったルール */
  rules?: InferenceRuleView[];
};

/**
 * 過去の確定仕訳から初期のルールを作る（R9）。`dryRun` は何も書かずに案だけを返す。
 * すべての口座の同じ内容のルールがすでにあれば（停止中も）作らず、`skipped` に数える。
 * 作るルールは出所 `seed`。履歴（create）と監査（seed）を残す
 */
export function seedRulesFromJournals(
  deps: RuleDeps,
  input: SeedRulesInput = {},
): Result<SeedRulesResult> {
  return deps.uow.run((tx) => {
    const journals = journalsBetween(tx.ledger, "0000-01-01", "9999-12-31");
    const seeded = seedRules(journals, tx.masters.listAccounts());
    const existing = new Set(
      tx.statements
        .listInferenceRules()
        .filter((r) => r.statementAccountId === null)
        .map((r) => r.normalizedContent),
    );
    const fresh = seeded.filter((s) => !existing.has(s.normalizedContent));
    const skipped = seeded.length - fresh.length;
    const now = deps.clock.now();
    const toRule = (s: (typeof seeded)[number], id: string): InferenceRule => ({
      id,
      ...s,
      status: "active",
      origin: "seed",
      createdAt: now,
      updatedAt: now,
    });
    if (input.dryRun === true) {
      return ok({
        created: fresh.length,
        skipped,
        rules: fresh.map((s) => toRuleView(toRule(s, ""))),
      });
    }
    const created = fresh.map((s) => toRule(s, deps.ids.next()));
    for (const rule of created) {
      writeRule(deps, tx, {
        before: null,
        after: rule,
        action: "create",
        auditAction: "seed",
      });
    }
    rebuildRuleCandidates(deps, tx, new Set(created.map((r) => r.normalizedContent)));
    return ok({ created: created.length, skipped, rules: created.map(toRuleView) });
  });
}

// ---- 編集・停止・再開（FR-024） ----

/**
 * ルールの内容を直す（相手の科目・補助科目・税区分・取引先・判定・摘要）。`hits`・`overrides` は変えない。
 * 科目は有効なもの（`ACCOUNT_NOT_FOUND`・`ACCOUNT_INACTIVE`）、補助科目はその科目のもの、取引先は存在するもの
 * （どれも違えば `VALIDATION`）。科目を変えて補助科目を渡さなければ補助科目は外す。変更がなければ何も書かない。
 * 履歴は `edit`。その内容の未処理の候補（rule・none）を作り直す
 */
export function updateRule(
  deps: RuleDeps,
  ruleId: string,
  input: InferenceRuleUpdateInput,
): Result<InferenceRuleView> {
  return deps.uow.run((tx) => {
    const rule = tx.statements.listInferenceRules().find((r) => r.id === ruleId);
    if (rule === undefined) return notFound(ruleId);

    const counterAccountId = input.counterAccountId ?? rule.counterAccountId;
    if (input.counterAccountId !== undefined) {
      const account = tx.masters.getAccount(input.counterAccountId);
      if (account === undefined) {
        return err(
          domainError("ACCOUNT_NOT_FOUND", "勘定科目が見つかりません", {
            accountId: input.counterAccountId,
          }),
        );
      }
      if (!account.isActive) {
        return err(
          domainError("ACCOUNT_INACTIVE", "使用停止の科目は選べません", {
            accountId: input.counterAccountId,
          }),
        );
      }
    }
    const subAccountId =
      input.counterSubAccountId !== undefined
        ? input.counterSubAccountId
        : counterAccountId === rule.counterAccountId
          ? rule.counterSubAccountId
          : null;
    if (
      subAccountId !== null &&
      !tx.masters.listSubAccounts(counterAccountId).some((s) => s.id === subAccountId)
    ) {
      return validation("補助科目がその科目のものではありません", {
        field: "counterSubAccountId",
        subAccountId,
      });
    }
    const partnerId = input.partnerId !== undefined ? input.partnerId : rule.partnerId;
    if (partnerId !== null && !tx.masters.listPartners().some((p) => p.id === partnerId)) {
      return validation("取引先が見つかりません", { field: "partnerId", partnerId });
    }
    const template =
      input.descriptionTemplate !== undefined
        ? input.descriptionTemplate?.trim() || null
        : rule.descriptionTemplate;

    const next: InferenceRule = {
      ...rule,
      counterAccountId,
      counterSubAccountId: subAccountId,
      partnerId,
      taxCategory: input.taxCategory ?? rule.taxCategory,
      purpose: input.purpose ?? rule.purpose,
      descriptionTemplate: template,
    };
    const changed = (
      [
        "counterAccountId",
        "counterSubAccountId",
        "partnerId",
        "taxCategory",
        "purpose",
        "descriptionTemplate",
      ] as const
    ).some((k) => next[k] !== rule[k]);
    if (!changed) return ok(toRuleView(rule));

    const after = { ...next, updatedAt: deps.clock.now() };
    writeRule(deps, tx, { before: rule, after, action: "edit", auditAction: "edit" });
    rebuildRuleCandidates(deps, tx, new Set([rule.normalizedContent]));
    return ok(toRuleView(after));
  });
}

function setRuleStatus(
  deps: RuleDeps,
  ruleId: string,
  status: "active" | "paused",
): Result<InferenceRuleView> {
  return deps.uow.run((tx) => {
    const rule = tx.statements.listInferenceRules().find((r) => r.id === ruleId);
    if (rule === undefined) return notFound(ruleId);
    if (rule.status === status) return ok(toRuleView(rule));
    const after: InferenceRule = { ...rule, status, updatedAt: deps.clock.now() };
    const action = status === "paused" ? "pause" : "resume";
    writeRule(deps, tx, { before: rule, after, action, auditAction: action });
    rebuildRuleCandidates(deps, tx, new Set([rule.normalizedContent]));
    return ok(toRuleView(after));
  });
}

/** ルールを止める。以後その候補に使われない（FR-024）。すでに止まっていれば何も書かない */
export const pauseRule = (deps: RuleDeps, ruleId: string): Result<InferenceRuleView> =>
  setRuleStatus(deps, ruleId, "paused");

/** 止めたルールを再開する。すでに有効なら何も書かない */
export const resumeRule = (deps: RuleDeps, ruleId: string): Result<InferenceRuleView> =>
  setRuleStatus(deps, ruleId, "active");
