import { describe, expect, it } from "vitest";
import { canonicalSnapshot, planImport } from "../../src/import/freee/plan.ts";
import type { JournalSignature } from "../../src/import/types.ts";
import { makeFiscalPeriod } from "../arbitraries.ts";
import { EXPECTED_JOURNAL } from "../fixtures/freee/expected.ts";
import {
  accountId,
  fixtureJournals,
  freeeJournal,
  PERIOD_2025,
  planInput,
  ref,
  single,
  sub,
  withInactive,
} from "./import-setup.ts";

const fixture = () => planImport(planInput(fixtureJournals()));

function itemOf(plan: ReturnType<typeof planImport>, id: string) {
  const item = plan.preview.items.find((i) => i.freeeJournalId === id);
  if (item === undefined) throw new Error(`判定がない: ${id}`);
  return item;
}

const cashSale = (id: string, date: string, amount = 1_100, extra = {}) =>
  freeeJournal(
    id,
    date,
    [
      { side: "debit", accountName: "現金", amount },
      {
        side: "credit",
        accountName: "売上高",
        amount,
        taxName: "課税売上10%",
        taxAmount: Math.floor(amount / 11),
      },
    ],
    extra,
  );

describe("planImport: フィクスチャ", () => {
  it("年初付の決算振替は既定で対象外、それ以外の14件は new、ready", () => {
    const plan = fixture();
    expect(itemOf(plan, "900000011")).toMatchObject({
      decision: "excluded",
      reason: "PRIOR_YEAR_CLOSING",
    });
    expect(plan.preview.counts).toEqual({
      new: EXPECTED_JOURNAL.journalCount - 1,
      already: 0,
      excluded: 1,
      rejected: 0,
      warnings: plan.preview.warnings.length,
    });
    expect(plan.preview.years).toEqual([
      {
        fiscalYear: 2025,
        hasPeriod: true,
        closed: false,
        counts: { new: 14, already: 0, excluded: 1, rejected: 0 },
      },
    ]);
    expect(plan.preview.ready).toBe(true);
    expect(plan.preview.totals.debit).toBe(plan.preview.totals.credit);
    expect(plan.preview.totals.debit).toBeGreaterThan(0);
  });

  it("対応表は、判定まで進んだ仕訳に出てくる名前だけを並べる（対象外の決算振替の「損益」は出さない）", () => {
    const plan = fixture();
    const names = plan.preview.mappings.accounts.map((r) => r.sourceName);
    expect(names).not.toContain("損益");
    expect(plan.preview.mappings.accounts.every((r) => r.status === "proposed")).toBe(true);
    expect(plan.preview.mappings.taxes.map((r) => r.sourceName).sort()).toEqual(
      ["対象外", "課税売上10%", "課対仕入10%", "課対仕入8%(軽)"].sort(),
    );
  });

  it("決算振替を include で対象に戻すと、損益が未定のため UNMAPPED で ready = false", () => {
    const plan = planImport(planInput(fixtureJournals(), { options: { include: ["900000011"] } }));
    expect(itemOf(plan, "900000011")).toMatchObject({ decision: "rejected", reason: "UNMAPPED" });
    expect(plan.preview.mappings.accounts).toContainEqual({
      sourceName: "損益",
      status: "unmapped",
    });
    expect(plan.preview.ready).toBe(false);
  });

  it("exclude で個別に外すと USER_EXCLUDED", () => {
    const plan = planImport(planInput(fixtureJournals(), { options: { exclude: ["900000022"] } }));
    expect(itemOf(plan, "900000022")).toMatchObject({
      decision: "excluded",
      reason: "USER_EXCLUDED",
    });
    expect(plan.preview.counts.new).toBe(13);
  });

  it("下書きは帳簿の科目・仮の ID で組み立て、摘要は元の文字のまま、税額は計算し直した値", () => {
    const plan = fixture();
    expect(itemOf(plan, "900000022")).toEqual({
      freeeJournalId: "900000022",
      freeeJournalNo: "5011001",
      date: "2025-01-10",
      decision: "new",
      warnings: [],
      draft: {
        date: "2025-01-10",
        lines: [
          {
            side: "debit",
            accountId: accountId("1030"),
            amount: 330_000,
            taxCategory: "OUT_OF_SCOPE",
            taxAmount: 0,
            partnerId: "new:partner:株式会社サンプル",
            description: "１月分　業務委託料",
          },
          {
            side: "credit",
            accountId: accountId("4010"),
            amount: 330_000,
            taxCategory: "SALES_10",
            taxAmount: 30_000,
            partnerId: "new:partner:株式会社サンプル",
            description: "１月分　業務委託料",
            tagIds: ["new:tag:案件A"],
          },
        ],
      },
    });
    const card = itemOf(plan, "900000044").draft?.lines[1];
    expect(card).toMatchObject({
      accountId: accountId("2020"),
      subAccountId: `new:sub:${accountId("2020")}:ABCカード`,
    });
    const receipt = itemOf(plan, EXPECTED_JOURNAL.receiptWithWithholdingId).draft;
    expect(receipt?.memo).toBe("源泉所得税\n振込手数料");
    expect(receipt?.lines[0]).not.toHaveProperty("subAccountId");
  });

  it("toCreate に新しい補助科目・取引先・タグが重複なく初出の順に並ぶ", () => {
    expect(fixture().preview.toCreate).toEqual({
      subAccounts: [{ accountId: accountId("2020"), name: "ABCカード" }],
      partners: ["株式会社サンプル", "(株)テスト飯店"],
      tags: ["案件A"],
    });
  });

  it("既存の補助科目・取引先・タグは作らず、その ID を使う（名前は NFKC で照合）", () => {
    const plan = planImport(
      planInput(fixtureJournals(), {
        subAccounts: [sub("sub-abc", "2020", "ＡＢＣカード")],
        partners: [
          { id: "p-1", name: "株式会社サンプル", honorific: null, memo: null, isActive: true },
        ],
        tags: [{ id: "t-1", name: "案件Ａ" }],
      }),
    );
    expect(plan.preview.toCreate).toEqual({
      subAccounts: [],
      partners: ["(株)テスト飯店"],
      tags: [],
    });
    const lines = itemOf(plan, "900000022").draft?.lines;
    expect(lines?.[1]).toMatchObject({ partnerId: "p-1", tagIds: ["t-1"] });
    expect(itemOf(plan, "900000044").draft?.lines[1]?.subAccountId).toBe("sub-abc");
  });

  it("費用に売上の税区分 → TAX_CATEGORY_SUSPICIOUS（仕訳とファイルの警告の両方）", () => {
    const plan = fixture();
    expect(itemOf(plan, EXPECTED_JOURNAL.suspiciousTaxId).warnings).toEqual([
      "TAX_CATEGORY_SUSPICIOUS",
    ]);
    expect(plan.preview.warnings).toContainEqual(
      expect.objectContaining({
        code: "TAX_CATEGORY_SUSPICIOUS",
        freeeJournalId: EXPECTED_JOURNAL.suspiciousTaxId,
      }),
    );
  });

  it("すべて取込済みなら new = 0 で ready = false", () => {
    const g = fixtureJournals();
    const plan = planImport(
      planInput(g, { activeRefs: g.journals.map((j) => ref(j.freeeJournalId)) }),
    );
    expect(plan.preview.counts).toMatchObject({ new: 0, already: 15 });
    expect(plan.preview.ready).toBe(false);
  });
});

describe("planImport: 取込不可", () => {
  it("UNBALANCED", () => {
    const j = freeeJournal("u1", "2025-03-01", [
      { side: "debit", accountName: "現金", amount: 1_000 },
      { side: "credit", accountName: "売上高", amount: 900 },
    ]);
    expect(itemOf(planImport(planInput(single([j]))), "u1")).toMatchObject({
      decision: "rejected",
      reason: "UNBALANCED",
    });
  });

  it("借方だけ・貸方だけの仕訳は UNBALANCED", () => {
    const j = freeeJournal("u2", "2025-03-01", [
      { side: "debit", accountName: "現金", amount: 1_000 },
      { side: "debit", accountName: "売上高", amount: 1_000 },
    ]);
    expect(itemOf(planImport(planInput(single([j]))), "u2").reason).toBe("UNBALANCED");
  });

  it("金額が上限以上 → INVALID_AMOUNT", () => {
    const j = cashSale("big", "2025-03-01", 1_000_000_000_000);
    expect(itemOf(planImport(planInput(single([j]))), "big").reason).toBe("INVALID_AMOUNT");
  });

  it("まとめる段階の取込不可（INVALID_AMOUNT・MISSING_FIELD・LINE_COUNT_MISMATCH）をそのまま判定にする", () => {
    const plan = planImport(
      planInput({
        journals: [],
        rejected: [
          {
            freeeJournalId: "r1",
            freeeJournalNo: "1",
            date: "2025-02-01",
            adjustment: false,
            code: "INVALID_AMOUNT",
          },
          {
            freeeJournalId: "r2",
            freeeJournalNo: null,
            date: "2025/02/30",
            adjustment: false,
            code: "MISSING_FIELD",
          },
          {
            freeeJournalId: "r3",
            freeeJournalNo: "3",
            date: "2025-02-03",
            adjustment: false,
            code: "LINE_COUNT_MISMATCH",
          },
        ],
      }),
    );
    const items = [...plan.preview.items].sort((a, b) =>
      a.freeeJournalId.localeCompare(b.freeeJournalId),
    );
    expect(items.map((i) => [i.freeeJournalId, i.decision, i.reason])).toEqual([
      ["r1", "rejected", "INVALID_AMOUNT"],
      ["r2", "rejected", "MISSING_FIELD"],
      ["r3", "rejected", "LINE_COUNT_MISMATCH"],
    ]);
    expect(plan.preview.counts.rejected).toBe(3);
    expect(plan.preview.ready).toBe(false);
  });

  it("まとめる段階の取込不可でも、取込済み・年度の未選択が優先する", () => {
    const rejected = [
      {
        freeeJournalId: "r1",
        freeeJournalNo: "1",
        date: "2025-02-01",
        adjustment: false,
        code: "INVALID_AMOUNT" as const,
      },
    ];
    expect(
      planImport(planInput({ journals: [], rejected }, { activeRefs: [ref("r1")] })).preview
        .items[0]?.reason,
    ).toBe("ALREADY_IMPORTED");
    expect(
      planImport(planInput({ journals: [], rejected }, { options: { fiscalYears: [2026] } }))
        .preview.items[0]?.reason,
    ).toBe("YEAR_NOT_SELECTED");
  });

  it("OUT_OF_PERIOD: 最初の会計期間より前と、最後より後で案内が違う（research R19）", () => {
    const plan = planImport(
      planInput(single([cashSale("before", "2024-12-31"), cashSale("after", "2026-01-01")])),
    );
    const before = itemOf(plan, "before");
    const after = itemOf(plan, "after");
    expect(before).toMatchObject({ decision: "rejected", reason: "OUT_OF_PERIOD" });
    expect(after).toMatchObject({ decision: "rejected", reason: "OUT_OF_PERIOD" });
    expect(before.message).toContain("開始年度より前");
    expect(after.message).toContain("翌年度");
    expect(plan.preview.years).toEqual([
      expect.objectContaining({ fiscalYear: 2024, hasPeriod: false }),
      expect.objectContaining({ fiscalYear: 2026, hasPeriod: false }),
    ]);
  });

  it("PERIOD_CLOSED", () => {
    const closed = {
      ...PERIOD_2025,
      status: "closed" as const,
      closedAt: "2026-03-01T00:00:00.000Z",
    };
    const plan = planImport(
      planInput(single([cashSale("c1", "2025-03-01")]), { periods: [closed] }),
    );
    expect(itemOf(plan, "c1")).toMatchObject({ decision: "rejected", reason: "PERIOD_CLOSED" });
    expect(plan.preview.years[0]).toMatchObject({ fiscalYear: 2025, closed: true });
  });

  it("UNMAPPED: 対応先のない科目・税区分", () => {
    const unknownAccount = freeeJournal("m1", "2025-03-01", [
      { side: "debit", accountName: "謎の科目", amount: 100 },
      { side: "credit", accountName: "現金", amount: 100 },
    ]);
    const unknownTax = freeeJournal("m2", "2025-03-01", [
      { side: "debit", accountName: "通信費", amount: 100, taxName: "謎の税区分" },
      { side: "credit", accountName: "現金", amount: 100 },
    ]);
    const plan = planImport(
      planInput(single([unknownAccount, unknownTax, cashSale("ok", "2025-03-02")])),
    );
    expect(itemOf(plan, "m1")).toMatchObject({ decision: "rejected", reason: "UNMAPPED" });
    expect(itemOf(plan, "m2")).toMatchObject({ decision: "rejected", reason: "UNMAPPED" });
    expect(plan.preview.mappings.accounts).toContainEqual({
      sourceName: "謎の科目",
      status: "unmapped",
    });
    expect(plan.preview.mappings.taxes).toContainEqual({
      sourceName: "謎の税区分",
      status: "unmapped",
    });
    expect(plan.preview.counts.new).toBe(1);
    expect(plan.preview.ready).toBe(false);
  });

  it("ACCOUNT_INACTIVE: 保存済みの対応先が使用停止の科目、または使用停止の補助科目", () => {
    const j = cashSale("i1", "2025-03-01");
    const inactiveAccount = planImport(
      planInput(single([j]), {
        accounts: withInactive(["1010"]),
        savedMappings: {
          accounts: [{ sourceName: "現金", accountId: accountId("1010") }],
          taxes: [],
        },
      }),
    );
    expect(itemOf(inactiveAccount, "i1")).toMatchObject({
      decision: "rejected",
      reason: "ACCOUNT_INACTIVE",
    });

    const inactiveSub = planImport(
      planInput(single([j]), {
        subAccounts: [sub("sub-old", "1010", "手元", false)],
        savedMappings: {
          accounts: [{ sourceName: "現金", accountId: accountId("1010"), subAccountId: "sub-old" }],
          taxes: [],
        },
      }),
    );
    expect(itemOf(inactiveSub, "i1")).toMatchObject({
      decision: "rejected",
      reason: "ACCOUNT_INACTIVE",
    });
  });

  it("消費税の設定がない日付 → MISSING_FIELD", () => {
    const plan = planImport(planInput(single([cashSale("t1", "2025-03-01")]), { taxSettings: [] }));
    expect(itemOf(plan, "t1")).toMatchObject({ decision: "rejected", reason: "MISSING_FIELD" });
  });
});

describe("planImport: 取込対象外", () => {
  it("fiscalYears を指定すると、選ばなかった年度は YEAR_NOT_SELECTED", () => {
    const periods = [makeFiscalPeriod(2024), PERIOD_2025];
    const plan = planImport(
      planInput(single([cashSale("y24", "2024-05-01"), cashSale("y25", "2025-05-01")]), {
        periods,
        options: { fiscalYears: [2025] },
      }),
    );
    expect(itemOf(plan, "y24")).toMatchObject({
      decision: "excluded",
      reason: "YEAR_NOT_SELECTED",
    });
    expect(itemOf(plan, "y25").decision).toBe("new");
  });

  it("PRIOR_YEAR_CLOSING は exclude より優先しない（USER_EXCLUDED が先）", () => {
    const closing = freeeJournal(
      "cl",
      "2025-01-01",
      [
        { side: "debit", accountName: "損益", amount: 100 },
        { side: "credit", accountName: "元入金", amount: 100 },
      ],
      { adjustment: true },
    );
    const plan = planImport(planInput(single([closing]), { options: { exclude: ["cl"] } }));
    expect(itemOf(plan, "cl").reason).toBe("USER_EXCLUDED");
  });
});

describe("planImport: 警告", () => {
  it("TAX_AMOUNT_MISMATCH: freee の税金額と INV-10 の計算が違う。保存する税額は計算し直した値", () => {
    const j = freeeJournal("w1", "2025-03-01", [
      {
        side: "debit",
        accountName: "通信費",
        amount: 1_100,
        taxName: "課対仕入10%",
        taxAmount: 99,
      },
      { side: "credit", accountName: "現金", amount: 1_100 },
    ]);
    const plan = planImport(planInput(single([j])));
    const item = itemOf(plan, "w1");
    expect(item.warnings).toEqual(["TAX_AMOUNT_MISMATCH"]);
    expect(item.draft?.lines[0]).toMatchObject({ taxCategory: "PURCHASE_10", taxAmount: 100 });
    expect(plan.preview.counts.warnings).toBe(1);
  });

  it("免税事業者の期間は税額 0 で保存し、freee の税金額が税率どおりなら警告しない", () => {
    const j = freeeJournal("w2", "2025-03-01", [
      {
        side: "debit",
        accountName: "通信費",
        amount: 1_100,
        taxName: "課対仕入10%",
        taxAmount: 100,
      },
      { side: "credit", accountName: "現金", amount: 1_100 },
    ]);
    const exempt = [
      {
        effectiveFrom: "2019-01-01",
        taxpayerStatus: "exempt" as const,
        accountingMethod: "tax_included" as const,
      },
    ];
    const item = itemOf(planImport(planInput(single([j]), { taxSettings: exempt })), "w2");
    expect(item.warnings).toEqual([]);
    expect(item.draft?.lines[0]).toMatchObject({ taxAmount: 0 });
  });

  it("TAX_CATEGORY_SUSPICIOUS: 収益に仕入の税区分", () => {
    const j = freeeJournal("w3", "2025-03-01", [
      { side: "debit", accountName: "現金", amount: 1_100 },
      {
        side: "credit",
        accountName: "売上高",
        amount: 1_100,
        taxName: "課対仕入10%",
        taxAmount: 100,
      },
    ]);
    expect(itemOf(planImport(planInput(single([j]))), "w3").warnings).toEqual([
      "TAX_CATEGORY_SUSPICIOUS",
    ]);
  });

  it("POSSIBLE_DUPLICATE: 同じ日付で行の組が同じ手入力の仕訳がある", () => {
    const signature: JournalSignature = {
      journalId: "manual-1",
      journalNo: 7,
      date: "2025-03-01",
      lines: [
        { side: "credit", accountId: accountId("4010"), amount: 1_100 },
        { side: "debit", accountId: accountId("1010"), amount: 1_100 },
      ],
    };
    const plan = planImport(
      planInput(single([cashSale("d1", "2025-03-01"), cashSale("d2", "2025-03-02")]), {
        manualSignatures: [signature],
      }),
    );
    expect(itemOf(plan, "d1").warnings).toEqual(["POSSIBLE_DUPLICATE"]);
    expect(itemOf(plan, "d2").warnings).toEqual([]);
    expect(plan.preview.warnings).toContainEqual(
      expect.objectContaining({
        code: "POSSIBLE_DUPLICATE",
        freeeJournalId: "d1",
        details: { journalId: "manual-1", journalNo: 7 },
      }),
    );
  });

  it("取込不可・対象外の仕訳には警告を付けない", () => {
    const j = freeeJournal("w4", "2025-03-01", [
      { side: "debit", accountName: "通信費", amount: 1_100, taxName: "課税売上10%", taxAmount: 1 },
      { side: "credit", accountName: "現金", amount: 1_100 },
    ]);
    const plan = planImport(planInput(single([j]), { options: { exclude: ["w4"] } }));
    expect(itemOf(plan, "w4").warnings).toEqual([]);
    expect(plan.preview.warnings).toEqual([]);
  });
});

describe("canonicalSnapshot（research R9）", () => {
  const base = () => fixtureJournals().journals.find((j) => j.freeeJournalId === "900000022");

  it("キーの順が決まった JSON で、同じ内容なら同じ文字列", () => {
    const j = base();
    if (j === undefined) throw new Error("仕訳がない");
    const reordered = {
      lines: j.lines.map((l) => ({
        description: l.description,
        tagNames: [...l.tagNames],
        taxAmount: l.taxAmount,
        taxName: l.taxName,
        amount: l.amount,
        accountName: l.accountName,
        side: l.side,
        ...(l.partnerName === undefined ? {} : { partnerName: l.partnerName }),
      })),
      entryMethod: "別の値",
      adjustment: j.adjustment,
      date: j.date,
      freeeJournalNo: j.freeeJournalNo,
      freeeJournalId: j.freeeJournalId,
    };
    const snapshot = canonicalSnapshot(j);
    expect(canonicalSnapshot(reordered)).toBe(snapshot);
    expect(Object.keys(JSON.parse(snapshot))).toEqual(["date", "memo", "lines"]);
    expect(Object.keys(JSON.parse(snapshot).lines[0])).toEqual([
      "side",
      "account",
      "subAccount",
      "amount",
      "tax",
      "taxAmount",
      "partner",
      "tags",
      "description",
    ]);
  });

  it("内容が違えば違う文字列", () => {
    const j = base();
    if (j === undefined) throw new Error("仕訳がない");
    const changed = { ...j, lines: j.lines.map((l) => ({ ...l, amount: l.amount + 1 })) };
    expect(canonicalSnapshot(changed)).not.toBe(canonicalSnapshot(j));
    expect(canonicalSnapshot({ ...j, memo: "備考" })).not.toBe(canonicalSnapshot(j));
  });

  it("タグは並べ替える", () => {
    const j = base();
    if (j === undefined) throw new Error("仕訳がない");
    const a = { ...j, lines: j.lines.map((l) => ({ ...l, tagNames: ["b", "a"] })) };
    const b = { ...j, lines: j.lines.map((l) => ({ ...l, tagNames: ["a", "b"] })) };
    expect(canonicalSnapshot(a)).toBe(canonicalSnapshot(b));
  });
});
