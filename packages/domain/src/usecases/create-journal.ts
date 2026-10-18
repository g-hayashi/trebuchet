import { checkPeriod, combineErrors, type JournalContext, validateJournal } from "../journal.ts";
import type { Clock, IdGenerator, JournalRepository, MasterRepository } from "../ports.ts";
import {
  type DomainError,
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

export function loadContext(masters: MasterRepository): JournalContext {
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

/**
 * 訂正仕訳の訂正元（FR-019a）。訂正元は存在し、締め済みの期間の仕訳でなければならない
 * （締めていない期間の仕訳は、訂正・取消で直す）
 */
export function checkCorrectsTarget(
  ledger: Pick<JournalRepository, "getJournal">,
  correctsJournalId: string,
  ctx: Pick<JournalContext, "periods">,
): DomainError | undefined {
  const target = ledger.getJournal(correctsJournalId);
  if (target === undefined) {
    return domainError("VALIDATION", "訂正元の仕訳が見つかりません", {
      field: "correctsJournalId",
    });
  }
  const period = checkPeriod(target.date, ctx.periods);
  if (period.ok || period.error.code !== "PERIOD_CLOSED") {
    return domainError("VALIDATION", "訂正仕訳は締め済みの年度の仕訳にだけ起票できます", {
      field: "correctsJournalId",
    });
  }
  return undefined;
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
    const ctx = loadContext(deps.masters);
    const validated = validateJournal(draft, ctx);
    if (!validated.ok) return err(combineErrors(validated.error));
    const valid = validated.value;

    if (valid.correctsJournalId !== null) {
      const targetError = checkCorrectsTarget(tx, valid.correctsJournalId, ctx);
      if (targetError !== undefined) return err(targetError);
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
