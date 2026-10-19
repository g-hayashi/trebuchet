import { describe, expect, it } from "vitest";
import {
  type OpeningProposalInput,
  proposeOpeningBalances,
} from "../../src/import/freee/opening.ts";
import {
  type FreeeFile,
  type FreeeLedgerAccount,
  parseFreeeLedger,
  readFreeeFile,
} from "../../src/import/freee/read.ts";
import type { SubAccount } from "../../src/types.ts";
import { makeFiscalPeriod } from "../arbitraries.ts";
import {
  EXPECTED_LEDGER,
  EXPECTED_OPENING_PROPOSAL,
  FIXTURE_FILES,
} from "../fixtures/freee/expected.ts";
import { FREEE_LEDGER_HEADER } from "../fixtures/freee/headers.ts";
import { readFixture } from "../fixtures/freee/load.ts";
import { ACCOUNTS, accountId, PERIOD_2025 } from "./import-setup.ts";

const CARD_SUB: SubAccount = {
  id: "sub-abc",
  accountId: accountId("2020"),
  name: "ABCカード",
  isActive: true,
};

function fixtureLedger(): FreeeLedgerAccount[] {
  const file = readFreeeFile(readFixture(FIXTURE_FILES.ledger));
  if (!file.ok) throw new Error(JSON.stringify(file.error));
  const parsed = parseFreeeLedger(file.value);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

type Row = Record<string, string>;

/** 元帳の列名 → 値 の行から科目ごとの元帳を作る（指定しない列は空） */
function ledgerOf(rows: Row[]): FreeeLedgerAccount[] {
  const file: FreeeFile = {
    kind: "ledger",
    encoding: "utf-8",
    header: [...FREEE_LEDGER_HEADER],
    rows: rows.map((r) => Object.fromEntries(FREEE_LEDGER_HEADER.map((h) => [h, r[h] ?? ""]))),
  };
  const parsed = parseFreeeLedger(file);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

const START = "2025-01-01";
const opening = (account: string, balance: number, date = START): Row => ({
  勘定科目: account,
  取引日: date,
  決算整理仕訳: "0",
  相手勘定科目: "前期繰越",
  残高: String(balance),
});
const transfer = (
  account: string,
  side: "debit" | "credit",
  amount: number,
  balance: number,
): Row => ({
  勘定科目: account,
  取引日: START,
  決算整理仕訳: "1",
  相手勘定科目: "諸口",
  仕訳番号: "5010101",
  借方金額: side === "debit" ? String(amount) : "",
  貸方金額: side === "credit" ? String(amount) : "",
  残高: String(balance),
});

/** research R5 の合成の例（資産は事業主貸を除いて 1,400。R5 の本文の 1,100 では貸借が合わない） */
const R5_LEDGER: Row[] = [
  opening("その他口座", 1_400),
  opening("事業主貸", 300),
  transfer("事業主貸", "credit", 300, 0),
  opening("事業主借", 100),
  transfer("事業主借", "debit", 100, 0),
  opening("元入金", 1_000),
  transfer("元入金", "credit", 100, 1_100),
  transfer("元入金", "credit", 600, 1_700),
  transfer("元入金", "debit", 300, 1_400),
  transfer("損益", "debit", 600, -600),
];

function input(overrides: Partial<OpeningProposalInput> = {}): OpeningProposalInput {
  return {
    fiscalYear: 2025,
    ledger: fixtureLedger(),
    savedMappings: [],
    accounts: ACCOUNTS,
    subAccounts: [CARD_SUB],
    periods: [PERIOD_2025],
    registered: [],
    ...overrides,
  };
}

function propose(overrides: Partial<OpeningProposalInput> = {}) {
  const r = proposeOpeningBalances(input(overrides));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const key = (r: { accountId: string; subAccountId: string | null }) => [
  r.accountId,
  r.subAccountId,
];

describe("proposeOpeningBalances（T037, FR-019〜020a, research R5・R6）", () => {
  it("フィクスチャの元帳: 決算振替を繰り込み、損益を捨て、expected.ts の案と一致して貸借が一致する", () => {
    const p = propose();
    expect(p.fiscalYear).toBe(2025);
    expect(
      p.rows.map((r) => ({
        accountId: r.accountId,
        subAccountId: r.subAccountId,
        side: r.side,
        amount: r.amount,
      })),
    ).toEqual(
      EXPECTED_OPENING_PROPOSAL.map((e) => ({
        accountId: accountId(e.code),
        subAccountId: e.subAccountName === undefined ? null : CARD_SUB.id,
        side: e.side,
        amount: e.amount,
      })),
    );
    expect(p.totals).toEqual({ debit: 1_070_000, credit: 1_070_000 });
    expect(p.unmapped).toEqual([]);
    expect(p.missingSubAccounts).toEqual([]);
    expect(p.rows.find((r) => r.accountId === accountId("1020"))?.sourceNames).toEqual([
      "その他口座",
    ]);
    expect(p.rows.find((r) => r.subAccountId === CARD_SUB.id)?.sourceNames).toEqual(["ABCカード"]);
    expect(p.rows.find((r) => r.accountId === accountId("3020"))?.amount).toBe(
      EXPECTED_LEDGER.accounts.元入金.openingAfterClosing,
    );
  });

  it("research R5 の例: 元入金 1,400・事業主借 0・事業主貸 0（行を作らない）。「損益」は捨てて unmapped にも出さない", () => {
    const p = propose({ ledger: ledgerOf(R5_LEDGER) });
    expect(p.rows.map((r) => [r.accountId, r.side, r.amount, r.sourceNames])).toEqual([
      [accountId("1020"), "debit", 1_400, ["その他口座"]],
      [accountId("3020"), "credit", 1_400, ["元入金"]],
    ]);
    expect(p.totals).toEqual({ debit: 1_400, credit: 1_400 });
    expect(p.unmapped).toEqual([]);
    expect(p.warnings).toEqual([]);
  });

  it("期首日付でも決算整理仕訳 = 0 の行、期首日以外の決算整理仕訳の行は繰り込まない", () => {
    const p = propose({
      ledger: ledgerOf([
        opening("現金", 1_000),
        { ...transfer("現金", "debit", 50, 1_050), 決算整理仕訳: "0" },
        { ...transfer("現金", "credit", 70, 980), 取引日: "2025-12-31" },
        opening("元入金", 1_000),
      ]),
    });
    expect(p.rows.map((r) => [r.accountId, r.amount])).toEqual([
      [accountId("1010"), 1_000],
      [accountId("3020"), 1_000],
    ]);
  });

  it("マイナスの残高は反対側の行にして NEGATIVE_OPENING（科目・補助科目・符号つきの額）", () => {
    const p = propose();
    const ar = p.rows.find((r) => r.accountId === accountId("1030"));
    expect(ar).toMatchObject({ side: "credit", amount: 20_000 });
    const negatives = p.warnings.filter((w) => w.code === "NEGATIVE_OPENING");
    expect(negatives).toHaveLength(1);
    expect(negatives[0]?.details).toMatchObject({
      accountId: accountId("1030"),
      subAccountId: null,
      amount: -20_000,
      sourceNames: ["売掛金"],
    });
    expect(negatives[0]?.message).toContain("売掛金");
  });

  it("対応が未定の科目は unmapped に入り、案に含めない。期首が 0 の科目は未定でも出さない", () => {
    const p = propose({
      ledger: ledgerOf([
        opening("現金", 1_500),
        opening("謎の資産", 500),
        { ...transfer("謎の費用", "debit", 10, 10), 決算整理仕訳: "0", 取引日: "2025-03-01" },
        opening("元入金", 2_000),
      ]),
    });
    expect(p.unmapped).toEqual(["謎の資産"]);
    expect(p.rows.map((r) => r.accountId)).toEqual([accountId("1010"), accountId("3020")]);
    expect(p.totals).toEqual({ debit: 1_500, credit: 2_000 });
  });

  it("カードの科目は未払金（2020）の補助科目ごとの行になる。同じ帳簿の科目に対応する freee の科目は合算する", () => {
    const xyz: SubAccount = {
      id: "sub-xyz",
      accountId: accountId("2020"),
      name: "XYZカード",
      isActive: true,
    };
    const p = propose({
      subAccounts: [CARD_SUB, xyz],
      ledger: ledgerOf([
        opening("その他口座", 600),
        opening("普通預金", 400),
        opening("ＡＢＣカード", 100),
        opening("XYZカード", 200),
        opening("未払金", 50),
        opening("元入金", 650),
      ]),
    });
    expect(
      p.rows.map((r) => [r.accountId, r.subAccountId, r.side, r.amount, r.sourceNames]),
    ).toEqual([
      [accountId("1020"), null, "debit", 1_000, ["その他口座", "普通預金"]],
      [accountId("2020"), null, "credit", 50, ["未払金"]],
      [accountId("2020"), CARD_SUB.id, "credit", 100, ["ABCカード"]],
      [accountId("2020"), xyz.id, "credit", 200, ["XYZカード"]],
      [accountId("3020"), null, "credit", 650, ["元入金"]],
    ]);
  });

  it("カードの補助科目がまだないときは unmapped と missingSubAccounts に入れ、案に含めない", () => {
    const p = propose({ subAccounts: [] });
    expect(p.unmapped).toEqual(["ABCカード"]);
    expect(p.missingSubAccounts).toEqual([
      { sourceName: "ABCカード", accountId: accountId("2020"), subAccountName: "ABCカード" },
    ]);
    expect(p.rows.some((r) => r.accountId === accountId("2020"))).toBe(false);
  });

  it("保存済みの対応表を初期案より優先する", () => {
    const bankSub: SubAccount = {
      id: "sub-bank",
      accountId: accountId("1020"),
      name: "A銀行",
      isActive: true,
    };
    const p = propose({
      subAccounts: [CARD_SUB, bankSub],
      savedMappings: [
        { sourceName: "その他口座", accountId: accountId("1020"), subAccountId: bankSub.id },
      ],
    });
    expect(p.rows.find((r) => r.accountId === accountId("1020"))?.subAccountId).toBe(bankSub.id);
  });

  it("登録済みの期首残高との差を科目ごとに返す（FR-020）。登録がなければ registered は null", () => {
    expect(propose().comparisons.every((c) => c.registered === null)).toBe(true);

    const p = propose({
      registered: [
        { accountId: accountId("1010"), subAccountId: null, side: "debit", amount: 30_000 },
        { accountId: accountId("1030"), subAccountId: null, side: "debit", amount: 5_000 },
        { accountId: accountId("1080"), subAccountId: null, side: "debit", amount: 7_000 },
        { accountId: accountId("3020"), subAccountId: null, side: "credit", amount: 1_000_000 },
      ],
    });
    const byKey = new Map(p.comparisons.map((c) => [JSON.stringify(key(c)), c]));
    const get = (code: string, sub: string | null = null) =>
      byKey.get(JSON.stringify([accountId(code), sub]));
    expect(get("1010")).toMatchObject({ proposed: 30_000, registered: 30_000, carryForward: null });
    expect(get("1030")).toMatchObject({ proposed: -20_000, registered: 5_000 });
    // 登録済みにだけある科目は proposed = 0、案にだけある科目は registered = 0
    expect(get("1080")).toMatchObject({ proposed: 0, registered: 7_000 });
    expect(get("1060")).toMatchObject({ proposed: 240_000, registered: 0 });
    expect(get("2020", CARD_SUB.id)).toMatchObject({ proposed: 15_000, registered: 0 });
    expect(get("3020")).toMatchObject({ proposed: 1_035_000, registered: 1_000_000 });
    // 科目の並び順（sortOrder → コード）
    const order = ACCOUNTS.map((a) => a.id);
    const indexes = p.comparisons.map((c) => order.indexOf(c.accountId));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("前年度の残高を渡すと carryForward と比べ、違う科目に OPENING_DIFFERS_FROM_CARRY_FORWARD（FR-020a）", () => {
    // 前年度の期末（借方を正）: 案と同じ繰越になるが、現金だけ 1,000 多く、元入金がその分大きい
    const prior = [
      { accountId: accountId("1010"), subAccountId: null, closing: 31_000 },
      { accountId: accountId("1020"), subAccountId: null, closing: 800_000 },
      { accountId: accountId("1030"), subAccountId: null, closing: -20_000 },
      { accountId: accountId("1060"), subAccountId: null, closing: 240_000 },
      { accountId: accountId("3090"), subAccountId: null, closing: 350_000 },
      { accountId: accountId("2020"), subAccountId: CARD_SUB.id, closing: -15_000 },
      { accountId: accountId("3010"), subAccountId: null, closing: -85_000 },
      { accountId: accountId("3020"), subAccountId: null, closing: -900_000 },
      { accountId: accountId("4010"), subAccountId: null, closing: -500_000 },
      { accountId: accountId("5170"), subAccountId: null, closing: 99_000 },
    ];
    const p = propose({ priorBalances: prior });
    const differs = p.warnings.filter((w) => w.code === "OPENING_DIFFERS_FROM_CARRY_FORWARD");
    expect(differs.map((w) => w.details?.accountId)).toEqual([
      accountId("1010"),
      accountId("3020"),
    ]);
    expect(differs[0]?.details).toMatchObject({
      proposed: 30_000,
      carryForward: 31_000,
      diff: -1_000,
    });
    const cash = p.comparisons.find((c) => c.accountId === accountId("1010"));
    expect(cash).toMatchObject({ proposed: 30_000, carryForward: 31_000 });
    const capital = p.comparisons.find((c) => c.accountId === accountId("3020"));
    expect(capital).toMatchObject({ proposed: 1_035_000, carryForward: 1_036_000 });
    // 事業主貸・事業主借は繰越で 0 になるので、比べる行に出さない
    expect(p.comparisons.some((c) => c.accountId === accountId("3090"))).toBe(false);
  });

  it("前年度の残高がなければ carryForward は null で、FR-020a の警告は出さない", () => {
    const p = propose();
    expect(p.comparisons.every((c) => c.carryForward === null)).toBe(true);
    expect(p.warnings.some((w) => w.code === "OPENING_DIFFERS_FROM_CARRY_FORWARD")).toBe(false);
  });

  it("会計期間がない年度・会計期間の外の開始行 → OUT_OF_PERIOD", () => {
    const none = proposeOpeningBalances(input({ fiscalYear: 2026 }));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe("OUT_OF_PERIOD");

    const other = proposeOpeningBalances(
      input({
        ledger: ledgerOf([
          opening("現金", 100, "2024-01-01"),
          opening("元入金", 100, "2024-01-01"),
        ]),
      }),
    );
    expect(other.ok).toBe(false);
    if (!other.ok)
      expect(other.error).toMatchObject({ code: "OUT_OF_PERIOD", details: { fiscalYear: 2025 } });

    const p2026 = proposeOpeningBalances(
      input({
        fiscalYear: 2026,
        periods: [PERIOD_2025, makeFiscalPeriod(2026)],
        ledger: ledgerOf([
          opening("現金", 100, "2026-01-01"),
          opening("元入金", 100, "2026-01-01"),
        ]),
      }),
    );
    expect(p2026.ok).toBe(true);
  });

  it("金額が 1 兆円以上の行は 001 の validateOpeningBalances の VALIDATION", () => {
    const r = proposeOpeningBalances(
      input({
        ledger: ledgerOf([
          opening("現金", 1_000_000_000_000),
          opening("元入金", 1_000_000_000_000),
        ]),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  it("入力を変えない（純関数）", () => {
    const i = input({ registered: [{ accountId: accountId("1010"), side: "debit", amount: 1 }] });
    const before = structuredClone(i);
    proposeOpeningBalances(i);
    expect(i).toEqual(before);
  });
});
