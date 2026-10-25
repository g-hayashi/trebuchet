import { auditEntry } from "../audit.ts";
import { combineErrors, type JournalContext, validateJournal } from "../journal.ts";
import { RepositoryConflictError } from "../ports.ts";
import {
  err,
  type Journal,
  type JournalDraft,
  type JournalLine,
  ok,
  type Result,
} from "../types.ts";
import { checkCorrectsTarget, loadContext } from "./create-journal.ts";
import {
  checkReason,
  type EditOptions,
  type LedgerDeps,
  loadEditableJournal,
  versionConflict,
} from "./journal-edit.ts";

export type JournalCorrectionInput = JournalDraft & { reason: string; version: number };

/** 訂正前の仕訳で使っている科目・補助科目は、使用停止になっていても訂正後に残せる */
function allowUsedAccounts(ctx: JournalContext, journal: Journal): JournalContext {
  const accountIds = new Set(journal.lines.map((l) => l.accountId));
  const subAccountIds = new Set(journal.lines.flatMap((l) => l.subAccountId ?? []));
  return {
    ...ctx,
    accounts: ctx.accounts.map((a) => (accountIds.has(a.id) ? { ...a, isActive: true } : a)),
    subAccounts: ctx.subAccounts.map((s) =>
      subAccountIds.has(s.id) ? { ...s, isActive: true } : s,
    ),
  };
}

/**
 * 仕訳を訂正する（US3, FR-019, FR-020）。
 * 日付・メモ・行をすべて置き換えて version を +1 し、変更前後の全内容と理由を audit_log に残す。
 * 締め済みの期間の仕訳は PERIOD_CLOSED（訂正仕訳で直す）
 */
export function correctJournal(
  deps: LedgerDeps,
  journalId: string,
  input: JournalCorrectionInput,
  options: EditOptions = {},
): Result<Journal> {
  const { reason: rawReason, version, ...draft } = input;
  const reason = checkReason(rawReason);
  if (!reason.ok) return reason;

  return deps.ledger.transaction((tx) => {
    const ctx = loadContext(deps.masters);
    const loaded = loadEditableJournal(tx, journalId, version, ctx.periods, options);
    if (!loaded.ok) return loaded;
    const before = loaded.value;

    const validated = validateJournal(draft, allowUsedAccounts(ctx, before));
    if (!validated.ok) return err(combineErrors(validated.error));
    const valid = validated.value;
    if (valid.correctsJournalId !== null && valid.correctsJournalId !== before.correctsJournalId) {
      const targetError = checkCorrectsTarget(tx, valid.correctsJournalId, ctx, before.source);
      if (targetError !== undefined) return err(targetError);
    }

    const now = deps.clock.now();
    const lines: JournalLine[] = valid.lines.map((l) => ({ ...l, id: deps.ids.next() }));
    let after: Journal;
    try {
      after = tx.replaceJournal(journalId, { ...valid, lines }, version, now);
    } catch (e) {
      if (e instanceof RepositoryConflictError) return err(versionConflict(before));
      throw e;
    }
    tx.appendAudit(
      auditEntry(deps, {
        targetType: "journal",
        targetId: journalId,
        action: "correct",
        reason: reason.value,
        before,
        after,
        at: now,
      }),
    );
    return ok(after);
  });
}
