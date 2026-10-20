import { BlueReturn } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { buildBlueReturn } from "../../src/blue-return/build.ts";
import { formForYear } from "../../src/blue-return/form.ts";
import type { CarryForwardBalance } from "../../src/carry-forward.ts";
import type { OpeningInput } from "../../src/reports/common.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { Account, ClosingNote, PostedLine } from "../../src/types.ts";
import { makeAccount, makeFiscalPeriod } from "../arbitraries.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const period = makeFiscalPeriod(2025);
const form = formForYear(2025);
const id = accountIdOf;

let seq = 0;
/** 仕訳 1 件（借方・貸方の 2 行） */
function entry(debit: string, credit: string, amount: number, date = "2025-06-30"): PostedLine[] {
  seq += 1;
  return (["debit", "credit"] as const).map((side, i) => ({
    journalId: `j-${seq}`,
    journalNo: seq,
    date,
    memo: null,
    status: "active",
    lineNo: i + 1,
    side,
    accountId: side === "debit" ? debit : credit,
    accountName: "",
    subAccountId: null,
    subAccountName: null,
    amount,
    taxCategory: "OUT_OF_SCOPE",
    taxAmount: 0,
    partnerId: null,
    partnerName: null,
    description: null,
  }));
}

const op = (code: string, side: "debit" | "credit", amount: number): OpeningInput => ({
  accountId: id(code),
  subAccountId: null,
  side,
  amount,
});

type PriorPeriod = {
  fiscalYear: number;
  status: "open" | "closed";
  closing: CarryForwardBalance[];
};

const build = (
  over: {
    opening?: OpeningInput[];
    lines?: PostedLine[];
    accounts?: readonly Account[];
    priorPeriod?: PriorPeriod | null;
    closingNotes?: ClosingNote[];
  } = {},
) =>
  buildBlueReturn({
    period,
    accounts: over.accounts ?? INDIVIDUAL_ACCOUNT_LIST,
    lines: over.lines ?? [],
    deductionAnswers: null,
    taxParameters: TAX_PARAMETERS,
    opening: over.opening ?? [],
    priorPeriod: over.priorPeriod ?? null,
    closingNotes: over.closingNotes ?? [],
  });

type Built = ReturnType<typeof build>;
type When = "opening" | "closing";
type Side = "assets" | "liabilityEquity";

const rowsOf = (r: Built, when: When, side: Side) => r.page4[when][side].rows;
const amountAt = (r: Built, when: When, side: Side, label: string) => {
  const row = rowsOf(r, when, side).find((x) => x.label === label);
  if (row === undefined) throw new Error(`行がありません: ${label}`);
  return row.amount;
};
const codes = (r: Built) => r.warnings.map((w) => w.code);
const warningsOf = (r: Built, code: string) => r.warnings.filter((w) => w.code === code);
const sumShown = (rows: readonly { amount: number | null }[]) =>
  rows.reduce((s, x) => s + (x.amount ?? 0), 0);
const INCOME = "青色申告特別控除前の所得金額";

/** 期首: 現金 300,000 売掛金 200,000 / 未払金 50,000 元入金 450,000 */
const OPENING = [
  op("1010", "debit", 300_000),
  op("1030", "debit", 200_000),
  op("2020", "credit", 50_000),
  op("3020", "credit", 450_000),
];

/** 売上 1,000,000、通信費 200,000、事業主貸 100,000、事業主借 30,000、普通預金へ 500,000 */
const YEAR_LINES = () => [
  ...entry(id("1010"), id("4010"), 1_000_000),
  ...entry(id("5120"), id("1010"), 200_000),
  ...entry(id("3090"), id("1010"), 100_000),
  ...entry(id("1010"), id("3010"), 30_000),
  ...entry(id("1020"), id("1010"), 500_000),
];

/**
 * 前の年度の期末: 現金 300,000 売掛金 200,000 事業主貸 80,000 通信費 190,000 /
 * 未払金 50,000 事業主借 20,000 元入金 300,000 売上 400,000。
 * 繰越の元入金 = 300,000 + 20,000 + (400,000 − 190,000) − 80,000 = 450,000（OPENING と一致）
 */
const PRIOR_CLOSING: CarryForwardBalance[] = [
  { accountId: id("1010"), subAccountId: null, closing: 300_000 },
  { accountId: id("1030"), subAccountId: null, closing: 200_000 },
  { accountId: id("3090"), subAccountId: null, closing: 80_000 },
  { accountId: id("5120"), subAccountId: null, closing: 190_000 },
  { accountId: id("2020"), subAccountId: null, closing: -50_000 },
  { accountId: id("3010"), subAccountId: null, closing: -20_000 },
  { accountId: id("3020"), subAccountId: null, closing: -300_000 },
  { accountId: id("4010"), subAccountId: null, closing: -400_000 },
];
const PRIOR_CLOSED: PriorPeriod = { fiscalYear: 2024, status: "closed", closing: PRIOR_CLOSING };

const formRowCount = (side: "asset" | "liability_equity") =>
  form.bsRows.filter((r) => r.side === side).length;

describe("buildBlueReturn の4ページ（T027, US4, FR-028〜032, R8）", () => {
  it("シナリオ1: 期首・期末の各行と合計が一致し、期末の資本の部に欄43。期首の所得・事業主貸・事業主借は空欄", () => {
    const r = build({ opening: OPENING, lines: YEAR_LINES() });
    expect(BlueReturn.safeParse(r).success).toBe(true);

    // 様式の行の数と並びのとおり（期首と期末で同じ行）
    for (const when of ["opening", "closing"] as const) {
      expect(rowsOf(r, when, "assets")).toHaveLength(formRowCount("asset"));
      expect(rowsOf(r, when, "liabilityEquity")).toHaveLength(formRowCount("liability_equity"));
    }
    expect(rowsOf(r, "opening", "assets").map((x) => x.label)).toEqual(
      rowsOf(r, "closing", "assets").map((x) => x.label),
    );

    // 期首
    expect(amountAt(r, "opening", "assets", "現金")).toBe(300_000);
    expect(amountAt(r, "opening", "assets", "売掛金")).toBe(200_000);
    expect(amountAt(r, "opening", "assets", "当座預金")).toBe(0);
    expect(amountAt(r, "opening", "assets", "事業主貸")).toBeNull();
    expect(amountAt(r, "opening", "liabilityEquity", "未払金")).toBe(50_000);
    expect(amountAt(r, "opening", "liabilityEquity", "事業主借")).toBeNull();
    expect(amountAt(r, "opening", "liabilityEquity", "元入金")).toBe(450_000);
    expect(amountAt(r, "opening", "liabilityEquity", INCOME)).toBeNull();
    expect(r.page4.opening.assets.total).toBe(500_000);
    expect(r.page4.opening.liabilityEquity.total).toBe(500_000);

    // 期末（普通預金は「その他の預金」）
    expect(amountAt(r, "closing", "assets", "現金")).toBe(530_000);
    expect(amountAt(r, "closing", "assets", "その他の預金")).toBe(500_000);
    expect(amountAt(r, "closing", "assets", "売掛金")).toBe(200_000);
    expect(amountAt(r, "closing", "assets", "事業主貸")).toBe(100_000);
    expect(amountAt(r, "closing", "liabilityEquity", "未払金")).toBe(50_000);
    expect(amountAt(r, "closing", "liabilityEquity", "事業主借")).toBe(30_000);
    expect(amountAt(r, "closing", "liabilityEquity", "元入金")).toBe(450_000);
    const line43 = r.page1.lines.find((l) => l.no === 43)?.amount;
    expect(line43).toBe(800_000);
    expect(amountAt(r, "closing", "liabilityEquity", INCOME)).toBe(line43);
    expect(r.page4.closing.assets.total).toBe(1_330_000);
    expect(r.page4.closing.liabilityEquity.total).toBe(1_330_000);

    // 合計は表示した金額の和
    for (const when of ["opening", "closing"] as const) {
      for (const side of ["assets", "liabilityEquity"] as const) {
        expect(r.page4[when][side].total).toBe(sumShown(rowsOf(r, when, side)));
      }
    }
    expect(codes(r)).not.toContain("OPENING_OWNER_ACCOUNTS");
  });

  it("シナリオ2: 前の年度から正しく繰り越した期首なら、繰越の検査は一致（警告なし）", () => {
    const r = build({ opening: OPENING, lines: YEAR_LINES(), priorPeriod: PRIOR_CLOSED });
    expect(r.page4.carryForwardCheck).toBe("matched");
    expect(codes(r)).not.toContain("OPENING_MISMATCH");
    expect(codes(r)).not.toContain("PRIOR_PERIOD_OPEN");
  });

  it("シナリオ3: 期首の売掛金を前の年度の期末と違う額で登録すると、売掛金と元入金に OPENING_MISMATCH（期待値・実際・差額）", () => {
    const opening = [
      op("1010", "debit", 300_000),
      op("1030", "debit", 250_000),
      op("2020", "credit", 50_000),
      op("3020", "credit", 500_000),
    ];
    const r = build({ opening, lines: YEAR_LINES(), priorPeriod: PRIOR_CLOSED });
    expect(r.page4.carryForwardCheck).toBe("mismatched");
    expect(warningsOf(r, "OPENING_MISMATCH").map((w) => w.details)).toEqual([
      {
        accountId: id("1030"),
        subAccountId: null,
        accountName: "売掛金",
        expected: 200_000,
        actual: 250_000,
        diff: 50_000,
        note: null,
      },
      {
        accountId: id("3020"),
        subAccountId: null,
        accountName: "元入金",
        expected: 450_000,
        actual: 500_000,
        diff: 50_000,
        note: null,
      },
    ]);
    // 期首の貸借は登録どおりで一致する
    expect(r.page4.opening.assets.total).toBe(550_000);
    expect(r.page4.opening.liabilityEquity.total).toBe(550_000);
  });

  it("シナリオ4: 差の説明（opening_difference）は警告と4ページに添えられ、差額は変わらない", () => {
    const opening = [
      op("1010", "debit", 300_000),
      op("1030", "debit", 250_000),
      op("2020", "credit", 50_000),
      op("3020", "credit", 500_000),
    ];
    const body = "前の年度は12月の売上を未収に計上していなかった";
    const notes: ClosingNote[] = [
      { fiscalYear: 2025, kind: "opening_difference", body, updatedAt: "2026-02-01T00:00:00Z" },
      {
        fiscalYear: 2025,
        kind: "special_circumstances",
        body: "特殊事情",
        updatedAt: "2026-02-01T00:00:00Z",
      },
    ];
    const without = build({ opening, lines: YEAR_LINES(), priorPeriod: PRIOR_CLOSED });
    const r = build({
      opening,
      lines: YEAR_LINES(),
      priorPeriod: PRIOR_CLOSED,
      closingNotes: notes,
    });
    const mismatches = warningsOf(r, "OPENING_MISMATCH");
    expect(mismatches).toHaveLength(2);
    for (const w of mismatches) expect(w.details?.note).toBe(body);
    expect(mismatches.map((w) => w.details?.diff)).toEqual(
      warningsOf(without, "OPENING_MISMATCH").map((w) => w.details?.diff),
    );
    expect(r.page4.openingDifferenceNote).toBe(body);
    expect(without.page4.openingDifferenceNote).toBeNull();
  });

  it("シナリオ5: 期末の売掛金が負なら NEGATIVE_BALANCE（001 と同じ判定）。貸借は一致したまま", () => {
    const r = build({ opening: OPENING, lines: entry(id("1010"), id("1030"), 300_000) });
    const negative = warningsOf(r, "NEGATIVE_BALANCE");
    expect(negative.map((w) => w.details)).toEqual([
      { accountId: id("1030"), accountName: "売掛金", balance: -100_000 },
    ]);
    expect(amountAt(r, "closing", "assets", "売掛金")).toBe(-100_000);
    expect(r.page4.closing.assets.total).toBe(r.page4.closing.liabilityEquity.total);
  });

  it("シナリオ6: 開業費の残高が期首と期末で同じなら DEFERRED_ASSET_NOT_AMORTIZED。償却すれば出ない", () => {
    const opening = [op("1010", "debit", 300_000), op("1080", "debit", 100_000)];
    const capital = op("3020", "credit", 400_000);
    const r = build({ opening: [...opening, capital] });
    expect(warningsOf(r, "DEFERRED_ASSET_NOT_AMORTIZED").map((w) => w.details)).toEqual([
      { accountId: id("1080"), accountName: "開業費", amount: 100_000 },
    ]);
    // 開業費は様式に行がないので、科目名つきの空欄の行に出る（期首・期末とも同じ行）
    expect(amountAt(r, "opening", "assets", "開業費")).toBe(100_000);
    expect(amountAt(r, "closing", "assets", "開業費")).toBe(100_000);

    const amortized = build({
      opening: [...opening, capital],
      lines: entry(id("5180"), id("1080"), 20_000),
    });
    expect(codes(amortized)).not.toContain("DEFERRED_ASSET_NOT_AMORTIZED");
    expect(amountAt(amortized, "closing", "assets", "開業費")).toBe(80_000);
  });

  it("シナリオ7: 前の年度の帳簿がなければ、繰越の検査は「前の年度なし」で警告なし", () => {
    const opening = [op("1030", "debit", 999), op("3020", "credit", 999)];
    const r = build({ opening, priorPeriod: null });
    expect(r.page4.carryForwardCheck).toBe("no_prior_year");
    expect(codes(r)).not.toContain("OPENING_MISMATCH");
    expect(codes(r)).not.toContain("PRIOR_PERIOD_OPEN");
  });

  it("前の年度が締め前でも検査し、PRIOR_PERIOD_OPEN を出す", () => {
    const r = build({
      opening: OPENING,
      priorPeriod: { ...PRIOR_CLOSED, status: "open" },
    });
    expect(r.page4.carryForwardCheck).toBe("matched");
    expect(warningsOf(r, "PRIOR_PERIOD_OPEN").map((w) => w.details)).toEqual([
      { fiscalYear: 2024 },
    ]);
  });

  it("期首に事業主貸・事業主借があれば金額を表示し OPENING_OWNER_ACCOUNTS。期首の貸借は表示した金額で一致", () => {
    const opening = [
      op("1010", "debit", 300_000),
      op("3090", "debit", 50_000),
      op("3010", "credit", 20_000),
      op("3020", "credit", 330_000),
    ];
    const r = build({ opening, lines: YEAR_LINES() });
    expect(amountAt(r, "opening", "assets", "事業主貸")).toBe(50_000);
    expect(amountAt(r, "opening", "liabilityEquity", "事業主借")).toBe(20_000);
    expect(r.page4.opening.assets.total).toBe(350_000);
    expect(r.page4.opening.liabilityEquity.total).toBe(350_000);
    // 期末の事業主貸・事業主借は期首を含む残高
    expect(amountAt(r, "closing", "assets", "事業主貸")).toBe(150_000);
    expect(amountAt(r, "closing", "liabilityEquity", "事業主借")).toBe(50_000);
    expect(r.page4.closing.assets.total).toBe(r.page4.closing.liabilityEquity.total);

    const owner = warningsOf(r, "OPENING_OWNER_ACCOUNTS");
    expect(owner).toHaveLength(1);
    expect(owner[0]?.details?.accounts).toEqual([
      { accountId: id("3090"), accountName: "事業主貸", amount: 50_000 },
      { accountId: id("3010"), accountName: "事業主借", amount: 20_000 },
    ]);
  });

  it("期首に収益・費用の残高があれば期首の所得の欄に出し、OPENING_OWNER_ACCOUNTS に含める（期末の所得は期首の損益を含む）", () => {
    const opening = [
      op("1010", "debit", 300_000),
      op("4010", "credit", 70_000),
      op("3020", "credit", 230_000),
    ];
    const r = build({ opening, lines: entry(id("1010"), id("4010"), 10_000) });
    expect(amountAt(r, "opening", "liabilityEquity", INCOME)).toBe(70_000);
    expect(r.page4.opening.assets.total).toBe(r.page4.opening.liabilityEquity.total);
    expect(amountAt(r, "closing", "liabilityEquity", INCOME)).toBe(80_000);
    expect(r.page4.closing.assets.total).toBe(r.page4.closing.liabilityEquity.total);
    expect(warningsOf(r, "OPENING_OWNER_ACCOUNTS")[0]?.details?.accounts).toEqual([
      { accountId: id("4010"), accountName: "売上高", amount: 70_000 },
    ]);
  });

  it("様式に行のない科目と利用者が足した科目は、区分の空欄の行に科目名つきで出す。あふれた分は最後の行に「その他」でまとめて警告", () => {
    const userAssets = [
      makeAccount("asset", { code: "1090", name: "敷金", sortOrder: 1_500 }),
      makeAccount("asset", { code: "1091", name: "保証金", sortOrder: 1_510 }),
    ];
    const userLiability = makeAccount("liability", {
      code: "2060",
      name: "長期未払金",
      sortOrder: 2_500,
    });
    const accounts = [...INDIVIDUAL_ACCOUNT_LIST, ...userAssets, userLiability];
    const opening: OpeningInput[] = [
      op("1050", "debit", 1_000),
      op("1070", "debit", 2_000),
      op("1080", "debit", 3_000),
      { accountId: userAssets[0]?.id ?? "", side: "debit", amount: 4_000 },
      op("2030", "credit", 500),
      { accountId: userLiability.id, side: "credit", amount: 700 },
      op("3020", "credit", 8_800),
    ];
    const lines = entry(userAssets[1]?.id ?? "", id("1010"), 6_000);
    const r = build({ accounts, opening, lines });

    const blankLabels = (when: When) =>
      rowsOf(r, when, "assets")
        .slice(16, 16 + 4)
        .map((x) => x.label);
    // 空欄の行は4行（仮払金・一括償却資産・開業費、残りの敷金と保証金は「その他」）
    expect(blankLabels("opening")).toEqual(["仮払金", "一括償却資産", "開業費", "その他"]);
    expect(blankLabels("closing")).toEqual(blankLabels("opening"));
    expect(amountAt(r, "opening", "assets", "その他")).toBe(4_000);
    expect(amountAt(r, "closing", "assets", "その他")).toBe(10_000);
    expect(amountAt(r, "closing", "liabilityEquity", "未払費用")).toBe(500);
    expect(amountAt(r, "closing", "liabilityEquity", "長期未払金")).toBe(700);
    expect(rowsOf(r, "closing", "assets")).toHaveLength(formRowCount("asset"));

    for (const when of ["opening", "closing"] as const) {
      expect(r.page4[when].assets.total).toBe(r.page4[when].liabilityEquity.total);
    }
    expect(r.page4.closing.assets.total).toBe(10_000 + 6_000 - 6_000 + 0 + 0);

    const overflow = warningsOf(r, "OPTIONAL_LINES_OVERFLOW");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.details).toMatchObject({
      page: 4,
      side: "asset",
      capacity: 4,
      count: 5,
      omitted: [
        { accountId: userAssets[0]?.id, name: "敷金", amount: 4_000 },
        { accountId: userAssets[1]?.id, name: "保証金", amount: 6_000 },
      ],
    });
  });

  it("使っていない空欄の行は科目名なしの空欄（null）", () => {
    const r = build({ opening: OPENING });
    const blanks = rowsOf(r, "closing", "assets").slice(16, 20);
    expect(blanks).toEqual(Array.from({ length: 4 }, () => ({ label: "", amount: null })));
  });
});
