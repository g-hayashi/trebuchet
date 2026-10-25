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
  type JournalSource,
  ok,
  type Partner,
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

/** 仕訳の登録のオプション。`source` の既定は `manual`（005 R9） */
export type CreateJournalOptions = { source?: JournalSource };

/** 請求書・入金に結びついた仕訳か。これらは請求・入金の取消の経路でしか訂正・取消できない（005 R13） */
export const isLinkedSource = (source: JournalSource): boolean =>
  source === "invoice" || source === "payment";

/** 請求・入金の仕訳を通常の訂正・取消から守る。`invoiceId` などは server のルート層が補う */
export const linkedError = (journalId: string): DomainError =>
  domainError(
    "JOURNAL_LINKED",
    "請求書・入金に結びついた仕訳は、ここでは訂正・取消できません。請求書・入金の画面から取り消してください",
    { journalId },
  );

/** 取引先は使用停止の情報（`isActive`）も持つ（定期仕訳の判定が使う。005 R17） */
export function loadContext(
  masters: MasterRepository,
): JournalContext & { partners: readonly Partner[] } {
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
  source: JournalSource = "manual",
): DomainError | undefined {
  const target = ledger.getJournal(correctsJournalId);
  if (target === undefined) {
    return domainError("VALIDATION", "訂正元の仕訳が見つかりません", {
      field: "correctsJournalId",
    });
  }
  // 請求・入金の仕訳は、同じ source の仕訳（請求・入金の取消）だけが訂正元にできる（005 R13）
  if (isLinkedSource(target.source) && target.source !== source) {
    return linkedError(target.id);
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
export function createJournal(
  deps: JournalDeps,
  draft: JournalDraft,
  options: CreateJournalOptions = {},
): Result<CreatedJournal> {
  const source = options.source ?? "manual";
  return deps.ledger.transaction((tx) => {
    const ctx = loadContext(deps.masters);
    const validated = validateJournal(draft, ctx);
    if (!validated.ok) return err(combineErrors(validated.error));
    const valid = validated.value;

    if (valid.correctsJournalId !== null) {
      const targetError = checkCorrectsTarget(tx, valid.correctsJournalId, ctx, source);
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
      source,
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
