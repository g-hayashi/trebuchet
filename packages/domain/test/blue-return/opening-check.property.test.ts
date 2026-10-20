import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkOpeningCarryForward } from "../../src/blue-return/opening-check.ts";
import { type CarryForwardBalance, carryForward } from "../../src/carry-forward.ts";
import type { Side } from "../../src/types.ts";
import { balancedClosingArb } from "../arbitraries.ts";
import { ACCOUNTS, accountId } from "../import/import-setup.ts";

const CAPITAL = accountId("3020");
const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));

type Key = { accountId: string; subAccountId: string | null };
type OpeningRow = Key & { side: Side; amount: number };

const keyOf = (k: Key) => `${k.accountId}\u0000${k.subAccountId ?? ""}`;
const debitNet = (r: { side: Side; amount: number }) => (r.side === "debit" ? r.amount : -r.amount);
/** 科目の通常の側を正とする */
const signed = (id: string, net: number) => (byId.get(id)?.normalSide === "credit" ? 0 - net : net);

function carried(balances: readonly CarryForwardBalance[]): OpeningRow[] {
  const r = carryForward(balances, ACCOUNTS);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** 借方を正とする科目・補助科目ごとの金額から期首残高の行を作る（0 の行は作らない） */
function toRows(net: ReadonlyMap<string, Key & { amount: number }>): OpeningRow[] {
  return [...net.values()]
    .filter((r) => r.amount !== 0)
    .map((r) => ({
      accountId: r.accountId,
      subAccountId: r.subAccountId,
      side: r.amount > 0 ? "debit" : "credit",
      amount: Math.abs(r.amount),
    }));
}

function netOf(rows: readonly OpeningRow[]) {
  const m = new Map<string, Key & { amount: number }>();
  for (const r of rows) {
    const prev = m.get(keyOf(r));
    if (prev === undefined) m.set(keyOf(r), { ...r, amount: debitNet(r) });
    else prev.amount += debitNet(r);
  }
  return m;
}

function check(balances: readonly CarryForwardBalance[], opening: readonly OpeningRow[]) {
  const r = checkOpeningCarryForward(balances, opening, ACCOUNTS);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** ずらす科目・補助科目（元入金の補助科目なしは除く。事業主貸・損益の科目も含む） */
const shiftedKeyArb: fc.Arbitrary<Key> = fc
  .record({
    accountId: fc.constantFrom(...ACCOUNTS.map((a) => a.id)),
    subAccountId: fc.option(fc.constantFrom("sub-1", "sub-2"), { nil: null }),
  })
  .filter((k) => !(k.accountId === CAPITAL && k.subAccountId === null));

const deltaArb = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }).filter((n) => n !== 0);

describe("checkOpeningCarryForward（T026, FR-029, R8）", () => {
  it("carryForward の結果をそのまま期首にすれば、差は 0 件", () => {
    fc.assert(
      fc.property(balancedClosingArb(ACCOUNTS), (balances) => {
        expect(check(balances, carried(balances))).toEqual([]);
      }),
    );
  });

  it("1 科目をずらして元入金で貸借を合わせると、その科目と元入金だけに差が出る（期待値・実際・差額）", () => {
    fc.assert(
      fc.property(balancedClosingArb(ACCOUNTS), shiftedKeyArb, deltaArb, (balances, key, delta) => {
        const expectedRows = carried(balances);
        const net = netOf(expectedRows);
        const bump = (k: Key, amount: number) => {
          const prev = net.get(keyOf(k));
          if (prev === undefined) net.set(keyOf(k), { ...k, amount });
          else prev.amount += amount;
        };
        bump(key, delta);
        bump({ accountId: CAPITAL, subAccountId: null }, -delta);
        const opening = toRows(net);

        const result = check(balances, opening);
        const expectedNet = netOf(expectedRows);
        const expectedOf = (k: Key) => signed(k.accountId, expectedNet.get(keyOf(k))?.amount ?? 0);
        const capitalKey = { accountId: CAPITAL, subAccountId: null };

        expect(result.map((m) => keyOf(m)).sort()).toEqual([keyOf(key), keyOf(capitalKey)].sort());
        for (const m of result) {
          expect(m.actual - m.expected).toBe(m.diff);
          expect(m.diff).not.toBe(0);
          expect(m.expected).toBe(expectedOf(m));
        }
        const shifted = result.find((m) => keyOf(m) === keyOf(key));
        const capital = result.find((m) => keyOf(m) === keyOf(capitalKey));
        expect(shifted?.diff).toBe(signed(key.accountId, delta));
        expect(capital?.diff).toBe(signed(CAPITAL, -delta));
      }),
    );
  });

  it("期首の同じ科目・補助科目の行は合算して比べ、補助科目なし（undefined）は null と同じ", () => {
    const balances: CarryForwardBalance[] = [
      { accountId: accountId("1030"), subAccountId: null, closing: 1_000 },
      { accountId: CAPITAL, subAccountId: null, closing: -1_000 },
    ];
    const r = checkOpeningCarryForward(
      balances,
      [
        { accountId: accountId("1030"), side: "debit", amount: 600 },
        { accountId: accountId("1030"), subAccountId: null, side: "debit", amount: 400 },
        { accountId: CAPITAL, side: "credit", amount: 1_000 },
      ],
      ACCOUNTS,
    );
    expect(r).toEqual({ ok: true, value: [] });
  });

  it("前年度に事業主貸・事業主借・所得があり、売掛金だけを 300 多く登録した例: 売掛金と元入金に差", () => {
    // 前年度の期末: 現金 1,500 売掛金 500 事業主貸 200 / 事業主借 100 元入金 1,000 売上 1,500 経費 −400
    const balances: CarryForwardBalance[] = [
      { accountId: accountId("1010"), subAccountId: null, closing: 1_500 },
      { accountId: accountId("1030"), subAccountId: null, closing: 500 },
      { accountId: accountId("3090"), subAccountId: null, closing: 200 },
      { accountId: accountId("3010"), subAccountId: null, closing: -100 },
      { accountId: CAPITAL, subAccountId: null, closing: -1_000 },
      { accountId: accountId("4010"), subAccountId: null, closing: -1_500 },
      { accountId: accountId("5170"), subAccountId: null, closing: 400 },
    ];
    // 繰越: 元入金 = 1,000 + 100 + (1,500 − 400) − 200 = 2,000
    const r = checkOpeningCarryForward(
      balances,
      [
        { accountId: accountId("1010"), side: "debit", amount: 1_500 },
        { accountId: accountId("1030"), side: "debit", amount: 800 },
        { accountId: CAPITAL, side: "credit", amount: 2_300 },
      ],
      ACCOUNTS,
    );
    expect(r).toEqual({
      ok: true,
      value: [
        {
          accountId: accountId("1030"),
          subAccountId: null,
          expected: 500,
          actual: 800,
          diff: 300,
        },
        { accountId: CAPITAL, subAccountId: null, expected: 2_000, actual: 2_300, diff: 300 },
      ],
    });
  });

  it("元入金の科目がなく、振り替える額があるときは carryForward と同じ VALIDATION", () => {
    const accounts = ACCOUNTS.filter((a) => a.code !== "3020");
    const r = checkOpeningCarryForward(
      [
        { accountId: accountId("1010"), subAccountId: null, closing: 500 },
        { accountId: accountId("4010"), subAccountId: null, closing: -500 },
      ],
      [],
      accounts,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });
});
