import type { BalanceSheet, StatementSection } from "@trebuchet/schema";
import type { Account, PostedLine } from "../types.ts";
import { balancesByAccount, computeBalances } from "./balances.ts";
import {
  BS_SECTIONS,
  isBsSection,
  type OpeningInput,
  SECTION_SIDE,
  sectionRows,
  sectionTotal,
  sumAmounts,
  toSide,
} from "./common.ts";
import { compareFigure, compareSections } from "./statement.ts";

export type BalanceSheetInput = {
  accounts: readonly Account[];
  opening: readonly OpeningInput[];
  lines: readonly PostedLine[];
  periodStart: string;
  asOf: string;
};

/**
 * 貸借対照表（FR-029, INV-5）: 基準日の残高。資産は借方、負債・純資産は貸方を正とする。
 * 当期利益（会計期間の開始日〜基準日の損益の貸方の純額）は純資産の部に含める（区分の total には含めない）
 */
export function buildBalanceSheet(input: BalanceSheetInput): BalanceSheet {
  const balances = balancesByAccount(
    computeBalances({ ...input, from: input.periodStart, to: input.asOf }),
  );
  const closing = (id: string) => balances.get(id)?.closing ?? 0;
  const sections: StatementSection[] = BS_SECTIONS.map((section) => {
    const rows = sectionRows(input.accounts, section, (id) =>
      toSide(closing(id), SECTION_SIDE[section]),
    );
    return { section, rows, total: { amount: sumAmounts(rows) } };
  });
  const netIncome = input.accounts
    .filter((a) => !isBsSection(a.reportSection))
    .reduce((s, a) => s - closing(a.id), 0);
  const total = (section: string) => sectionTotal(sections, section);
  const totalAssets = total("BS_ASSET");
  const totalLiabilitiesAndEquity = total("BS_LIABILITY") + total("BS_EQUITY") + netIncome;
  return {
    kind: "balance-sheet",
    asOf: input.asOf,
    previousAsOf: null,
    sections,
    netIncome: { amount: netIncome },
    totalAssets: { amount: totalAssets },
    totalLiabilitiesAndEquity: { amount: totalLiabilitiesAndEquity },
    balanced: totalAssets === totalLiabilitiesAndEquity,
  };
}

/** 前年比較（FR-030）: 当年の各行・合計に前年と増減を付ける */
export function compareBalanceSheet(
  current: BalanceSheet,
  previous: BalanceSheet,
  accounts: readonly Account[],
): BalanceSheet {
  return {
    ...current,
    previousAsOf: previous.asOf,
    sections: compareSections(BS_SECTIONS, current.sections, previous.sections, accounts),
    netIncome: compareFigure(current.netIncome, previous.netIncome),
    totalAssets: compareFigure(current.totalAssets, previous.totalAssets),
    totalLiabilitiesAndEquity: compareFigure(
      current.totalLiabilitiesAndEquity,
      previous.totalLiabilitiesAndEquity,
    ),
  };
}
