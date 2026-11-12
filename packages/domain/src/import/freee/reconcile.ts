import type {
  ImportReasonCode,
  ReconciliationCandidate,
  ReconciliationResult,
  ReconciliationRow,
} from "@trebuchet/schema";
import type { Balance } from "../../reports/balances.ts";
import { debitNet, sortAccounts, toSide } from "../../reports/common.ts";
import { FREEE_UNMAPPABLE_ACCOUNTS } from "../../seed/freee-aliases.ts";
import {
  type Account,
  domainError,
  err,
  type FiscalPeriod,
  ok,
  type Result,
  type SubAccount,
  validation,
} from "../../types.ts";
import type { AccountMapping, ImportRef } from "../types.ts";
import { isPriorYearClosing } from "./closing.ts";
import { proposeMappings, resolveLineAccount } from "./mapping.ts";
import type { FreeeLedgerAccount, FreeeLedgerRow } from "./read.ts";

/** 仕訳帳の取込の判定（excluded・rejected のみ）。原因の候補の分類に使う */
export type ReconcileDecision = {
  freeeJournalNo: string;
  decision: "excluded" | "rejected";
  reason?: ImportReasonCode | undefined;
};

export type ReconcileInput = {
  fiscalYear: number;
  /** parseFreeeLedger の結果 */
  ledger: readonly FreeeLedgerAccount[];
  /** 保存済みの科目の対応表（初期案より優先する） */
  savedMappings: readonly AccountMapping[];
  accounts: readonly Account[];
  subAccounts: readonly SubAccount[];
  periods: readonly Pick<FiscalPeriod, "fiscalYear" | "startDate" | "endDate">[];
  /** 帳簿の残高（001 の computeBalances。借方を正） */
  balances: readonly Balance[];
  /** その年度の取込の参照（取消済みを含む。取消済みは VOIDED_IMPORT の判定に使う） */
  refs: readonly ImportRef[];
  /** 同じ年度の仕訳帳の取込の判定（任意） */
  decisions?: readonly ReconcileDecision[] | undefined;
};

type Figures = ReconciliationRow["book"];
type DebitNetFigures = { opening: number; debit: number; credit: number; closing: number };

const zero = (): DebitNetFigures => ({ opening: 0, debit: 0, credit: 0, closing: 0 });
const isZero = (f: DebitNetFigures) =>
  f.opening === 0 && f.debit === 0 && f.credit === 0 && f.closing === 0;

/**
 * 総勘定元帳と帳簿の残高を、帳簿の科目ごと（補助科目は合算）に照合する（FR-021〜023, research R7, INV-14）。
 * 元帳の側は、期首 = 開始行 ＋ 期首日付の前年分の決算振替、借方・貸方 = 振替を除く行の合計、期末 = 最後の行の残高。
 * 対応表（保存済み > 初期案）で帳簿の科目に置き換えて合算し、金額は帳簿の科目の通常の側を正とする。
 * 「損益」は比べない。対応が未定の科目は unmapped に入れて比べない。
 * 不一致の行には、取り込まれていない元帳の行（振替を除く）を原因の候補として付ける。
 * 会計期間がない年度は OUT_OF_PERIOD、元帳の日付が会計期間の外なら VALIDATION
 */
export function reconcile(input: ReconcileInput): Result<ReconciliationResult> {
  const { fiscalYear } = input;
  const period = input.periods.find((p) => p.fiscalYear === fiscalYear);
  if (period === undefined) {
    return err(domainError("OUT_OF_PERIOD", "会計期間が登録されていない年度です", { fiscalYear }));
  }
  const inPeriod = (d: string) => d >= period.startDate && d <= period.endDate;
  for (const a of input.ledger) {
    const outside = [a.openingDate, ...a.rows.map((r) => r.date)].find(
      (d) => d !== null && !inPeriod(d),
    );
    if (outside !== undefined && outside !== null) {
      return validation(`${fiscalYear}年度の総勘定元帳ではありません`, {
        fiscalYear,
        startDate: period.startDate,
        endDate: period.endDate,
        ledgerDate: outside,
      });
    }
  }

  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const mappings = new Map(
    proposeMappings(
      { accounts: input.ledger.map((a) => a.accountName), taxes: [] },
      { accounts: input.savedMappings, taxes: [] },
      input.accounts,
      input.subAccounts,
      [],
    ).accounts.map((m) => [m.sourceName, m]),
  );

  // 元帳の側（帳簿の科目ごと、借方を正）
  const freee = new Map<string, DebitNetFigures>();
  const sources = new Map<string, { names: string[]; rows: FreeeLedgerRow[] }>();
  const unmapped: string[] = [];
  for (const a of input.ledger) {
    if (FREEE_UNMAPPABLE_ACCOUNTS.includes(a.accountName)) continue;
    const row = mappings.get(a.accountName);
    const resolved =
      row === undefined
        ? undefined
        : resolveLineAccount(row, a.accountName, undefined, input.subAccounts);
    const book = resolved === undefined ? undefined : accounts.get(resolved.accountId);
    const freeeSide = a.normalSide ?? book?.normalSide ?? "debit";

    const f = zero();
    f.opening = debitNet({ side: freeeSide, amount: a.opening });
    const movements: FreeeLedgerRow[] = [];
    for (const r of a.rows) {
      if (isPriorYearClosing(r, [period])) f.opening += r.debit - r.credit;
      else {
        f.debit += r.debit;
        f.credit += r.credit;
        movements.push(r);
      }
    }
    const last = a.rows.at(-1);
    f.closing =
      last === undefined
        ? debitNet({ side: freeeSide, amount: a.opening })
        : debitNet({ side: freeeSide, amount: last.balance });

    if (book === undefined) {
      if (!isZero(f)) unmapped.push(a.accountName);
      continue;
    }
    const sum = freee.get(book.id) ?? zero();
    sum.opening += f.opening;
    sum.debit += f.debit;
    sum.credit += f.credit;
    sum.closing += f.closing;
    freee.set(book.id, sum);
    const src = sources.get(book.id) ?? { names: [], rows: [] };
    src.names.push(a.accountName);
    src.rows.push(...movements);
    sources.set(book.id, src);
  }

  // 帳簿の側（補助科目を合算、借方を正）
  const bookFigures = new Map<string, DebitNetFigures>();
  for (const b of input.balances) {
    const sum = bookFigures.get(b.accountId) ?? zero();
    sum.opening += b.opening;
    sum.debit += b.debit;
    sum.credit += b.credit;
    sum.closing += b.closing;
    bookFigures.set(b.accountId, sum);
  }

  const active = new Set<string>();
  const revoked = new Set<string>();
  for (const r of input.refs) {
    if (r.freeeJournalNo === null) continue;
    (r.revokedAt === null ? active : revoked).add(r.freeeJournalNo);
  }
  const decisions = new Map((input.decisions ?? []).map((d) => [d.freeeJournalNo, d]));
  const candidateOf = (r: FreeeLedgerRow): ReconciliationCandidate | undefined => {
    if (r.journalNo !== null && active.has(r.journalNo)) return undefined;
    const base = { date: r.date, freeeJournalNo: r.journalNo, debit: r.debit, credit: r.credit };
    const d = r.journalNo === null ? undefined : decisions.get(r.journalNo);
    if (d !== undefined) {
      const cause = d.decision === "excluded" ? "EXCLUDED" : "REJECTED";
      return d.reason === undefined ? { ...base, cause } : { ...base, cause, reason: d.reason };
    }
    if (r.journalNo !== null && revoked.has(r.journalNo))
      return { ...base, cause: "VOIDED_IMPORT" };
    return { ...base, cause: "NOT_IMPORTED" };
  };

  const targets = sortAccounts(
    input.accounts.filter((a) => {
      if (freee.has(a.id)) return true;
      const b = bookFigures.get(a.id);
      return b !== undefined && !isZero(b);
    }),
  );
  const rows: ReconciliationRow[] = targets.map((account) => {
    const signed = (f: DebitNetFigures): Figures => ({
      opening: toSide(f.opening, account.normalSide) + 0,
      debit: f.debit,
      credit: f.credit,
      closing: toSide(f.closing, account.normalSide) + 0,
    });
    const book = signed(bookFigures.get(account.id) ?? zero());
    const theirs = signed(freee.get(account.id) ?? zero());
    const difference: Figures = {
      opening: book.opening - theirs.opening,
      debit: book.debit - theirs.debit,
      credit: book.credit - theirs.credit,
      closing: book.closing - theirs.closing,
    };
    const matched =
      difference.opening === 0 &&
      difference.debit === 0 &&
      difference.credit === 0 &&
      difference.closing === 0;
    const src = sources.get(account.id);
    const candidates = matched
      ? []
      : (src?.rows ?? []).flatMap((r) => {
          const c = candidateOf(r);
          return c === undefined ? [] : [c];
        });
    return {
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      sourceNames: src?.names ?? [],
      book,
      freee: theirs,
      matched,
      difference,
      candidates,
    };
  });

  return ok({ rows, allMatched: unmapped.length === 0 && rows.every((r) => r.matched), unmapped });
}
