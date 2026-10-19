import type { MasterRepository, ReportRepository } from "../../src/ports.ts";
import type { OpeningBalance, PostedLine } from "../../src/types.ts";
import type { InMemoryLedgerRepository } from "../fakes.ts";

/** ReportRepository のフェイク: InMemoryLedgerRepository の有効な仕訳を行にする */
export class InMemoryReportRepository implements ReportRepository {
  private readonly ledger: InMemoryLedgerRepository;
  private readonly masters: MasterRepository;

  constructor(ledger: InMemoryLedgerRepository, masters: MasterRepository) {
    this.ledger = ledger;
    this.masters = masters;
  }

  linesInRange(from: string, to: string): PostedLine[] {
    const accounts = new Map(this.masters.listAccounts().map((a) => [a.id, a.name]));
    const subAccounts = new Map(this.masters.listSubAccounts().map((s) => [s.id, s.name]));
    const partners = new Map(this.masters.listPartners().map((p) => [p.id, p.name]));
    return this.ledger.journals
      .filter((j) => j.status === "active" && j.date >= from && j.date <= to)
      .flatMap((j) =>
        j.lines.map(
          (l): PostedLine => ({
            journalId: j.id,
            journalNo: j.journalNo,
            date: j.date,
            memo: j.memo,
            status: j.status,
            lineNo: l.lineNo,
            side: l.side,
            accountId: l.accountId,
            accountName: accounts.get(l.accountId) ?? "",
            subAccountId: l.subAccountId,
            subAccountName:
              l.subAccountId === null ? null : (subAccounts.get(l.subAccountId) ?? null),
            amount: l.amount,
            taxCategory: l.taxCategory,
            taxAmount: l.taxAmount,
            partnerId: l.partnerId,
            partnerName: l.partnerId === null ? null : (partners.get(l.partnerId) ?? null),
            description: l.description,
          }),
        ),
      );
  }

  openingBalances(fiscalYear: number): OpeningBalance[] {
    const period = this.masters.getFiscalPeriodByYear(fiscalYear);
    return period === undefined ? [] : this.masters.listOpeningBalances(period.id);
  }
}
