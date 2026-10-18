import { combineErrors, type JournalContext, validateJournal } from "../journal.ts";
import type { Clock, IdGenerator, JournalRepository, MasterRepository } from "../ports.ts";
import {
  type DomainWarning,
  domainError,
  err,
  type Journal,
  type JournalDraft,
  type JournalLine,
  ok,
  type Result,
  type ValidLine,
} from "../types.ts";

/** 仕訳のユースケースの依存。ledger と masters は同じテナントの DB */
export type JournalDeps = {
  ledger: JournalRepository;
  masters: MasterRepository;
  ids: IdGenerator;
  clock: Clock;
};

export type CreatedJournal = { journal: Journal; warnings: DomainWarning[] };

function loadContext(masters: MasterRepository): JournalContext {
  return {
    accounts: masters.listAccounts(),
    subAccounts: masters.listSubAccounts(),
    partners: masters.listPartners(),
    tags: masters.listTags(),
    periods: masters.listFiscalPeriods(),
    taxSettings: masters.listTaxSettings(),
    taxRates: masters.listTaxRates(),
  };
}

const lineKeys = (lines: readonly Pick<ValidLine, "side" | "accountId" | "amount">[]) =>
  lines
    .map((l) => `${l.side}:${l.accountId}:${l.amount}`)
    .sort()
    .join("|");

/** 直前の仕訳と日付・科目・金額の組が同じなら重複の候補（FR-018） */
function duplicateWarning(
  previous: Journal | undefined,
  date: string,
  lines: readonly ValidLine[],
): DomainWarning[] {
  if (
    previous === undefined ||
    previous.status !== "active" ||
    previous.date !== date ||
    lineKeys(previous.lines) !== lineKeys(lines)
  ) {
    return [];
  }
  return [
    {
      code: "POSSIBLE_DUPLICATE",
      message: `直前の仕訳（No.${previous.journalNo}）と日付・科目・金額が同じです。二重登録でないか確認してください`,
      details: { journalId: previous.id, journalNo: previous.journalNo },
    },
  ];
}

/**
 * 仕訳を登録する（US2, FR-013〜018）。
 * 検証・採番・保存・監査ログの記録を1つのトランザクションで行い、違反があれば何も書き込まない
 */
export function createJournal(deps: JournalDeps, draft: JournalDraft): Result<CreatedJournal> {
  return deps.ledger.transaction((tx) => {
    const validated = validateJournal(draft, loadContext(deps.masters));
    if (!validated.ok) return err(combineErrors(validated.error));
    const valid = validated.value;

    if (valid.correctsJournalId !== null && tx.getJournal(valid.correctsJournalId) === undefined) {
      return err(
        domainError("VALIDATION", "訂正元の仕訳が見つかりません", {
          field: "correctsJournalId",
        }),
      );
    }

    const warnings = duplicateWarning(tx.lastJournal(), valid.date, valid.lines);
    const now = deps.clock.now();
    const id = deps.ids.next();
    const lines: JournalLine[] = valid.lines.map((l) => ({ ...l, id: deps.ids.next() }));
    const journal = tx.insertJournal({
      ...valid,
      id,
      journalNo: tx.nextJournalNo(),
      createdAt: now,
      lines,
    });
    tx.appendAudit({
      id: deps.ids.next(),
      occurredAt: now,
      targetType: "journal",
      targetId: journal.id,
      action: "create",
      reason: null,
      beforeJson: null,
      afterJson: JSON.stringify(journal),
    });
    return ok({ journal, warnings });
  });
}
