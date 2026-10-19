import type { Account, FiscalPeriod, PostedLine } from "../../src/types.ts";
import { balancedLinesArb, dateInPeriodArb, fc } from "../arbitraries.ts";

/** 帳票のプロパティテストの入力: 取消フラグ付きの仕訳を PostedLine にしたもの */

export const PERIOD_2026 = {
  id: "period-2026",
  fiscalYear: 2026,
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  status: "open",
  closedAt: null,
} as const satisfies FiscalPeriod;

/** 仕訳の列（仕訳番号は 1 から順、取消済みを含む）を行にする */
export function postedLinesArb(
  accounts: readonly Account[],
  period: FiscalPeriod,
  length: { minLength?: number; maxLength: number },
): fc.Arbitrary<PostedLine[]> {
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  return fc
    .array(
      fc.record({
        date: dateInPeriodArb(period),
        lines: balancedLinesArb(accounts),
        voided: fc.boolean(),
      }),
      length,
    )
    .map((journals) =>
      journals.flatMap((j, index) =>
        j.lines.map(
          (l, i): PostedLine => ({
            journalId: `journal-${index + 1}`,
            journalNo: index + 1,
            date: j.date,
            memo: null,
            status: j.voided ? "voided" : "active",
            lineNo: i + 1,
            side: l.side,
            accountId: l.accountId,
            accountName: names.get(l.accountId) ?? "",
            subAccountId: null,
            subAccountName: null,
            amount: l.amount,
            taxCategory: "OUT_OF_SCOPE",
            taxAmount: 0,
            partnerId: null,
            partnerName: null,
            description: null,
          }),
        ),
      ),
    );
}

export const onlyActive = (lines: readonly PostedLine[]) =>
  lines.filter((l) => l.status === "active");

/** 1万件の仕訳（SC-003）。生成に時間がかかるため numRuns: 1 で使う */
export const TEN_THOUSAND = { minLength: 10_000, maxLength: 10_000 } as const;
