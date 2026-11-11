import type {
  ImportWarning,
  OpeningComparison,
  OpeningProposal,
  OpeningProposalRow,
} from "@trebuchet/schema";
import { type CarryForwardBalance, carryForward } from "../../carry-forward.ts";
import { validateOpeningBalances } from "../../opening.ts";
import { accountOrder, debitNet, type OpeningInput, toSide } from "../../reports/common.ts";
import { formatSignedAmount } from "../../reports/warnings.ts";
import { FREEE_UNMAPPABLE_ACCOUNTS } from "../../seed/freee-aliases.ts";
import { compareText } from "../../text.ts";
import {
  type Account,
  domainError,
  err,
  type FiscalPeriod,
  ok,
  type Result,
  type Side,
  type SubAccount,
} from "../../types.ts";
import type { AccountMapping } from "../types.ts";
import { isPriorYearClosing } from "./closing.ts";
import { proposeMappings, resolveLineAccount } from "./mapping.ts";
import type { FreeeLedgerAccount } from "./read.ts";

export type OpeningProposalInput = {
  fiscalYear: number;
  /** parseFreeeLedger の結果 */
  ledger: readonly FreeeLedgerAccount[];
  /** 保存済みの科目の対応表（初期案より優先する） */
  savedMappings: readonly AccountMapping[];
  accounts: readonly Account[];
  subAccounts: readonly SubAccount[];
  periods: readonly Pick<FiscalPeriod, "fiscalYear" | "startDate" | "endDate">[];
  /** 登録済みの期首残高（FR-020）。未登録なら空 */
  registered: readonly OpeningInput[];
  /** 前年度の期末の残高（FR-020a）。前年度の仕訳がなければ省略する */
  priorBalances?: readonly CarryForwardBalance[] | undefined;
};

/** 対応先の補助科目がまだない freee の科目（カードなど）。補助科目を作るまで案に含めない */
export type MissingSubAccount = { sourceName: string; accountId: string; subAccountName: string };

export type FreeeOpeningProposal = OpeningProposal & { missingSubAccounts: MissingSubAccount[] };

type Key = { accountId: string; subAccountId: string | null };
const keyOf = (k: Key) => JSON.stringify([k.accountId, k.subAccountId]);
const opposite = (side: Side): Side => (side === "debit" ? "credit" : "debit");

/**
 * 総勘定元帳から期首残高の案を作る（FR-019〜020a, research R5・R6, INV-16）。
 * 各科目の開始行の残高に、年初付の前年分の決算振替（決算整理仕訳 = 1 かつ 期首日の行）を繰り込み、「損益」は捨てる。
 * 対応表（保存済み > 初期案）で帳簿の科目・補助科目に置き換えて合算し、科目の通常の側を正として、
 * マイナスなら反対側の行にする（NEGATIVE_OPENING）。0 の行は作らない。
 * 対応が未定の科目・補助科目がまだない科目は unmapped に入れ、行に含めない（期首が 0 の科目は出さない）。
 * 行は 001 の validateOpeningBalances で検証する。貸借の不一致は totals で示し、失敗にしない。
 * 登録済みの期首残高（FR-020）と前年度の繰越（FR-020a, carryForward）を科目・補助科目ごとに比べ、
 * 繰越と違う科目に OPENING_DIFFERS_FROM_CARRY_FORWARD を付ける。
 * 会計期間がない年度・開始行の日付が会計期間の外なら OUT_OF_PERIOD
 */
export function proposeOpeningBalances(input: OpeningProposalInput): Result<FreeeOpeningProposal> {
  const { fiscalYear } = input;
  const period = input.periods.find((p) => p.fiscalYear === fiscalYear);
  if (period === undefined) {
    return err(domainError("OUT_OF_PERIOD", "会計期間が登録されていない年度です", { fiscalYear }));
  }
  const outside = input.ledger.find(
    (a) =>
      a.openingDate !== null &&
      (a.openingDate < period.startDate || a.openingDate > period.endDate),
  );
  if (outside !== undefined) {
    return err(
      domainError("OUT_OF_PERIOD", `${fiscalYear}年度の総勘定元帳ではありません`, {
        fiscalYear,
        startDate: period.startDate,
        endDate: period.endDate,
        ledgerDate: outside.openingDate,
      }),
    );
  }

  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const subAccounts = new Map(input.subAccounts.map((s) => [s.id, s]));
  const mappings = new Map(
    proposeMappings(
      { accounts: input.ledger.map((a) => a.accountName), taxes: [] },
      { accounts: input.savedMappings, taxes: [] },
      input.accounts,
      input.subAccounts,
      [],
    ).accounts.map((m) => [m.sourceName, m]),
  );

  // 帳簿の科目・補助科目ごとの、振替後の期首（借方を正）
  const sums = new Map<string, Key & { net: number; sourceNames: string[] }>();
  const unmapped: string[] = [];
  const missingSubAccounts: MissingSubAccount[] = [];
  for (const a of input.ledger) {
    if (FREEE_UNMAPPABLE_ACCOUNTS.includes(a.accountName)) continue;
    const row = mappings.get(a.accountName);
    const resolved =
      row === undefined
        ? undefined
        : resolveLineAccount(row, a.accountName, undefined, input.subAccounts);
    const book = resolved === undefined ? undefined : accounts.get(resolved.accountId);
    const freeeSide = a.normalSide ?? book?.normalSide ?? "debit";
    const transfer = a.rows
      .filter((r) => isPriorYearClosing(r, [period]))
      .reduce((s, r) => s + r.debit - r.credit, 0);
    const net = debitNet({ side: freeeSide, amount: a.opening }) + transfer;
    if (net === 0) continue;

    if (resolved === undefined || book === undefined) {
      unmapped.push(a.accountName);
      continue;
    }
    if (resolved.subAccountId === undefined && resolved.subAccountName !== undefined) {
      unmapped.push(a.accountName);
      missingSubAccounts.push({
        sourceName: a.accountName,
        accountId: resolved.accountId,
        subAccountName: resolved.subAccountName,
      });
      continue;
    }
    const k: Key = { accountId: resolved.accountId, subAccountId: resolved.subAccountId ?? null };
    const sum = sums.get(keyOf(k));
    if (sum === undefined) sums.set(keyOf(k), { ...k, net, sourceNames: [a.accountName] });
    else {
      sum.net += net;
      sum.sourceNames.push(a.accountName);
    }
  }

  const normalSideOf = (accountId: string): Side => accounts.get(accountId)?.normalSide ?? "debit";
  const signed = (k: Key, net: number) => toSide(net, normalSideOf(k.accountId)) + 0;
  const label = (k: Key) => {
    const name = accounts.get(k.accountId)?.name ?? k.accountId;
    const sub = k.subAccountId === null ? undefined : subAccounts.get(k.subAccountId)?.name;
    return sub === undefined ? name : `${name}（${sub}）`;
  };
  const compare = compareKeys(input.accounts, input.subAccounts);

  const warnings: ImportWarning[] = [];
  const rows: OpeningProposalRow[] = [];
  for (const s of [...sums.values()].sort(compare)) {
    const amount = signed(s, s.net);
    if (amount === 0) continue;
    const normal = normalSideOf(s.accountId);
    const side = amount > 0 ? normal : opposite(normal);
    rows.push({
      accountId: s.accountId,
      subAccountId: s.subAccountId,
      side,
      amount: Math.abs(amount),
      sourceNames: s.sourceNames,
    });
    if (amount < 0) {
      warnings.push({
        code: "NEGATIVE_OPENING",
        message: `「${label(s)}」の期首残高がマイナス（${formatSignedAmount(amount)}円）のため、${side === "debit" ? "借方" : "貸方"}の残高にしました`,
        details: {
          accountId: s.accountId,
          subAccountId: s.subAccountId,
          amount,
          sourceNames: s.sourceNames,
        },
      });
    }
  }

  const validated = validateOpeningBalances(rows);
  if (!validated.ok && validated.error.code !== "UNBALANCED") return validated;

  const sumSide = (side: Side) =>
    rows.filter((r) => r.side === side).reduce((t, r) => t + r.amount, 0);

  // 比べる値は、科目の通常の側を正とする符号つき
  const toSigned = (lines: readonly OpeningInput[]) => {
    const m = new Map<string, Key & { amount: number }>();
    for (const l of lines) {
      const k: Key = { accountId: l.accountId, subAccountId: l.subAccountId ?? null };
      const prev = m.get(keyOf(k));
      const amount = signed(k, debitNet(l));
      if (prev === undefined) m.set(keyOf(k), { ...k, amount });
      else prev.amount += amount;
    }
    return m;
  };
  const proposed = toSigned(rows);
  const registered = input.registered.length === 0 ? undefined : toSigned(input.registered);
  let carried: Map<string, Key & { amount: number }> | undefined;
  if (input.priorBalances !== undefined) {
    const cf = carryForward(input.priorBalances, input.accounts);
    if (!cf.ok) return cf;
    carried = toSigned(cf.value);
  }

  const keys = new Map<string, Key>();
  for (const m of [proposed, registered, carried]) {
    for (const [k, v] of m ?? []) if (v.amount !== 0) keys.set(k, v);
  }
  const comparisons: OpeningComparison[] = [...keys.entries()]
    .sort(([, a], [, b]) => compare(a, b))
    .map(([k, v]) => ({
      accountId: v.accountId,
      subAccountId: v.subAccountId,
      proposed: proposed.get(k)?.amount ?? 0,
      registered: registered === undefined ? null : (registered.get(k)?.amount ?? 0),
      carryForward: carried === undefined ? null : (carried.get(k)?.amount ?? 0),
    }));

  for (const c of comparisons) {
    if (c.carryForward === null || c.carryForward === c.proposed) continue;
    warnings.push({
      code: "OPENING_DIFFERS_FROM_CARRY_FORWARD",
      message: `「${label(c)}」の期首残高の案（${formatSignedAmount(c.proposed)}円）が、前年度の帳簿の繰越（${formatSignedAmount(c.carryForward)}円）と違います`,
      details: {
        accountId: c.accountId,
        subAccountId: c.subAccountId,
        proposed: c.proposed,
        carryForward: c.carryForward,
        diff: c.proposed - c.carryForward,
      },
    });
  }

  return ok({
    fiscalYear,
    rows,
    totals: { debit: sumSide("debit"), credit: sumSide("credit") },
    comparisons,
    unmapped,
    warnings,
    missingSubAccounts,
  });
}

/** 科目の順（sortOrder → コード）→ 補助科目なしが先 → 補助科目の名前 → ID */
function compareKeys(
  accounts: readonly Account[],
  subAccounts: readonly SubAccount[],
): (a: Key, b: Key) => number {
  const rank = accountOrder(accounts);
  const subNames = new Map(subAccounts.map((s) => [s.id, s.name]));
  return (a, b) => {
    const byAccount =
      rank(a.accountId) - rank(b.accountId) || compareText(a.accountId, b.accountId);
    if (byAccount !== 0) return byAccount;
    if (a.subAccountId === b.subAccountId) return 0;
    if (a.subAccountId === null) return -1;
    if (b.subAccountId === null) return 1;
    return (
      compareText(subNames.get(a.subAccountId) ?? "", subNames.get(b.subAccountId) ?? "") ||
      compareText(a.subAccountId, b.subAccountId)
    );
  };
}
