import { RepositoryConflictError } from "../ports.ts";
import { err, type Journal, ok, type Result } from "../types.ts";
import {
  checkReason,
  type LedgerDeps,
  loadEditableJournal,
  versionConflict,
} from "./journal-edit.ts";

export type VoidJournalInput = { reason: string; version: number };

/**
 * 仕訳を取り消す（US3, FR-019, FR-021）。行は残したまま status を voided にし、
 * 変更前後の全内容と理由を audit_log に残す。締め済みの期間の仕訳は PERIOD_CLOSED
 */
export function voidJournal(
  deps: LedgerDeps,
  journalId: string,
  input: VoidJournalInput,
): Result<Journal> {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;

  return deps.ledger.transaction((tx) => {
    const loaded = loadEditableJournal(
      tx,
      journalId,
      input.version,
      deps.masters.listFiscalPeriods(),
    );
    if (!loaded.ok) return loaded;
    const before = loaded.value;

    const now = deps.clock.now();
    let after: Journal;
    try {
      after = tx.voidJournal(journalId, input.version, now);
    } catch (e) {
      if (e instanceof RepositoryConflictError) return err(versionConflict(before));
      throw e;
    }
    tx.appendAudit({
      id: deps.ids.next(),
      occurredAt: now,
      targetType: "journal",
      targetId: journalId,
      action: "void",
      reason: reason.value,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
    });
    return ok(after);
  });
}
