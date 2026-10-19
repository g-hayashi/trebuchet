import type { LedgerRepository } from "../ports.ts";
import {
  domainError,
  err,
  type Journal,
  type JournalDetail,
  type JournalHistoryEntry,
  type JournalRef,
  ok,
  type Result,
} from "../types.ts";

type QueryDeps = { ledger: LedgerRepository };

const toRef = (j: Journal): JournalRef => ({
  id: j.id,
  journalNo: j.journalNo,
  date: j.date,
  status: j.status,
});

const notFound = (journalId: string) =>
  err(domainError("JOURNAL_NOT_FOUND", "仕訳が見つかりません", { journalId }));

/** 仕訳と、訂正元・訂正仕訳への参照（FR-019a） */
export function getJournalDetail(deps: QueryDeps, journalId: string): Result<JournalDetail> {
  const journal = deps.ledger.getJournal(journalId);
  if (journal === undefined) return notFound(journalId);
  const corrects =
    journal.correctsJournalId === null
      ? undefined
      : deps.ledger.getJournal(journal.correctsJournalId);
  return ok({
    journal,
    correctsJournal: corrects === undefined ? null : toRef(corrects),
    correctingJournals: deps.ledger.correctingJournalsOf(journalId).map(toRef),
  });
}

const parseJournal = (json: string | null): Journal | null =>
  json === null ? null : (JSON.parse(json) as Journal);

/** 仕訳の変更履歴（FR-020, SC-005）。古い順。before・after は各時点の仕訳の全内容 */
export function getJournalHistory(
  deps: QueryDeps,
  journalId: string,
): Result<JournalHistoryEntry[]> {
  if (deps.ledger.getJournal(journalId) === undefined) return notFound(journalId);
  return ok(
    deps.ledger.journalHistory(journalId).flatMap((a): JournalHistoryEntry[] =>
      a.action === "create" || a.action === "correct" || a.action === "void"
        ? [
            {
              occurredAt: a.occurredAt,
              action: a.action,
              reason: a.reason,
              before: parseJournal(a.beforeJson),
              after: parseJournal(a.afterJson),
            },
          ]
        : [],
    ),
  );
}
