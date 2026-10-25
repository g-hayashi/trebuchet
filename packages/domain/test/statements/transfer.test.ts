import { describe, expect, it } from "vitest";
import {
  findTransferPair,
  inferUnpairedTransfer,
  TRANSFER_WINDOW_DAYS,
  transferConfidence,
  transferJournal,
} from "../../src/statements/transfer.ts";

// 006 T013（R6、FR-019）。振替の対と、対のない引落の推定

const st = (
  id: string,
  over: Partial<{ statementAccountId: string; date: string; amount: number }> = {},
) => ({
  id,
  statementAccountId: "bank",
  date: "2026-05-10",
  amount: -30_000,
  ...over,
});

describe("findTransferPair", () => {
  const out = st("out");

  it("反対の口座・同額・逆向き・7 日以内の明細を対にする", () => {
    const pair = st("in", { statementAccountId: "card", amount: 30_000, date: "2026-05-12" });
    expect(findTransferPair(out, [pair])?.id).toBe("in");
    // 逆の向きからも見つかる
    expect(findTransferPair(pair, [out])?.id).toBe("out");
  });

  it(`日付の差は ${TRANSFER_WINDOW_DAYS} 日まで（境目）`, () => {
    const at = (date: string) => st("in", { statementAccountId: "card", amount: 30_000, date });
    expect(findTransferPair(out, [at("2026-05-17")])?.id).toBe("in");
    expect(findTransferPair(out, [at("2026-05-03")])?.id).toBe("in");
    expect(findTransferPair(out, [at("2026-05-18")])).toBeUndefined();
    expect(findTransferPair(out, [at("2026-05-02")])).toBeUndefined();
  });

  it("同じ口座・同じ向き・金額違い・自分自身は対にしない", () => {
    expect(findTransferPair(out, [st("a", { amount: 30_000 })])).toBeUndefined();
    expect(
      findTransferPair(out, [st("b", { statementAccountId: "card", amount: -30_000 })]),
    ).toBeUndefined();
    expect(
      findTransferPair(out, [st("c", { statementAccountId: "card", amount: 29_999 })]),
    ).toBeUndefined();
    expect(findTransferPair(out, [out])).toBeUndefined();
  });

  it("0 円は対にしない", () => {
    expect(
      findTransferPair(st("z", { amount: 0 }), [
        st("y", { statementAccountId: "card", amount: 0 }),
      ]),
    ).toBeUndefined();
  });

  it("対の候補が複数あれば、日付の差が最も小さいもの（同じなら先に渡したもの）", () => {
    const far = st("far", { statementAccountId: "card", amount: 30_000, date: "2026-05-15" });
    const near = st("near", { statementAccountId: "card", amount: 30_000, date: "2026-05-11" });
    const tie = st("tie", { statementAccountId: "card", amount: 30_000, date: "2026-05-09" });
    expect(findTransferPair(out, [far, near])?.id).toBe("near");
    expect(findTransferPair(out, [far, near, tie])?.id).toBe("near");
    expect(findTransferPair(out, [tie, near])?.id).toBe("tie");
  });
});

describe("transferConfidence", () => {
  it("日付の差が大きいほど下がる（0 日で最大、7 日でもまとめて承認のしきい値の既定 80 以上）", () => {
    expect(transferConfidence(0)).toBeGreaterThan(transferConfidence(3));
    expect(transferConfidence(3)).toBeGreaterThan(transferConfidence(7));
    expect(transferConfidence(7)).toBeGreaterThanOrEqual(80);
    expect(transferConfidence(0)).toBeLessThanOrEqual(100);
  });
});

describe("transferJournal（借 受け側 / 貸 出し側）", () => {
  const bank = { accountId: "acc-bank", subAccountId: null };
  const card = { accountId: "acc-payable", subAccountId: "sub-card" };

  it("入金の側の口座が借方、出金の側の口座が貸方。日付は出金の側、補助科目を引き継ぐ", () => {
    const r = transferJournal(
      { statement: { date: "2026-05-10", amount: -30_000, content: "カード引落" }, account: bank },
      { statement: { date: "2026-05-12", amount: 30_000, content: "お支払い" }, account: card },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.date).toBe("2026-05-10");
    expect(r.value.memo).toBe("カード引落");
    expect(r.value.lines).toEqual([
      {
        side: "debit",
        accountId: "acc-payable",
        subAccountId: "sub-card",
        amount: 30_000,
        taxCategory: "OUT_OF_SCOPE",
      },
      { side: "credit", accountId: "acc-bank", amount: 30_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
  });

  it("引数の順は問わない", () => {
    const a = {
      statement: { date: "2026-05-10", amount: -500, content: "x" },
      account: bank,
    };
    const b = { statement: { date: "2026-05-10", amount: 500, content: "y" }, account: card };
    const r1 = transferJournal(a, b);
    const r2 = transferJournal(b, a);
    expect(r1).toEqual(r2);
  });

  it("向きが同じ・金額が違う・科目がない口座は VALIDATION", () => {
    const s = (amount: number) => ({ date: "2026-05-10", amount, content: "x" });
    for (const r of [
      transferJournal({ statement: s(-500), account: bank }, { statement: s(-500), account: card }),
      transferJournal({ statement: s(-500), account: bank }, { statement: s(400), account: card }),
      transferJournal(
        { statement: s(-500), account: bank },
        { statement: s(500), account: { accountId: null, subAccountId: null } },
      ),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("VALIDATION");
    }
  });
});

describe("inferUnpairedTransfer（対のない引落の推定）", () => {
  const s = (content: string, over: Partial<{ amount: number; transferFlag: boolean }> = {}) => ({
    content,
    amount: -45_000,
    transferFlag: true,
    ...over,
  });

  it("振替の印があり出金で、内容がカードの支払いらしければ card_payment", () => {
    for (const content of [
      "カード引落 テストカードA",
      "ｶｰﾄﾞ ﾋｷｵﾄｼ",
      "テストカード　ご利用代金",
      "VISA 支払い",
      "クレジット 引落",
      "JCB カード",
    ]) {
      expect(inferUnpairedTransfer(s(content))).toEqual({ kind: "card_payment" });
    }
  });

  it("振替の印がない・入金・カードらしくない内容は none（ルールがなければ決められない）", () => {
    expect(inferUnpairedTransfer(s("カード引落", { transferFlag: false }))).toEqual({
      kind: "none",
    });
    expect(inferUnpairedTransfer(s("カード引落", { amount: 45_000 }))).toEqual({ kind: "none" });
    expect(inferUnpairedTransfer(s("家賃 6月分"))).toEqual({ kind: "none" });
    expect(inferUnpairedTransfer(s("振込 ﾃｽﾄﾀﾛｳ"))).toEqual({ kind: "none" });
  });
});
