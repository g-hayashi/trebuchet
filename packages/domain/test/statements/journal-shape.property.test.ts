import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type JournalShapeInput,
  journalShape,
  STATEMENT_ACCOUNT_CODES,
} from "../../src/statements/journal-shape.ts";
import { absAmountArb, purposeArb, usageArb } from "../statements-arbitraries.ts";

// 006 T012（R5、FR-016、INV-42）。用途と判定から仕訳の形を決める

const accounts = [
  { id: "acc-bank", code: STATEMENT_ACCOUNT_CODES.ordinaryDeposit },
  { id: "acc-payable", code: STATEMENT_ACCOUNT_CODES.accountsPayable },
  { id: "acc-contribution", code: STATEMENT_ACCOUNT_CODES.ownerContribution },
  { id: "acc-drawing", code: STATEMENT_ACCOUNT_CODES.ownerDrawing },
  { id: "acc-expense", code: "5240" },
];
const A = "acc-a"; // 明細の口座の科目
const A_SUB = "sub-a";
const C = "acc-expense"; // 相手の科目
const CONTRIBUTION = "acc-contribution"; // 事業主借
const DRAWING = "acc-drawing"; // 事業主貸

const shape = (over: Partial<JournalShapeInput> & { amount: number }) => {
  const { amount, ...rest } = over;
  return journalShape({
    statement: { date: "2026-05-10", amount, content: "ショップ001" },
    account: { usage: "business", accountId: A, subAccountId: A_SUB },
    purpose: "business",
    counter: { accountId: C, taxCategory: "PURCHASE_10", partnerId: "p1" },
    accounts,
    ...rest,
  });
};

const lines = (over: Partial<JournalShapeInput> & { amount: number }) => {
  const r = shape(over);
  if (!r.ok || r.value === null) throw new Error("仕訳の案があるはず");
  return r.value;
};
const view = (v: ReturnType<typeof lines>): { side: string; account: string; amount: number }[] =>
  v.draft.lines.map((l) => ({ side: l.side, account: l.accountId, amount: l.amount }));

describe("journalShape: R5 の表の 7 行", () => {
  it("business・mixed／出金／事業: 借 c / 貸 a（補助科目つき）", () => {
    for (const usage of ["business", "mixed"] as const) {
      const v = lines({ amount: -1200, account: { usage, accountId: A, subAccountId: A_SUB } });
      expect(view(v)).toEqual([
        { side: "debit", account: C, amount: 1200 },
        { side: "credit", account: A, amount: 1200 },
      ]);
      expect(v.draft.lines[1]?.subAccountId).toBe(A_SUB);
      expect(v.statementLineIndex).toBe(1);
    }
  });

  it("business・mixed／出金／私用: 借 事業主貸 / 貸 a", () => {
    const v = lines({ amount: -1200, purpose: "private" });
    expect(view(v)).toEqual([
      { side: "debit", account: DRAWING, amount: 1200 },
      { side: "credit", account: A, amount: 1200 },
    ]);
  });

  it("business・mixed／入金／事業: 借 a / 貸 c", () => {
    const v = lines({ amount: 3000 });
    expect(view(v)).toEqual([
      { side: "debit", account: A, amount: 3000 },
      { side: "credit", account: C, amount: 3000 },
    ]);
    expect(v.draft.lines[0]?.subAccountId).toBe(A_SUB);
    expect(v.statementLineIndex).toBe(0);
  });

  it("business・mixed／入金／私用: 借 a / 貸 事業主借", () => {
    const v = lines({ amount: 3000, purpose: "private" });
    expect(view(v)).toEqual([
      { side: "debit", account: A, amount: 3000 },
      { side: "credit", account: CONTRIBUTION, amount: 3000 },
    ]);
  });

  it("private／出金／事業: 借 c / 貸 事業主借", () => {
    const v = lines({
      amount: -800,
      account: { usage: "private", accountId: null, subAccountId: null },
    });
    expect(view(v)).toEqual([
      { side: "debit", account: C, amount: 800 },
      { side: "credit", account: CONTRIBUTION, amount: 800 },
    ]);
    expect(v.statementLineIndex).toBe(1);
  });

  it("private／入金／事業: 借 事業主貸 / 貸 c", () => {
    const v = lines({
      amount: 800,
      account: { usage: "private", accountId: null, subAccountId: null },
    });
    expect(view(v)).toEqual([
      { side: "debit", account: DRAWING, amount: 800 },
      { side: "credit", account: C, amount: 800 },
    ]);
    expect(v.statementLineIndex).toBe(0);
  });

  it("private／どちらも／私用: 仕訳なし（null）", () => {
    for (const amount of [-800, 800]) {
      const r = shape({
        amount,
        purpose: "private",
        account: { usage: "private", accountId: null, subAccountId: null },
      });
      expect(r).toEqual({ ok: true, value: null });
    }
  });

  it("カードの返金（未払金の口座への入金）は、相手を経費の科目にした入金・事業（借 a / 貸 経費）", () => {
    const v = lines({
      amount: 1500,
      account: { usage: "mixed", accountId: "acc-payable", subAccountId: "card-sub" },
    });
    expect(view(v)).toEqual([
      { side: "debit", account: "acc-payable", amount: 1500 },
      { side: "credit", account: C, amount: 1500 },
    ]);
  });

  it("日付は明細の日付、摘要（memo）は明細の内容、相手の行に税区分・取引先・摘要を渡す", () => {
    const v = lines({
      amount: -1200,
      counter: {
        accountId: C,
        subAccountId: "sub-c",
        taxCategory: "PURCHASE_8R",
        partnerId: "p9",
        description: "メモ",
      },
    });
    expect(v.draft.date).toBe("2026-05-10");
    expect(v.draft.memo).toBe("ショップ001");
    expect(v.draft.lines[0]).toMatchObject({
      accountId: C,
      subAccountId: "sub-c",
      taxCategory: "PURCHASE_8R",
      partnerId: "p9",
      description: "メモ",
    });
  });
});

describe("journalShape: エラー", () => {
  it("事業主貸・事業主借の科目がなければ ACCOUNT_NOT_FOUND（コードで引く）", () => {
    const r = shape({
      amount: -100,
      purpose: "private",
      accounts: accounts.filter((a) => a.code !== STATEMENT_ACCOUNT_CODES.ownerDrawing),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("0 円・整数でない金額・上限以上は VALIDATION", () => {
    for (const amount of [0, 1.5, 1e12, -1e12]) {
      const r = shape({ amount });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("VALIDATION");
    }
  });

  it("相手の科目が要るのに渡されなければ VALIDATION", () => {
    const r = shape({ amount: -100, counter: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  it("business・mixed の口座に科目がなければ VALIDATION", () => {
    const r = shape({
      amount: -100,
      account: { usage: "business", accountId: null, subAccountId: null },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  it("私用の判定なら相手の科目は要らない", () => {
    expect(shape({ amount: -100, purpose: "private", counter: undefined }).ok).toBe(true);
  });
});

describe("journalShape（INV-42）", () => {
  const signedArb = fc.tuple(absAmountArb, fc.boolean()).map(([n, neg]) => (neg ? -n : n));

  it("明細の口座の行の金額 = |amount|、向きは入金なら借方・出金なら貸方、貸借は一致する。private・私用だけが null", () => {
    fc.assert(
      fc.property(signedArb, usageArb, purposeArb, (amount, usage, purpose) => {
        const account =
          usage === "private"
            ? { usage, accountId: null, subAccountId: null }
            : { usage, accountId: A, subAccountId: A_SUB };
        const r = shape({ amount, account, purpose });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        if (usage === "private" && purpose === "private") {
          expect(r.value).toBeNull();
          return;
        }
        expect(r.value).not.toBeNull();
        if (r.value === null) return;
        const { draft, statementLineIndex } = r.value;
        const abs = Math.abs(amount);
        const statementLine = draft.lines[statementLineIndex];
        expect(statementLine?.amount).toBe(abs);
        expect(statementLine?.side).toBe(amount > 0 ? "debit" : "credit");
        // 口座の用途が business・mixed なら、明細の口座の行はその科目（補助科目つき）
        if (usage !== "private") {
          expect(statementLine?.accountId).toBe(A);
          expect(statementLine?.subAccountId).toBe(A_SUB);
        }
        // 貸借一致・2 行・金額はすべて |amount|・整数
        const debit = draft.lines
          .filter((l) => l.side === "debit")
          .reduce((s, l) => s + l.amount, 0);
        const credit = draft.lines
          .filter((l) => l.side === "credit")
          .reduce((s, l) => s + l.amount, 0);
        expect(debit).toBe(credit);
        expect(draft.lines).toHaveLength(2);
        for (const l of draft.lines) {
          expect(l.amount).toBe(abs);
          expect(Number.isInteger(l.amount)).toBe(true);
        }
      }),
    );
  });
});
