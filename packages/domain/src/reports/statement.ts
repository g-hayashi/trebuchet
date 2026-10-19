import type { Figure, StatementRow, StatementSection } from "@trebuchet/schema";
import type { Account, ReportSection } from "../types.ts";
import { sortAccounts, statementRow } from "./common.ts";

/** 前年比較の金額（増減 = 当年 − 前年） */
export const compareFigure = (current: Figure, previous: Figure): Figure => ({
  amount: current.amount,
  previous: previous.amount,
  change: current.amount - previous.amount,
});

/**
 * 区分ごとに当年と前年の行を突き合わせる（FR-030）。どちらかの年にある科目を科目順に並べ、
 * ない側の金額は 0 とする
 */
export function compareSections(
  order: readonly ReportSection[],
  current: readonly StatementSection[],
  previous: readonly StatementSection[],
  accounts: readonly Account[],
): StatementSection[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const zero = { amount: 0 };
  return order.flatMap((section) => {
    const cur = current.find((s) => s.section === section);
    const prev = previous.find((s) => s.section === section);
    if (cur === undefined && prev === undefined) return [];
    const amounts = (s: StatementSection | undefined) =>
      new Map((s?.rows ?? []).map((r) => [r.accountId, r.amount]));
    const curAmounts = amounts(cur);
    const prevAmounts = amounts(prev);
    const ids = new Set([...curAmounts.keys(), ...prevAmounts.keys()]);
    const known = sortAccounts([...ids].flatMap((id) => byId.get(id) ?? []));
    const rows = known.map(
      (a): StatementRow => ({
        ...statementRow(a, curAmounts.get(a.id) ?? 0),
        ...compareFigure(
          { amount: curAmounts.get(a.id) ?? 0 },
          { amount: prevAmounts.get(a.id) ?? 0 },
        ),
      }),
    );
    return [{ section, rows, total: compareFigure(cur?.total ?? zero, prev?.total ?? zero) }];
  });
}
