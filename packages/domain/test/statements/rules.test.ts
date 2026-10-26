import { describe, expect, it } from "vitest";
import { learnRule, ruleConfidence, ruleFor, seedRules } from "../../src/statements/rules.ts";
import type { Account, InferenceRule, Journal, JournalLine } from "../../src/types.ts";
import { setupBase } from "../ledger-setup.ts";

// 006 T018（R9、§1.6、FR-022〜024）。ルールの選び方・確信度・学習・初期作成（純関数）

const rule = (over: Partial<InferenceRule> = {}): InferenceRule => ({
  id: "r1",
  normalizedContent: "ショップ#",
  statementAccountId: null,
  counterAccountId: "acc-supplies",
  counterSubAccountId: null,
  partnerId: null,
  taxCategory: "PURCHASE_10",
  purpose: "business",
  descriptionTemplate: null,
  hits: 1,
  overrides: 0,
  status: "active",
  origin: "approval",
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  ...over,
});

describe("ruleFor", () => {
  const statement = { normalizedContent: "ショップ#", statementAccountId: "s1" };

  it("正規化した内容が一致するルールを返す。一致するものがなければ undefined", () => {
    expect(ruleFor(statement, [rule()])?.id).toBe("r1");
    expect(ruleFor(statement, [rule({ normalizedContent: "別の店" })])).toBeUndefined();
    expect(ruleFor(statement, [])).toBeUndefined();
  });

  it("同じ口座のルールを、すべての口座のルールより優先する（並びに依らない）", () => {
    const all = rule({ id: "all", statementAccountId: null });
    const own = rule({ id: "own", statementAccountId: "s1" });
    expect(ruleFor(statement, [all, own])?.id).toBe("own");
    expect(ruleFor(statement, [own, all])?.id).toBe("own");
  });

  it("別の口座のルールは使わない", () => {
    expect(ruleFor(statement, [rule({ statementAccountId: "s2" })])).toBeUndefined();
  });

  it("停止中のルールは使わない。同じ口座のルールが停止中ならすべての口座のルールを使う", () => {
    expect(ruleFor(statement, [rule({ status: "paused" })])).toBeUndefined();
    const own = rule({ id: "own", statementAccountId: "s1", status: "paused" });
    const all = rule({ id: "all" });
    expect(ruleFor(statement, [own, all])?.id).toBe("all");
  });
});

describe("ruleConfidence", () => {
  it("min(95, 50 + 10 × hits) − 20 × overrides。0 未満は 0", () => {
    expect(ruleConfidence({ hits: 0, overrides: 0 })).toBe(50);
    expect(ruleConfidence({ hits: 1, overrides: 0 })).toBe(60);
    expect(ruleConfidence({ hits: 4, overrides: 0 })).toBe(90);
    expect(ruleConfidence({ hits: 5, overrides: 0 })).toBe(95);
    expect(ruleConfidence({ hits: 50, overrides: 0 })).toBe(95);
    expect(ruleConfidence({ hits: 3, overrides: 1 })).toBe(60);
    expect(ruleConfidence({ hits: 0, overrides: 3 })).toBe(0);
  });
});

describe("learnRule", () => {
  const body = {
    counterAccountId: "acc-supplies",
    counterSubAccountId: null,
    partnerId: null,
    taxCategory: "PURCHASE_10" as const,
    purpose: "business" as const,
    descriptionTemplate: null,
  };
  const approval = { normalizedContent: "ショップ#", statementAccountId: "s1", body };

  it("ルールがなければ新規（hits 1、overrides 0）。承認した口座のルールになる", () => {
    const r = learnRule(null, approval);
    expect(r.action).toBe("create");
    expect(r.rule).toEqual({
      normalizedContent: "ショップ#",
      statementAccountId: "s1",
      ...body,
      hits: 1,
      overrides: 0,
    });
  });

  it("同じ内容の承認は hits を加算する", () => {
    const r = learnRule(rule({ statementAccountId: "s1", hits: 2 }), approval);
    expect(r.action).toBe("update");
    expect(r.rule.hits).toBe(3);
    expect(r.rule.overrides).toBe(0);
  });

  it("違う内容の承認は overrides を加算し、承認の内容に置き換える（hits は変えない）", () => {
    const changed = { ...body, counterAccountId: "acc-rent", purpose: "private" as const };
    const r = learnRule(rule({ statementAccountId: "s1", hits: 2, overrides: 1 }), {
      ...approval,
      body: changed,
    });
    expect(r.action).toBe("update");
    expect(r.rule).toMatchObject({ ...changed, hits: 2, overrides: 2 });
  });

  it("取引先・税区分・補助科目・摘要の違いも違う内容", () => {
    const base = rule({ statementAccountId: "s1" });
    for (const diff of [
      { partnerId: "p1" },
      { taxCategory: "PURCHASE_8R" as const },
      { counterSubAccountId: "sub1" },
      { descriptionTemplate: "消耗品" },
    ]) {
      const r = learnRule(base, { ...approval, body: { ...body, ...diff } });
      expect(r.rule.overrides).toBe(1);
      expect(r.rule).toMatchObject(diff);
    }
  });
});

describe("seedRules（R9 の初期作成）", () => {
  const base = setupBase();
  const accounts = base.masters.listAccounts();
  const idOf = (name: string) => base.accountId(name);
  const bank = idOf("普通預金");
  const supplies = idOf("消耗品費");
  const rent = idOf("地代家賃");

  let n = 0;
  const line = (over: Partial<JournalLine>): JournalLine => ({
    id: `l${++n}`,
    lineNo: 1,
    side: "debit",
    accountId: supplies,
    subAccountId: null,
    amount: 1000,
    taxCategory: "PURCHASE_10",
    taxAmount: 0,
    partnerId: null,
    description: null,
    tagIds: [],
    ...over,
  });
  /** 出金の仕訳: 借 相手 / 貸 普通預金。摘要は相手の行 */
  const expense = (
    description: string | null,
    counter: Partial<JournalLine> = {},
    over: Partial<Journal> = {},
  ): Journal => ({
    id: `j${++n}`,
    journalNo: n,
    date: "2026-05-10",
    fiscalPeriodId: "fp",
    memo: null,
    status: "active",
    correctsJournalId: null,
    source: "manual",
    version: 1,
    createdAt: "",
    updatedAt: "",
    lines: [
      line({ lineNo: 1, side: "debit", description, ...counter }),
      line({ lineNo: 2, side: "credit", accountId: bank, taxCategory: "OUT_OF_SCOPE" }),
    ],
    ...over,
  });

  it("同じ正規化の内容が 2 件以上あり、最多の組み合わせが 3/4 以上のものだけをルールにする（口座はすべて）", () => {
    const journals = [
      expense("ショップ 001"),
      expense("ショップ 002"),
      expense("ショップ 003"),
      expense("ショップ 004", { accountId: rent }), // 3/4 = ちょうど
    ];
    const seeded = seedRules(journals, accounts);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({
      normalizedContent: "ショップ#",
      statementAccountId: null,
      counterAccountId: supplies,
      taxCategory: "PURCHASE_10",
      purpose: "business",
      hits: 3,
      overrides: 0,
    });
  });

  it("2 件未満・3/4 未満は作らない", () => {
    expect(seedRules([expense("単発の店")], accounts)).toEqual([]);
    const mixed = [
      expense("店A"),
      expense("店A"),
      expense("店A", { accountId: rent }),
      expense("店A", { accountId: rent }),
    ];
    expect(seedRules(mixed, accounts)).toEqual([]);
  });

  it("組み合わせに税区分・取引先・補助科目も含める", () => {
    const journals = [
      expense("店B", { partnerId: "p1" }),
      expense("店B", { partnerId: "p1" }),
      expense("店B", { partnerId: "p2" }),
    ];
    expect(seedRules(journals, accounts)).toEqual([]);
    const agreed = [expense("店B", { partnerId: "p1" }), expense("店B", { partnerId: "p1" })];
    expect(seedRules(agreed, accounts)[0]?.partnerId).toBe("p1");
  });

  it("対象は有効な manual・import_freee の仕訳だけ", () => {
    const journals = [
      expense("店C"),
      expense("店C", {}, { source: "statement" }),
      expense("店C", {}, { source: "recurring" }),
      expense("店C", {}, { status: "voided" }),
    ];
    expect(seedRules(journals, accounts)).toEqual([]); // 数えるのは 1 件だけ
    expect(
      seedRules([expense("店C"), expense("店C", {}, { source: "import_freee" })], accounts),
    ).toHaveLength(1);
  });

  it("現金・預金・未払金の行が 1 つと相手の行が 1 つの仕訳だけ（行が 3 つ以上、両方が口座の振替は対象外）", () => {
    const three = (): Journal => {
      const j = expense("店D");
      j.lines.push(line({ lineNo: 3, side: "debit", accountId: supplies }));
      return j;
    };
    expect(seedRules([three(), three()], accounts)).toEqual([]);
    const transfer = (): Journal => {
      const j = expense("店D", { accountId: idOf("現金") });
      return j;
    };
    expect(seedRules([transfer(), transfer()], accounts)).toEqual([]);
  });

  it("摘要がない仕訳は対象外。相手の行の摘要がなければ口座の側の摘要を使う", () => {
    expect(seedRules([expense(null), expense(null)], accounts)).toEqual([]);
    const own = (): Journal => {
      const j = expense(null);
      (j.lines[1] as JournalLine).description = "店E 001";
      return j;
    };
    expect(seedRules([own(), own()], accounts)[0]?.normalizedContent).toBe("店E#");
  });

  it("相手が事業主貸・事業主借の仕訳は、私用の判定のルールになる", () => {
    const drawing = idOf("事業主貸");
    const journals = [
      expense("店F", { accountId: drawing, taxCategory: "OUT_OF_SCOPE" }),
      expense("店F", { accountId: drawing, taxCategory: "OUT_OF_SCOPE" }),
    ];
    expect(seedRules(journals, accounts)[0]).toMatchObject({
      purpose: "private",
      counterAccountId: drawing,
    });
  });

  it("科目の一覧に口座の科目がなければ何も作らない", () => {
    const empty: Account[] = [];
    expect(seedRules([expense("店G"), expense("店G")], empty)).toEqual([]);
  });
});
