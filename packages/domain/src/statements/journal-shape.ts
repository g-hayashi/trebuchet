import {
  type Purpose,
  type StatementAccount,
  type TaxCategoryCode,
  YEN_LIMIT,
} from "@trebuchet/schema";
import { findAccountByCode } from "../invoicing/journal-drafts.ts";
import {
  type Account,
  type JournalDraft,
  type LineDraft,
  ok,
  type Result,
  validation,
} from "../types.ts";

/**
 * 明細の仕訳が使う科目のコード（006 R5）。科目の ID の設定は持たず、コードで引く（005/R10 と同じ方針）。
 * 見つからなければ `ACCOUNT_NOT_FOUND`、使用停止なら 001 の検証が `ACCOUNT_INACTIVE` を返す
 */
export const STATEMENT_ACCOUNT_CODES = {
  /** 現金 */
  cash: "1010",
  /** 普通預金 */
  ordinaryDeposit: "1020",
  /** 未払金（カード） */
  accountsPayable: "2020",
  /** 事業主借 */
  ownerContribution: "3010",
  /** 事業主貸 */
  ownerDrawing: "3090",
} as const;

export type ShapeStatement = {
  date: string;
  /** 符号つき（入金が正）。0 は仕訳にならない */
  amount: number;
  content: string;
};

/** 相手の科目（`c`）と、その行に付ける値 */
export type ShapeCounter = {
  accountId: string;
  subAccountId?: string | null | undefined;
  taxCategory?: TaxCategoryCode | undefined;
  partnerId?: string | null | undefined;
  description?: string | null | undefined;
};

export type JournalShapeInput = {
  statement: ShapeStatement;
  account: Pick<StatementAccount, "usage" | "accountId" | "subAccountId">;
  purpose: Purpose;
  /** 事業の判定のとき必須。私用の判定では使わない */
  counter?: ShapeCounter | undefined;
  accounts: readonly Pick<Account, "id" | "code">[];
};

export type ShapedJournal = {
  draft: JournalDraft;
  /** `draft.lines` のうち、明細の口座の行（`private` の口座は事業主貸・事業主借の行）の添字。結びつけに使う */
  statementLineIndex: number;
};

const isAmount = (n: number) => Number.isSafeInteger(n) && n !== 0 && Math.abs(n) < YEN_LIMIT;

/**
 * 用途と判定から仕訳の案の形を決める（R5、FR-016）。`a` = 明細の口座の科目（補助科目つき）、
 * `c` = 相手の科目、`X` = 金額の絶対値。
 *
 * | 口座の用途 | 向き | 判定 | 仕訳 |
 * |---|---|---|---|
 * | business・mixed | 出金 | 事業 | 借 c / 貸 a |
 * | business・mixed | 出金 | 私用 | 借 事業主貸 / 貸 a |
 * | business・mixed | 入金 | 事業 | 借 a / 貸 c |
 * | business・mixed | 入金 | 私用 | 借 a / 貸 事業主借 |
 * | private | 出金 | 事業 | 借 c / 貸 事業主借 |
 * | private | 入金 | 事業 | 借 事業主貸 / 貸 c |
 * | private | どちらも | 私用 | 仕訳なし（`null`） |
 *
 * カードの返金は未払金の口座への入金で、`c` を元の経費の科目にした「入金・事業」になる。
 * 税額は仕訳の登録（001）が税区分から計算する。この関数は税区分を相手の行にだけ渡す
 */
export function journalShape(input: JournalShapeInput): Result<ShapedJournal | null> {
  const { statement, account, purpose, counter, accounts } = input;
  if (!isAmount(statement.amount)) {
    return validation("明細の金額は 0 でない整数（1e12 未満）にしてください", {
      field: "amount",
    });
  }
  if (account.usage === "private" && purpose === "private") return ok(null);

  const abs = Math.abs(statement.amount);
  const inflow = statement.amount > 0;
  // 借方（入金なら明細の口座の側）と貸方
  const statementSide = inflow ? "debit" : "credit";
  const otherSide = inflow ? "credit" : "debit";

  // 事業主貸・事業主借が要る行は、向きで決まる（入金の相手側は事業主借、出金の相手側は事業主貸。
  // 口座が private のときは明細の口座の側が入れ替わって、入金は事業主貸、出金は事業主借）
  const ownerCode = (side: "debit" | "credit") =>
    side === "debit"
      ? STATEMENT_ACCOUNT_CODES.ownerDrawing
      : STATEMENT_ACCOUNT_CODES.ownerContribution;

  // 明細の口座の側の行（private は事業主貸・事業主借の行）
  let statementLine: LineDraft;
  if (account.usage === "private") {
    const owner = findAccountByCode(accounts, ownerCode(statementSide));
    if (!owner.ok) return owner;
    statementLine = line(statementSide, owner.value, abs);
  } else {
    if (account.accountId == null) {
      return validation("口座の科目が設定されていません", { field: "accountId" });
    }
    statementLine = line(statementSide, account.accountId, abs, account.subAccountId);
  }

  // 反対側の行: 事業なら相手の科目 c、私用（business・mixed の口座だけ）なら事業主貸・事業主借
  let otherLine: LineDraft;
  if (purpose === "business") {
    if (counter === undefined) {
      return validation("相手の科目を選んでください", { field: "counter" });
    }
    otherLine = {
      side: otherSide,
      accountId: counter.accountId,
      ...(counter.subAccountId == null ? {} : { subAccountId: counter.subAccountId }),
      amount: abs,
      ...(counter.taxCategory === undefined ? {} : { taxCategory: counter.taxCategory }),
      ...(counter.partnerId == null ? {} : { partnerId: counter.partnerId }),
      ...(counter.description == null ? {} : { description: counter.description }),
    };
  } else {
    const owner = findAccountByCode(accounts, ownerCode(otherSide));
    if (!owner.ok) return owner;
    otherLine = line(otherSide, owner.value, abs);
  }

  // 借方の行を先にする
  return ok({
    draft: {
      date: statement.date,
      memo: statement.content,
      lines: inflow ? [statementLine, otherLine] : [otherLine, statementLine],
    },
    statementLineIndex: inflow ? 0 : 1,
  });
}

/** 税の対象外の行（明細の口座・事業主貸・事業主借） */
function line(
  side: LineDraft["side"],
  accountId: string,
  amount: number,
  subAccountId?: string | null,
): LineDraft {
  return {
    side,
    accountId,
    ...(subAccountId == null ? {} : { subAccountId }),
    amount,
    taxCategory: "OUT_OF_SCOPE",
  };
}
