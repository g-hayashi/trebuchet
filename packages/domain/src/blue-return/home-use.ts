import type { AdjustmentProposal } from "@trebuchet/schema";
import { DRAWINGS_ACCOUNT_CODE } from "../carry-forward.ts";
import {
  type Account,
  type AdjustmentRef,
  domainError,
  err,
  type FiscalPeriod,
  type HomeUseAllocation,
  type LineDraft,
  ok,
  type PostedLine,
  type Result,
  type SubAccount,
} from "../types.ts";

const RATIO_DENOMINATOR = 10000;

export type HomeUseSplit = { business: number; home: number };

/**
 * 按分の事業分と家事分（R5、INV-20）。割合は万分率（0〜10000 の整数）。
 * 事業分 = ⌊帳簿の金額 × 割合 / 10000⌋、家事分 = 帳簿の金額 − 事業分。
 * 帳簿の金額が 0 以下なら按分しない（どちらも 0。案を作らない）。
 * 金額 × 割合 は安全な整数の範囲を超え得るので、金額を 10000 の商と余りに分けて掛ける
 * （商 × 割合 ≤ 金額、余り × 割合 < 10^8 で、どちらも厳密な整数）
 */
export function computeHomeUse(bookAmount: number, ratio: number): HomeUseSplit {
  if (!Number.isInteger(ratio) || ratio < 0 || ratio > RATIO_DENOMINATOR) {
    throw new RangeError(`按分の割合は 0〜10000 の整数です: ${ratio}`);
  }
  if (!Number.isSafeInteger(bookAmount)) {
    throw new RangeError(`帳簿の金額は安全な整数です: ${bookAmount}`);
  }
  if (bookAmount <= 0) return { business: 0, home: 0 };
  const quotient = Math.floor(bookAmount / RATIO_DENOMINATOR);
  const remainder = bookAmount - quotient * RATIO_DENOMINATOR;
  const business = quotient * ratio + Math.floor((remainder * ratio) / RATIO_DENOMINATOR);
  return { business, home: bookAmount - business };
}

/** 按分の登録の入力（ID と日時は保存するユースケースが付ける） */
export type HomeUseAllocationDraft = {
  fiscalYear: number;
  accountId: string;
  subAccountId: string | null;
  businessRatio: number;
  basis: string;
  changeReason: string | null;
};

const blankToNull = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

/**
 * 按分の登録を検証する（FR-012〜013）。対象は区分が費用の科目（HOME_USE_ACCOUNT_INVALID）、
 * 補助科目はその科目のもの、割合は 0〜10000 の整数、根拠は必須（HOME_USE_BASIS_REQUIRED）、
 * 前の年度の同じ科目（補助科目）と割合が違えば理由が必須（HOME_USE_CHANGE_REASON_REQUIRED）。
 * 根拠・理由は前後の空白を除き、空の理由は null にした入力を返す
 */
export function validateHomeUseAllocation(
  draft: HomeUseAllocationDraft,
  ctx: {
    accounts: readonly Account[];
    subAccounts: readonly SubAccount[];
    previous: Pick<HomeUseAllocation, "businessRatio"> | undefined;
  },
): Result<HomeUseAllocationDraft> {
  const account = ctx.accounts.find((a) => a.id === draft.accountId);
  if (account === undefined || account.category !== "expense") {
    return err(
      domainError("HOME_USE_ACCOUNT_INVALID", "家事按分の対象は区分が費用の科目に限ります", {
        field: "accountId",
        accountId: draft.accountId,
        allowedCategory: "expense",
      }),
    );
  }
  if (draft.subAccountId !== null) {
    const sub = ctx.subAccounts.find((s) => s.id === draft.subAccountId);
    if (sub === undefined || sub.accountId !== draft.accountId) {
      return err(
        domainError("VALIDATION", "補助科目がこの勘定科目のものではありません", {
          field: "subAccountId",
        }),
      );
    }
  }
  if (
    !Number.isInteger(draft.businessRatio) ||
    draft.businessRatio < 0 ||
    draft.businessRatio > RATIO_DENOMINATOR
  ) {
    return err(
      domainError("VALIDATION", "事業専用割合は 0〜100% で入力してください", {
        field: "businessRatio",
      }),
    );
  }
  const basis = blankToNull(draft.basis);
  if (basis === null) {
    return err(
      domainError("HOME_USE_BASIS_REQUIRED", "按分の根拠を入力してください", { field: "basis" }),
    );
  }
  const changeReason = blankToNull(draft.changeReason);
  if (
    ctx.previous !== undefined &&
    ctx.previous.businessRatio !== draft.businessRatio &&
    changeReason === null
  ) {
    return err(
      domainError(
        "HOME_USE_CHANGE_REASON_REQUIRED",
        "前の年度と事業専用割合が違います。変更の理由を入力してください",
        { field: "changeReason", previousRatio: ctx.previous.businessRatio },
      ),
    );
  }
  return ok({ ...draft, basis, changeReason });
}

/** 案を作らない理由 */
export type HomeUseNoProposalReason =
  /** 帳簿の金額が 0 以下で、登録済みの振替もない */
  | "BOOK_AMOUNT_NOT_POSITIVE"
  /** 割合 10000（按分なし）で、登録済みの振替もない */
  | "FULL_BUSINESS"
  /** 登録済みの振替が期待される家事分と一致している */
  | "UP_TO_DATE";

export type HomeUseInput = {
  allocation: HomeUseAllocation;
  /** 同じ年度の按分の登録（allocation を含む）。科目全体の按分から、補助科目ごとの按分の行を除くのに使う */
  allocations: readonly HomeUseAllocation[];
  accounts: readonly Account[];
  period: Pick<FiscalPeriod, "endDate">;
  /** 年度の仕訳の行（取消済みの仕訳の行は含まれていても除く） */
  lines: readonly PostedLine[];
  /** 年度の決算整理の仕訳の出所 */
  refs: readonly AdjustmentRef[];
};

/** 按分の評価。difference = home − registered（正なら振替が足りない、負なら多すぎる） */
export type HomeUseAssessment = {
  allocationId: string;
  bookAmount: number;
  ratio: number;
  business: number;
  /** 期待される家事分 */
  home: number;
  /** 登録済みの有効な振替の合計（対象の科目の貸方 − 借方。逆向きの振替は負で数える） */
  registered: number;
  difference: number;
  proposal: AdjustmentProposal | null;
  reason: HomeUseNoProposalReason | null;
};

/**
 * 按分の振替の案（FR-014・FR-016、R4〜R6、INV-23）。
 * 帳簿の金額 = 対象の科目（補助科目）の年間の借方 − 貸方。ただし home_use の出所を持つ仕訳
 * （どの按分のものでも）の行は除く。科目全体の按分（補助科目なし）は、同じ年度に補助科目ごとの
 * 按分がある補助科目の行も除く。登録済みの振替 = この按分の出所を持つ有効な仕訳の、対象の科目の
 * 貸方 − 借方。差額 = 期待される家事分 − 登録済みの振替。差額が正なら「事業主貸 / 対象の科目」、
 * 負なら「対象の科目 / 事業主貸」、金額は差額の絶対値で、日付は年度末日。差額 0 なら案なし
 */
export function proposeHomeUseAdjustment(input: HomeUseInput): Result<HomeUseAssessment> {
  const { allocation } = input;
  const account = input.accounts.find((a) => a.id === allocation.accountId);
  if (account === undefined || account.category !== "expense") {
    return err(
      domainError("HOME_USE_ACCOUNT_INVALID", "家事按分の対象は区分が費用の科目に限ります", {
        accountId: allocation.accountId,
        allocationId: allocation.id,
      }),
    );
  }
  const drawings = input.accounts.find((a) => a.code === DRAWINGS_ACCOUNT_CODE);
  if (drawings === undefined) {
    return err(
      domainError("ACCOUNT_NOT_FOUND", "事業主貸の科目（3090）がありません", {
        code: DRAWINGS_ACCOUNT_CODE,
      }),
    );
  }

  const homeUseJournals = new Set(
    input.refs.filter((r) => r.kind === "home_use").map((r) => r.journalId),
  );
  const ownJournals = new Set(
    input.refs
      .filter((r) => r.kind === "home_use" && r.allocationId === allocation.id)
      .map((r) => r.journalId),
  );
  const siblingSubs = new Set(
    input.allocations
      .filter(
        (a) =>
          a.id !== allocation.id && a.accountId === allocation.accountId && a.subAccountId !== null,
      )
      .map((a) => a.subAccountId),
  );
  const inScope = (l: PostedLine) =>
    allocation.subAccountId !== null
      ? l.subAccountId === allocation.subAccountId
      : l.subAccountId === null || !siblingSubs.has(l.subAccountId);
  const targetLines = input.lines.filter(
    (l) => l.status === "active" && l.accountId === allocation.accountId && inScope(l),
  );
  const signed = (l: PostedLine) => (l.side === "debit" ? l.amount : -l.amount);

  const bookAmount = targetLines
    .filter((l) => !homeUseJournals.has(l.journalId))
    .reduce((s, l) => s + signed(l), 0);
  const registered = targetLines
    .filter((l) => ownJournals.has(l.journalId))
    .reduce((s, l) => s - signed(l), 0);
  const ratio = allocation.businessRatio;
  const { business, home } = computeHomeUse(bookAmount, ratio);
  const difference = home - registered;

  const base = { allocationId: allocation.id, bookAmount, ratio, business, home, registered };
  if (difference === 0) {
    const reason: HomeUseNoProposalReason =
      registered === 0 && bookAmount <= 0
        ? "BOOK_AMOUNT_NOT_POSITIVE"
        : registered === 0 && ratio === RATIO_DENOMINATOR
          ? "FULL_BUSINESS"
          : "UP_TO_DATE";
    return ok({ ...base, difference, proposal: null, reason });
  }

  const amount = Math.abs(difference);
  const target: LineDraft = {
    side: difference > 0 ? "credit" : "debit",
    accountId: allocation.accountId,
    ...(allocation.subAccountId === null ? {} : { subAccountId: allocation.subAccountId }),
    amount,
  };
  const owner: LineDraft = {
    side: difference > 0 ? "debit" : "credit",
    accountId: drawings.id,
    amount,
  };
  const percent = `${ratio / 100}%`;
  return ok({
    ...base,
    difference,
    reason: null,
    proposal: {
      kind: "home_use",
      sourceId: allocation.id,
      journal: {
        date: input.period.endDate,
        memo:
          difference > 0
            ? `家事按分の振替（${account.name} 事業専用割合 ${percent}）`
            : `家事按分の振替の戻し（${account.name} 事業専用割合 ${percent}）`,
        lines: [owner, target].sort((a, b) =>
          a.side === b.side ? 0 : a.side === "debit" ? -1 : 1,
        ),
      },
      breakdown: { bookAmount, ratio, business, home },
    },
  });
}
