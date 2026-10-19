import type { ProfitAndLoss, StatementSection } from "@trebuchet/schema";
import type { Account, PostedLine } from "../types.ts";
import { debitNet, isActive, PL_SECTIONS, SECTION_SIDE, sectionRows, toSide } from "./common.ts";
import { compareFigure, compareSections } from "./statement.ts";

export type ProfitAndLossInput = {
  accounts: readonly Account[];
  lines: readonly PostedLine[];
  from: string;
  to: string;
};

const sum = (rows: readonly { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

/**
 * 損益計算書（FR-029）。区分（売上 → 売上原価 → 経費 → その他）ごとに科目を決算書の順に並べる。
 * 金額は区分の側（売上・その他は貸方、売上原価・経費は借方）を正とし、
 * 使用中の科目は 0 でも表示する。差引金額 = 売上 − 売上原価 − 経費 + その他
 */
export function buildProfitAndLoss(input: ProfitAndLossInput): ProfitAndLoss {
  const net = new Map<string, number>();
  for (const l of input.lines) {
    if (!isActive(l) || l.date < input.from || l.date > input.to) continue;
    net.set(l.accountId, (net.get(l.accountId) ?? 0) + debitNet(l));
  }
  const sections: StatementSection[] = PL_SECTIONS.flatMap((section) => {
    const rows = sectionRows(input.accounts, section, (id) =>
      toSide(net.get(id) ?? 0, SECTION_SIDE[section]),
    );
    return rows.length === 0 ? [] : [{ section, rows, total: { amount: sum(rows) } }];
  });
  const total = (section: string) => sections.find((s) => s.section === section)?.total.amount ?? 0;
  const netIncome = total("PL_SALES") - total("PL_COGS") - total("PL_EXPENSE") + total("PL_OTHER");
  return {
    kind: "profit-and-loss",
    from: input.from,
    to: input.to,
    previous: null,
    sections,
    grossProfit: { amount: total("PL_SALES") - total("PL_COGS") },
    netIncome: { amount: netIncome },
  };
}

/** 前年比較（FR-030）: 当年の各行・合計に前年と増減を付ける */
export function compareProfitAndLoss(
  current: ProfitAndLoss,
  previous: ProfitAndLoss,
  accounts: readonly Account[],
): ProfitAndLoss {
  return {
    ...current,
    previous: { from: previous.from, to: previous.to },
    sections: compareSections(PL_SECTIONS, current.sections, previous.sections, accounts),
    grossProfit: compareFigure(current.grossProfit, previous.grossProfit),
    netIncome: compareFigure(current.netIncome, previous.netIncome),
  };
}
