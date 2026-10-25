import type {
  InferenceRuleView,
  Purpose,
  StatementAccount,
  StatementView,
} from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import { findAccountByCode } from "../invoicing/journal-drafts.ts";
import type { Clock, IdGenerator, StatementUnitOfWork } from "../ports.ts";
import { STATEMENT_ACCOUNT_CODES } from "../statements/journal-shape.ts";
import { findTransferPair } from "../statements/transfer.ts";
import {
  type DomainWarning,
  domainError,
  err,
  type Journal,
  type JournalDraft,
  ok,
  type Result,
  type StatementCandidateRecord,
  type StatementLinkRecord,
  type StatementRecord,
  validation,
} from "../types.ts";
import { createJournal } from "./create-journal.ts";
import { learnFromApproval } from "./inference-rules.ts";
import { checkReason } from "./journal-edit.ts";
import { loadStatementStates, type StatementState } from "./statement-candidates.ts";
import { getStatementSettings, type StatementTx, statementViewsInTx } from "./statements.ts";

// 承認・除外・結びつきの取消（006 US2。R5〜R7・R15・R16、§1.5、FR-014〜018・020・021・021a）。
// 書き込みは UnitOfWork の中だけ（INV-47）。fn が `err` を返すか例外を投げれば、失効した結びつきも含めて全部巻き戻る

type ApprovalDeps = { uow: StatementUnitOfWork; ids: IdGenerator; clock: Clock };

/** 承認の入力。何も渡さなければ候補のまま承認する */
export type ApproveStatementInput = {
  /** 直した仕訳の案。候補の案の代わりに登録する */
  draft?: JournalDraft | undefined;
  /** 結びつけ先の既存の仕訳の行（`match` の候補、または利用者が選んだ仕訳）。`draft` とは同時に渡せない */
  match?: { journalId: string; lineId: string } | undefined;
  /** 推定ルールの学習（US3。R9）に使う判定。省略なら登録した仕訳の相手の科目から決める（事業主貸・借なら私用） */
  purpose?: Purpose | undefined;
  /** 推定ルールの学習に使う取引先。省略なら登録した仕訳の相手の行の取引先 */
  partnerId?: string | undefined;
  /** false ならルールを学ばない（既定は学ぶ）。既存の仕訳への結びつき（`match`）は学ばない */
  learn?: boolean | undefined;
};

export type ApprovedStatement = {
  /** 登録した仕訳。既存の仕訳に結びつけたとき（`matched`）は null */
  journal: Journal | null;
  /** この明細の結びつき */
  link: StatementLinkRecord;
  /** 振替の対の相手の明細の結びつき（同じ仕訳の別の行）。対がなければ null */
  pairLink: StatementLinkRecord | null;
  warnings: DomainWarning[];
  /** この承認で作った・直したルール。学ばなかったとき（`learn: false`、`match`、分割の仕訳）はない */
  rule?: InferenceRuleView | undefined;
};

const REVOKE_REASON = "結びつけた仕訳が取り消されたため";

/** 明細の口座が帳簿のどの科目にあたるか。`private` の口座は相手の事業主貸（入金）・事業主借（出金） */
function ledgerAccountOf(
  tx: StatementTx,
  account: StatementAccount,
  inflow: boolean,
): Result<{ accountId: string; subAccountId: string | null }> {
  if (account.usage === "private") {
    const owner = findAccountByCode(
      tx.masters.listAccounts(),
      inflow ? STATEMENT_ACCOUNT_CODES.ownerDrawing : STATEMENT_ACCOUNT_CODES.ownerContribution,
    );
    if (!owner.ok) return owner;
    return ok({ accountId: owner.value, subAccountId: null });
  }
  if (account.accountId === null) {
    return validation("口座の科目が設定されていません", { field: "accountId" });
  }
  return ok({ accountId: account.accountId, subAccountId: account.subAccountId });
}

/** 結びつきを作り、監査に残す */
function insertLink(
  deps: ApprovalDeps,
  tx: StatementTx,
  link: Omit<StatementLinkRecord, "id" | "revokedAt" | "revokedReason">,
): StatementLinkRecord {
  const record: StatementLinkRecord = {
    ...link,
    id: deps.ids.next(),
    revokedAt: null,
    revokedReason: null,
  };
  tx.statements.insertStatementLink(record);
  tx.statements.appendStatementAudit(
    auditEntry(deps, {
      targetType: "statement_link",
      targetId: record.id,
      action: "create",
      after: record,
      at: link.createdAt,
    }),
  );
  return record;
}

/** 結びつきを失効させ、監査に残す */
function revokeLink(
  deps: ApprovalDeps,
  tx: StatementTx,
  link: StatementLinkRecord,
  reason: string,
  action: "revoke" | "unlink",
  at: string,
): void {
  tx.statements.revokeStatementLink(link.id, at, reason);
  tx.statements.appendStatementAudit(
    auditEntry(deps, {
      targetType: "statement_link",
      targetId: link.id,
      action,
      reason,
      before: link,
      after: { ...link, revokedAt: at, revokedReason: reason },
      at,
    }),
  );
}

/**
 * 取消済みの仕訳への有効な結びつきを先に失効させる（R15。部分 UNIQUE に当たらないように）。
 * 呼ぶのは未処理の明細だけ（未処理の明細の有効な結びつきは、仕訳が取り消されたもの）
 */
function revokeStaleLinks(
  deps: ApprovalDeps,
  tx: StatementTx,
  state: StatementState,
  at: string,
): void {
  for (const link of state.activeLinks) revokeLink(deps, tx, link, REVOKE_REASON, "revoke", at);
}

const notFound = (statementId: string) =>
  err(domainError("STATEMENT_NOT_FOUND", "明細が見つかりません", { statementId }));

/** 明細の状態で承認を止める */
function checkApprovable(state: StatementState) {
  if (state.status === "registered") {
    return err(
      domainError("STATEMENT_ALREADY_REGISTERED", "登録済みの明細です", {
        statementId: state.record.id,
      }),
    );
  }
  if (state.status === "excluded") {
    return err(
      domainError("STATEMENT_EXCLUDED", "除外した明細です（除外を取り消してください）", {
        statementId: state.record.id,
      }),
    );
  }
  return undefined;
}

type Plan =
  | { kind: "create"; draft: JournalDraft }
  | { kind: "match"; ref: { journalId: string; lineId: string } };

/** 入力と候補から、仕訳を作るか既存の仕訳に結ぶかを決める */
function resolvePlan(
  input: ApproveStatementInput,
  candidate: StatementCandidateRecord | undefined,
): Result<Plan> {
  if (input.draft !== undefined && input.match !== undefined) {
    return validation("仕訳の案と結びつけ先の仕訳は同時に指定できません");
  }
  if (input.match !== undefined) return ok({ kind: "match", ref: input.match });
  if (input.draft !== undefined) {
    if (input.draft.correctsJournalId !== undefined) {
      return validation("明細の承認では訂正仕訳を登録できません", { field: "correctsJournalId" });
    }
    return ok({ kind: "create", draft: input.draft });
  }
  if (candidate === undefined || candidate.method === "none" || candidate.draftJson === null) {
    return validation("承認できる候補がありません。仕訳の案を入力してください");
  }
  const parsed = JSON.parse(candidate.draftJson) as unknown;
  if (candidate.method === "match") {
    return ok({ kind: "match", ref: parsed as { journalId: string; lineId: string } });
  }
  return ok({ kind: "create", draft: parsed as JournalDraft });
}

/**
 * 明細を承認する（FR-014〜016・020・021a）。1 つの UnitOfWork の中で
 * 検査 → 取消済みの仕訳への有効な結びつきの失効 → 仕訳の登録（出所 `statement`）または結びつけ先の検査 →
 * `statement_links`（振替の対は 2 行に）→ 監査 を行う。どこで失敗しても全部巻き戻る（INV-47）。
 *
 * - 登録済みは `STATEMENT_ALREADY_REGISTERED`、除外済みは `STATEMENT_EXCLUDED`
 * - 直した案の、明細の口座の行の合計（借方 − 貸方）が明細の金額と違えば `STATEMENT_AMOUNT_MISMATCH`
 *   （`details.expected` = 明細の金額、`actual` = 案の合計。ともに符号つき）
 * - 結びつけ先の行に別の明細が結びついていれば `JOURNAL_LINE_ALREADY_LINKED`
 * - 税区分が省かれた行は 001 の `createJournal` が既定で補う
 */
export function approveCandidate(
  deps: ApprovalDeps,
  statementId: string,
  input: ApproveStatementInput = {},
): Result<ApprovedStatement> {
  return deps.uow.run((tx) => {
    const states = loadStatementStates(tx);
    const state = states.find((s) => s.record.id === statementId);
    if (state === undefined) return notFound(statementId);
    const blocked = checkApprovable(state);
    if (blocked !== undefined) return blocked;

    const record = state.record;
    if (record.amount === 0) return validation("0 円の明細は承認できません", { field: "amount" });
    const account = tx.statements
      .listStatementAccounts()
      .find((a) => a.id === record.statementAccountId) as StatementAccount;
    const candidate = tx.statements
      .listStatementCandidates()
      .find((c) => c.statementId === statementId);
    const plan = resolvePlan(input, candidate);
    if (!plan.ok) return plan;
    if (
      input.partnerId !== undefined &&
      !tx.masters.listPartners().some((p) => p.id === input.partnerId)
    ) {
      return validation("取引先が見つかりません", {
        field: "partnerId",
        partnerId: input.partnerId,
      });
    }
    const inflow = record.amount > 0;
    const target = ledgerAccountOf(tx, account, inflow);
    if (!target.ok) return target;
    const now = deps.clock.now();

    if (plan.value.kind === "match") {
      return approveMatch(deps, tx, states, state, account, target.value, plan.value.ref, now);
    }

    // ---- 仕訳の登録 ----
    const draft = plan.value.draft;
    const isTargetLine = (l: { accountId: string; subAccountId?: string | null | undefined }) =>
      l.accountId === target.value.accountId &&
      (l.subAccountId ?? null) === target.value.subAccountId;
    const actual = draft.lines
      .filter(isTargetLine)
      .reduce((sum, l) => sum + (l.side === "debit" ? l.amount : -l.amount), 0);
    if (actual !== record.amount) {
      return err(
        domainError("STATEMENT_AMOUNT_MISMATCH", "明細の口座の行の合計が明細の金額と一致しません", {
          expected: record.amount,
          actual,
        }),
      );
    }
    const ownSide = inflow ? "debit" : "credit";
    const lineIndex = draft.lines.findIndex((l) => isTargetLine(l) && l.side === ownSide);

    revokeStaleLinks(deps, tx, state, now);
    const posted = createJournal(
      { ledger: tx.ledger, masters: tx.masters, ids: deps.ids, clock: deps.clock },
      draft,
      { source: "statement" },
    );
    if (!posted.ok) return posted;
    const journal = posted.value.journal;
    const ownLine = journal.lines.find((l) => l.lineNo === lineIndex + 1);
    if (ownLine === undefined) {
      return validation("明細の口座の行が見つかりません", { field: "lines" });
    }
    const link = insertLink(deps, tx, {
      statementId,
      journalId: journal.id,
      journalLineId: ownLine.id,
      kind: "created",
      createdAt: now,
    });

    const pairLink =
      candidate?.method === "transfer"
        ? linkTransferPair(deps, tx, states, record, candidate, journal, ownLine.id, now)
        : null;
    // 承認から学ぶ（同じ UnitOfWork。INV-47）。最後に行うので、ここまでに作った結びつきも候補の作り直しに反映される
    const rule =
      input.learn === false
        ? null
        : learnFromApproval(deps, tx, {
            record,
            journal,
            ownLineId: ownLine.id,
            purpose: input.purpose,
            partnerId: input.partnerId,
            now,
          });
    return ok({
      journal,
      link,
      pairLink,
      warnings: posted.value.warnings,
      ...(rule === null ? {} : { rule }),
    });
  });
}

/**
 * 振替の対の相手を、同じ仕訳の別の行に結びつける（R6）。相手は承認時に `findTransferPair` で引き直す
 * （候補に相手の ID は保存していない）。相手の候補が `transfer` で、仕訳に相手の口座の行（向き・金額が同じ）が
 * あるときだけ結ぶ。見つからなければ null（相手は未処理のまま）
 */
function linkTransferPair(
  deps: ApprovalDeps,
  tx: StatementTx,
  states: readonly StatementState[],
  record: StatementRecord,
  _candidate: StatementCandidateRecord,
  journal: Journal,
  ownLineId: string,
  now: string,
): StatementLinkRecord | null {
  const transferIds = new Set(
    tx.statements
      .listStatementCandidates()
      .filter((c) => c.method === "transfer")
      .map((c) => c.statementId),
  );
  const pool = states.filter(
    (s) =>
      s.status === "unprocessed" &&
      s.record.id !== record.id &&
      s.record.amount !== 0 &&
      transferIds.has(s.record.id),
  );
  const pair = findTransferPair(
    record,
    pool.map((s) => s.record),
  );
  if (pair === undefined) return null;
  const pairAccount = tx.statements
    .listStatementAccounts()
    .find((a) => a.id === pair.statementAccountId) as StatementAccount;
  if (pairAccount.usage === "private" || pairAccount.accountId === null) return null;
  const pairSide = pair.amount > 0 ? "debit" : "credit";
  const pairLine = journal.lines.find(
    (l) =>
      l.id !== ownLineId &&
      l.side === pairSide &&
      l.accountId === pairAccount.accountId &&
      l.subAccountId === pairAccount.subAccountId &&
      l.amount === Math.abs(pair.amount),
  );
  if (pairLine === undefined) return null;
  const pairState = pool.find((s) => s.record.id === pair.id) as StatementState;
  revokeStaleLinks(deps, tx, pairState, now);
  return insertLink(deps, tx, {
    statementId: pair.id,
    journalId: journal.id,
    journalLineId: pairLine.id,
    kind: "created",
    createdAt: now,
  });
}

/** 既存の仕訳の行に結びつける（`matched`。R7、FR-021a）。仕訳は作らない */
function approveMatch(
  deps: ApprovalDeps,
  tx: StatementTx,
  states: readonly StatementState[],
  state: StatementState,
  account: StatementAccount,
  target: { accountId: string; subAccountId: string | null },
  ref: { journalId: string; lineId: string },
  now: string,
): Result<ApprovedStatement> {
  const record = state.record;
  if (account.usage === "private") {
    return validation("私用の口座の明細は既存の仕訳に結びつけられません");
  }
  const journal = tx.ledger.getJournal(ref.journalId);
  if (journal === undefined) {
    return err(
      domainError("JOURNAL_NOT_FOUND", "仕訳が見つかりません", { journalId: ref.journalId }),
    );
  }
  if (journal.status !== "active") {
    return validation("取消済みの仕訳には結びつけられません", { journalId: journal.id });
  }
  const line = journal.lines.find((l) => l.id === ref.lineId);
  if (line === undefined) {
    return validation("結びつけ先の仕訳に、その行がありません", { lineId: ref.lineId });
  }
  const inflow = record.amount > 0;
  if (
    line.accountId !== target.accountId ||
    line.subAccountId !== target.subAccountId ||
    line.side !== (inflow ? "debit" : "credit")
  ) {
    return validation("結びつけ先の行が、明細の口座・向きと一致しません", { lineId: line.id });
  }
  if (line.amount !== Math.abs(record.amount)) {
    return err(
      domainError("STATEMENT_AMOUNT_MISMATCH", "結びつけ先の行の金額が明細の金額と一致しません", {
        expected: record.amount,
        actual: inflow ? line.amount : -line.amount,
      }),
    );
  }
  const holder = states.find((s) => s.activeLinks.some((l) => l.journalLineId === line.id));
  if (holder !== undefined) {
    return err(
      domainError("JOURNAL_LINE_ALREADY_LINKED", "その仕訳の行には別の明細が結びついています", {
        lineId: line.id,
        statementId: holder.record.id,
      }),
    );
  }
  revokeStaleLinks(deps, tx, state, now);
  const link = insertLink(deps, tx, {
    statementId: record.id,
    journalId: journal.id,
    journalLineId: line.id,
    kind: "matched",
    createdAt: now,
  });
  return ok({ journal: null, link, pairLink: null, warnings: [] });
}

// ---- まとめて承認（FR-018） ----

export type BulkApproveInput = {
  statementIds?: readonly string[] | undefined;
  /** 省略で設定の `bulk_threshold` */
  threshold?: number | undefined;
};

export type BulkApproved = {
  /** 承認した明細（振替の対の相手を含む） */
  approved: string[];
  failed: { statementId: string; code: string; message: string }[];
};

/**
 * 確信度がしきい値以上の候補（`none` を除く）をまとめて承認する。明細ごとに 1 つの UnitOfWork で、
 * 失敗は理由つきで `failed` に残して続ける。`statementIds` を渡すと対象をその明細に絞り、
 * 候補がない・しきい値未満の明細も `failed`（`VALIDATION`）に残す。日付の古い順に承認し、
 * 振替の対の相手は対と一緒に承認される（二重に数えない）
 */
export function approveBulk(
  deps: ApprovalDeps,
  input: BulkApproveInput = {},
): Result<BulkApproved> {
  const threshold =
    input.threshold ??
    (() => {
      const settings = getStatementSettings(deps);
      return settings.ok ? settings.value.bulkThreshold : 80;
    })();

  const read = deps.uow.run((tx) =>
    ok({
      states: loadStatementStates(tx),
      candidates: new Map(tx.statements.listStatementCandidates().map((c) => [c.statementId, c])),
    }),
  );
  if (!read.ok) return read;
  const { states, candidates } = read.value;

  const eligible = (id: string): string | undefined => {
    const c = candidates.get(id);
    if (c === undefined || c.method === "none") return "承認できる候補がありません";
    if ((c.confidence ?? 0) < threshold) {
      return `確信度（${c.confidence}）がしきい値（${threshold}）未満です`;
    }
    return undefined;
  };

  const approved: string[] = [];
  const failed: BulkApproved["failed"] = [];
  const done = new Set<string>();
  const known = new Map(states.map((s) => [s.record.id, s]));

  let order: string[];
  if (input.statementIds === undefined) {
    order = states
      .filter((s) => s.status === "unprocessed" && eligible(s.record.id) === undefined)
      .sort((a, b) => a.record.date.localeCompare(b.record.date))
      .map((s) => s.record.id);
  } else {
    order = [...new Set(input.statementIds)];
  }

  for (const id of order) {
    if (done.has(id)) continue;
    const state = known.get(id);
    if (input.statementIds !== undefined && state !== undefined) {
      const reason = eligible(id);
      if (reason !== undefined && state.status === "unprocessed") {
        failed.push({ statementId: id, code: "VALIDATION", message: reason });
        continue;
      }
    }
    const r = approveCandidate(deps, id);
    if (!r.ok) {
      failed.push({ statementId: id, code: r.error.code, message: r.error.message });
      continue;
    }
    approved.push(id);
    done.add(id);
    if (r.value.pairLink !== null) {
      approved.push(r.value.pairLink.statementId);
      done.add(r.value.pairLink.statementId);
    }
  }
  return ok({ approved, failed });
}

// ---- 除外・変更の確認・結びつきの取消 ----

/** 更新後の 1 件（`StatementView`）。UnitOfWork の中で呼ぶ */
function viewOf(tx: StatementTx, statementId: string): StatementView {
  return statementViewsInTx(tx).find((v) => v.id === statementId) as StatementView;
}

/**
 * 明細を除外する（FR-017）。理由は任意。登録済みは `STATEMENT_ALREADY_REGISTERED`。
 * 除外済みをもう一度除外しても何も変わらない（最初の理由を残す）
 */
export function excludeStatement(
  deps: ApprovalDeps,
  statementId: string,
  input: { reason?: string | undefined } = {},
): Result<StatementView> {
  return deps.uow.run((tx) => {
    const state = loadStatementStates(tx).find((s) => s.record.id === statementId);
    if (state === undefined) return notFound(statementId);
    if (state.status === "registered") {
      return err(
        domainError("STATEMENT_ALREADY_REGISTERED", "登録済みの明細は除外できません", {
          statementId,
        }),
      );
    }
    if (state.status === "excluded") return ok(viewOf(tx, statementId));
    const now = deps.clock.now();
    const reason = input.reason?.trim() || null;
    tx.statements.setStatementExcluded(statementId, { at: now, reason });
    tx.statements.appendStatementAudit(
      auditEntry(deps, {
        targetType: "statement",
        targetId: statementId,
        action: "exclude",
        reason,
        before: { excludedAt: null, excludedReason: null },
        after: { excludedAt: now, excludedReason: reason },
        at: now,
      }),
    );
    return ok(viewOf(tx, statementId));
  });
}

/** 除外を取り消す（FR-017）。理由は必須（`REASON_REQUIRED`）。除外していない明細は `VALIDATION` */
export function unexcludeStatement(
  deps: ApprovalDeps,
  statementId: string,
  input: { reason: string },
): Result<StatementView> {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;
  return deps.uow.run((tx) => {
    const state = loadStatementStates(tx).find((s) => s.record.id === statementId);
    if (state === undefined) return notFound(statementId);
    if (state.status !== "excluded") {
      return validation("除外していない明細です", { statementId });
    }
    const now = deps.clock.now();
    tx.statements.setStatementExcluded(statementId, null);
    tx.statements.appendStatementAudit(
      auditEntry(deps, {
        targetType: "statement",
        targetId: statementId,
        action: "unexclude",
        reason: reason.value,
        before: {
          excludedAt: state.record.excludedAt,
          excludedReason: state.record.excludedReason,
        },
        after: { excludedAt: null, excludedReason: null },
        at: now,
      }),
    );
    return ok(viewOf(tx, statementId));
  });
}

/** 「変更あり」を確認した印（`changed_ack_at`）を書き、監査に残す（FR-005）。確認する変更がなければ `VALIDATION` */
export function acknowledgeChange(deps: ApprovalDeps, statementId: string): Result<StatementView> {
  return deps.uow.run((tx) => {
    const state = loadStatementStates(tx).find((s) => s.record.id === statementId);
    if (state === undefined) return notFound(statementId);
    const { changedJson, changedAckAt } = state.record;
    if (changedJson === null || changedAckAt !== null) {
      return validation("確認する変更がありません", { statementId });
    }
    const now = deps.clock.now();
    tx.statements.acknowledgeStatementChange(statementId, now);
    tx.statements.appendStatementAudit(
      auditEntry(deps, {
        targetType: "statement",
        targetId: statementId,
        action: "acknowledge",
        before: { changedAckAt: null },
        after: { changedAckAt: now, changedJson },
        at: now,
      }),
    );
    return ok(viewOf(tx, statementId));
  });
}

/**
 * 既存の仕訳への結びつき（`matched`）を理由つきで外す（FR-021a）。理由は必須（`REASON_REQUIRED`）。
 * `created` の結びつき・結びつきのない明細は `VALIDATION`（`created` は 001 の仕訳の取消で戻す）。
 * 仕訳は変えない
 */
export function unlinkStatement(
  deps: ApprovalDeps,
  statementId: string,
  input: { reason: string },
): Result<StatementView> {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;
  return deps.uow.run((tx) => {
    const state = loadStatementStates(tx).find((s) => s.record.id === statementId);
    if (state === undefined) return notFound(statementId);
    if (state.activeLinks.length === 0) {
      return validation("結びつきがありません", { statementId });
    }
    if (state.activeLinks.some((l) => l.kind !== "matched")) {
      return validation(
        "登録した仕訳との結びつきは外せません。仕訳を取り消してください（仕訳の画面）",
        { statementId },
      );
    }
    const now = deps.clock.now();
    for (const link of state.activeLinks) revokeLink(deps, tx, link, reason.value, "unlink", now);
    return ok(viewOf(tx, statementId));
  });
}
