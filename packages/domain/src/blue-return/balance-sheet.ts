import {
  ACCOUNT_CODES,
  type BlueReturn,
  type BlueReturnWarning,
  type CarryForwardCheck,
} from "@trebuchet/schema";
import {
  type CarryForwardBalance,
  DRAWINGS_ACCOUNT_CODE,
  OWNER_LOAN_ACCOUNT_CODE,
} from "../carry-forward.ts";
import { buildBalanceSheet } from "../reports/balance-sheet.ts";
import { balancesByAccount, computeBalances } from "../reports/balances.ts";
import {
  debitNet,
  isBsSection,
  type OpeningInput,
  SECTION_SIDE,
  sortAccounts,
  toSide,
} from "../reports/common.ts";
import { detectWarnings, formatSignedAmount } from "../reports/warnings.ts";
import type { Account, ClosingNote, FiscalPeriod, PostedLine } from "../types.ts";
import type { BlueReturnForm, BsSide } from "./form.ts";
import { checkOpeningCarryForward } from "./opening-check.ts";

/** 繰延資産の科目コード（初期セットの開業費。R8） */
export const DEFERRED_ASSET_CODES: readonly string[] = [ACCOUNT_CODES.startupCosts];

/** 空欄の行からあふれた科目をまとめる行の科目名 */
export const BS_OVERFLOW_LABEL = "その他";

/** 前の年度（帳簿があるときだけ渡す） */
export type PriorPeriod = {
  fiscalYear: number;
  status: FiscalPeriod["status"];
  /** 前の年度の期末の残高（computeBalances の結果。closing は借方を正） */
  closing: readonly CarryForwardBalance[];
};

export type Page4Input = {
  form: BlueReturnForm;
  period: FiscalPeriod;
  accounts: readonly Account[];
  opening: readonly OpeningInput[];
  lines: readonly PostedLine[];
  priorPeriod: PriorPeriod | null;
  closingNotes: readonly ClosingNote[];
  /**
   * その年度の償却額の決定（0 円を含む）がある開業費の勘定の ID（009 FR-015、R10）。
   * その勘定には DEFERRED_ASSET_NOT_AMORTIZED を出さない。なければ空
   */
  deferredDecidedAccountIds?: readonly string[];
};

type Page4 = BlueReturn["page4"];
type BsRowOutput = Page4["opening"]["assets"]["rows"][number];

/** 科目の置き場所: 様式の行（index）、空欄の行の候補（side）、所得（損益の科目） */
type Placement =
  | { kind: "row"; index: number }
  | { kind: "blank"; side: BsSide }
  | { kind: "income" };

const sideSign = (side: BsSide) => (side === "asset" ? "debit" : "credit");

/** 借方を正とする科目ごとの期首残高（補助科目は合算） */
function openingByAccount(opening: readonly OpeningInput[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of opening) m.set(o.accountId, (m.get(o.accountId) ?? 0) + debitNet(o));
  return m;
}

/**
 * 決算書4ページ（貸借対照表）を作る（FR-028〜031, R8, INV-19）。
 *
 * - 期首は期首残高、期末は 001 の buildBalanceSheet（年度末日）。科目は様式の行へ R2 の科目コードでまとめる
 * - 行の金額は、資産の側は借方、負債・資本の側は貸方を正とする（事業主貸は資産の側、事業主借は負債・資本の側）
 * - 所得の行: 期末は buildBalanceSheet の netIncome（= 欄43。期首に損益の残高があればそれを含む）。
 *   期首は期首残高の損益（通常 0 で空欄）
 * - 事業主貸・事業主借の行: 期首残高が 0 なら空欄（null）。0 でなければ金額を出して OPENING_OWNER_ACCOUNTS
 *   （期首の損益の残高も同じ警告に含める。どれも元入金に繰り込む額）
 * - 様式に行のない科目（blankRowAccountCodes と、利用者が足した科目）は、区分の空欄の行に科目名つきで出す。
 *   期首・期末のどちらかが 0 でない科目だけを科目順に詰め、期首と期末で同じ行に置く。空欄の行の数を超えたら、
 *   最後の空欄の行に「その他」として残りを合算し（金額を落とさない）、OPTIONAL_LINES_OVERFLOW（page: 4）で知らせる
 * - どの科目も、様式の行・空欄の行・所得のどれか1つにだけ入るので、表示した金額で
 *   資産合計 = 負債・資本合計（期首残高と仕訳の貸借が一致していれば）
 */
export function buildPage4(input: Page4Input): { page4: Page4; warnings: BlueReturnWarning[] } {
  const { form, period, accounts } = input;
  const rowByCode = new Map<string, number>();
  form.bsRows.forEach((row, index) => {
    if (row.kind === "account") for (const code of row.accountCodes) rowByCode.set(code, index);
  });
  const blankSideByCode = new Map<string, BsSide>();
  for (const side of ["asset", "liability_equity"] as const) {
    for (const code of form.blankRowAccountCodes[side]) blankSideByCode.set(code, side);
  }
  const placementOf = (a: Account): Placement => {
    if (!isBsSection(a.reportSection)) return { kind: "income" };
    const index = rowByCode.get(a.code);
    if (index !== undefined) return { kind: "row", index };
    const side =
      blankSideByCode.get(a.code) ??
      (a.reportSection === "BS_ASSET" ? "asset" : "liability_equity");
    return { kind: "blank", side };
  };

  // 期首・期末の科目ごとの残高（借方を正）
  const openingNet = openingByAccount(input.opening);
  const bs = buildBalanceSheet({
    accounts,
    opening: input.opening,
    lines: input.lines,
    periodStart: period.startDate,
    asOf: period.endDate,
  });
  const closingNet = new Map<string, number>();
  for (const section of bs.sections) {
    for (const row of section.rows) {
      closingNet.set(row.accountId, toSide(row.amount, SECTION_SIDE[section.section]));
    }
  }

  // 空欄の行の割り当て
  const sorted = sortAccounts(accounts);
  const blankSlots = (side: BsSide) =>
    form.bsRows.flatMap((row, i) => (row.kind === "blank" && row.side === side ? [i] : []));
  /** 行の index → その行に入る科目 */
  const accountsAt = new Map<number, Account[]>();
  const blankLabel = new Map<number, string>();
  const overflowWarnings: BlueReturnWarning[] = [];
  /** 空欄の行がない様式であふれた科目（側の末尾に「その他」の行を足す） */
  const appended = new Map<BsSide, Account[]>();
  for (const side of ["asset", "liability_equity"] as const) {
    const candidates = sorted.filter((a) => {
      const p = placementOf(a);
      return (
        p.kind === "blank" &&
        p.side === side &&
        ((openingNet.get(a.id) ?? 0) !== 0 || (closingNet.get(a.id) ?? 0) !== 0)
      );
    });
    const slots = blankSlots(side);
    const fits = candidates.length <= slots.length;
    const own = fits ? candidates : candidates.slice(0, Math.max(0, slots.length - 1));
    own.forEach((a, i) => {
      const slot = slots[i] as number;
      accountsAt.set(slot, [a]);
      blankLabel.set(slot, a.name);
    });
    if (fits) continue;
    const rest = candidates.slice(own.length);
    const last = slots[slots.length - 1];
    if (last === undefined) appended.set(side, rest);
    else {
      accountsAt.set(last, rest);
      blankLabel.set(last, BS_OVERFLOW_LABEL);
    }
    overflowWarnings.push({
      code: "OPTIONAL_LINES_OVERFLOW",
      message: `4ページの${side === "asset" ? "資産" : "負債・資本"}の空欄の行（${slots.length} 行）に科目が載りきりません。${rest.length} 科目を「${BS_OVERFLOW_LABEL}」にまとめました（金額は合計に含めています）: ${rest.map((a) => a.name).join("、")}`,
      details: {
        page: 4,
        side,
        count: candidates.length,
        capacity: slots.length,
        omitted: rest.map((a) => ({
          accountId: a.id,
          name: a.name,
          amount: toSide(closingNet.get(a.id) ?? 0, sideSign(side)),
        })),
      },
    });
  }
  for (const a of accounts) {
    const p = placementOf(a);
    if (p.kind === "row") accountsAt.set(p.index, [...(accountsAt.get(p.index) ?? []), a]);
  }

  // 期首の損益（通常 0）。buildBalanceSheet と同じく、科目の一覧にある科目だけを数える
  const openingIncome = accounts
    .filter((a) => placementOf(a).kind === "income")
    .reduce((s, a) => s - (openingNet.get(a.id) ?? 0), 0);
  const isOwnerRow = (codes: readonly string[]) =>
    codes.includes(DRAWINGS_ACCOUNT_CODE) || codes.includes(OWNER_LOAN_ACCOUNT_CODE);

  const sideOutput = (side: BsSide, when: "opening" | "closing"): Page4["opening"]["assets"] => {
    const net = when === "opening" ? openingNet : closingNet;
    const amountOf = (list: readonly Account[]) =>
      list.reduce((s, a) => s + toSide(net.get(a.id) ?? 0, sideSign(side)), 0);
    const rows: BsRowOutput[] = [];
    form.bsRows.forEach((row, index) => {
      if (row.side !== side) return;
      const placed = accountsAt.get(index) ?? [];
      if (row.kind === "income") {
        const income = when === "closing" ? bs.netIncome.amount : openingIncome;
        rows.push({ label: row.label, amount: when === "opening" && income === 0 ? null : income });
      } else if (row.kind === "blank") {
        rows.push(
          placed.length === 0
            ? { label: "", amount: null }
            : { label: blankLabel.get(index) ?? "", amount: amountOf(placed) },
        );
      } else {
        const amount = amountOf(placed);
        const blankAtOpening = when === "opening" && amount === 0 && isOwnerRow(row.accountCodes);
        rows.push({ label: row.label, amount: blankAtOpening ? null : amount });
      }
    });
    const extra = appended.get(side);
    if (extra !== undefined) rows.push({ label: BS_OVERFLOW_LABEL, amount: amountOf(extra) });
    return { rows, total: rows.reduce((s, r) => s + (r.amount ?? 0), 0) };
  };

  const warnings: BlueReturnWarning[] = [...overflowWarnings];

  // 期首の事業主貸・事業主借・損益（元入金に繰り込む額）
  const ownerAtOpening = sortAccounts(
    accounts.filter(
      (a) =>
        (a.code === DRAWINGS_ACCOUNT_CODE ||
          a.code === OWNER_LOAN_ACCOUNT_CODE ||
          placementOf(a).kind === "income") &&
        (openingNet.get(a.id) ?? 0) !== 0,
    ),
  );
  if (ownerAtOpening.length > 0) {
    warnings.push({
      code: "OPENING_OWNER_ACCOUNTS",
      message: `期首残高に${ownerAtOpening.map((a) => a.name).join("・")}の残高があります。前の年度の事業主貸・事業主借・所得は元入金に繰り込んでください`,
      details: {
        accounts: ownerAtOpening.map((a) => ({
          accountId: a.id,
          accountName: a.name,
          amount: toSide(openingNet.get(a.id) ?? 0, a.normalSide),
        })),
      },
    });
  }

  // 元入金の繰越の検査（前の年度の帳簿があるときだけ）
  const note =
    input.closingNotes.find((n) => n.kind === "opening_difference" && n.body.trim() !== "")?.body ??
    null;
  let carryForwardCheck: CarryForwardCheck = "no_prior_year";
  const prior = input.priorPeriod;
  if (prior !== null) {
    const checked = checkOpeningCarryForward(prior.closing, input.opening, accounts);
    const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? "";
    if (!checked.ok) {
      carryForwardCheck = "mismatched";
      warnings.push({
        code: "OPENING_MISMATCH",
        message: `前の年度の期末から期首を求められません: ${checked.error.message}`,
        details: { errorCode: checked.error.code, note },
      });
    } else {
      carryForwardCheck = checked.value.length === 0 ? "matched" : "mismatched";
      for (const m of checked.value) {
        const accountName = nameOf(m.accountId);
        warnings.push({
          code: "OPENING_MISMATCH",
          message: `「${accountName}」の期首残高（${formatSignedAmount(m.actual)} 円）が、前の年度の期末から求めた値（${formatSignedAmount(m.expected)} 円）と違います（差額 ${formatSignedAmount(m.diff)} 円）`,
          details: {
            accountId: m.accountId,
            accountName,
            expected: m.expected,
            actual: m.actual,
            diff: m.diff,
            note,
          },
        });
      }
    }
    if (prior.status === "open") {
      warnings.push({
        code: "PRIOR_PERIOD_OPEN",
        message: `前の年度（${prior.fiscalYear}年度）は締め前です。繰越の検査は締め前の帳簿で行っています`,
        details: { fiscalYear: prior.fiscalYear },
      });
    }
  }

  // 負の残高（001 の判定）と、償却していない繰延資産
  const closingBalances = computeBalances({
    opening: input.opening,
    lines: input.lines,
    periodStart: period.startDate,
    to: period.endDate,
  });
  for (const w of detectWarnings(closingBalances, accounts)) {
    if (w.code === "NEGATIVE_BALANCE") {
      warnings.push({ code: "NEGATIVE_BALANCE", message: w.message, details: w.details });
    }
  }
  const byAccount = balancesByAccount(closingBalances);
  const decidedAccounts = new Set(input.deferredDecidedAccountIds ?? []);
  for (const a of sorted) {
    if (a.category !== "asset" || !DEFERRED_ASSET_CODES.includes(a.code)) continue;
    if (decidedAccounts.has(a.id)) continue;
    const b = byAccount.get(a.id);
    if (b === undefined || b.closing === 0 || b.opening !== b.closing) continue;
    warnings.push({
      code: "DEFERRED_ASSET_NOT_AMORTIZED",
      message: `${a.name}（繰延資産）の残高 ${formatSignedAmount(toSide(b.closing, a.normalSide))} 円が期首から変わっていません。償却するかどうかを検討してください`,
      details: { accountId: a.id, accountName: a.name, amount: toSide(b.closing, a.normalSide) },
    });
  }

  return {
    page4: {
      opening: {
        assets: sideOutput("asset", "opening"),
        liabilityEquity: sideOutput("liability_equity", "opening"),
      },
      closing: {
        assets: sideOutput("asset", "closing"),
        liabilityEquity: sideOutput("liability_equity", "closing"),
      },
      carryForwardCheck,
      openingDifferenceNote: note,
    },
    warnings,
  };
}
