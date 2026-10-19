import { describe, expect, it } from "vitest";
import { INDIVIDUAL_ACCOUNTS } from "../src/seed/accounts.individual.ts";

const byName = (name: string) => INDIVIDUAL_ACCOUNTS.find((a) => a.name === name);

describe("勘定科目の初期セット（個人事業）", () => {
  it("科目コードと科目名が重複しない", () => {
    const codes = INDIVIDUAL_ACCOUNTS.map((a) => a.code);
    const names = INDIVIDUAL_ACCOUNTS.map((a) => a.name);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("normal_side が区分と整合する（事業主貸は例外として debit）", () => {
    for (const a of INDIVIDUAL_ACCOUNTS) {
      const expected =
        a.name === "事業主貸" || a.category === "asset" || a.category === "expense"
          ? "debit"
          : "credit";
      expect(a.normalSide, a.name).toBe(expected);
    }
  });

  it("事業主貸は純資産の控除で、貸借対照表では資産の側に表示する", () => {
    expect(byName("事業主貸")).toMatchObject({ category: "equity", reportSection: "BS_ASSET" });
  });

  it("data-model §2 の初期セットの科目がすべて含まれる", () => {
    const required = {
      asset: [
        "現金",
        "普通預金",
        "売掛金",
        "前払金",
        "仮払金",
        "工具器具備品",
        "一括償却資産",
        "開業費",
      ],
      liability: ["未払金", "未払費用", "預り金", "前受金", "借入金"],
      equity: ["元入金", "事業主借", "事業主貸"],
      revenue: ["売上高", "雑収入"],
      expense: [
        "租税公課",
        "荷造運賃",
        "水道光熱費",
        "旅費交通費",
        "通信費",
        "広告宣伝費",
        "接待交際費",
        "損害保険料",
        "修繕費",
        "消耗品費",
        "減価償却費",
        "福利厚生費",
        "給料賃金",
        "外注工賃",
        "利子割引料",
        "地代家賃",
        "貸倒金",
        "会議費",
        "諸会費",
        "支払手数料",
        "新聞図書費",
        "研修費",
        "雑費",
      ],
    } as const;
    for (const [category, names] of Object.entries(required)) {
      for (const name of names) {
        expect(byName(name), name).toMatchObject({ category });
      }
    }
  });

  it("経費の report_line は 8〜31 の範囲で、決算書の欄と対応する", () => {
    const expenses = INDIVIDUAL_ACCOUNTS.filter((a) => a.category === "expense");
    for (const a of expenses) {
      expect(a.reportSection, a.name).toBe("PL_EXPENSE");
      expect(a.reportLine, a.name).toBeGreaterThanOrEqual(8);
      expect(a.reportLine, a.name).toBeLessThanOrEqual(31);
    }
    // 青色申告決算書（一般用）: ⑧租税公課 … ㉓地代家賃 ㉔貸倒金 ㉕〜㉚任意科目 ㉛雑費
    expect(byName("租税公課")?.reportLine).toBe(8);
    expect(byName("減価償却費")?.reportLine).toBe(18);
    expect(byName("地代家賃")?.reportLine).toBe(23);
    expect(byName("貸倒金")?.reportLine).toBe(24);
    expect(byName("雑費")?.reportLine).toBe(31);
  });

  it("任意科目は 25〜30 欄で、欄が重複しない", () => {
    const optional = ["会議費", "諸会費", "支払手数料", "新聞図書費", "研修費"].map(
      (n) => byName(n)?.reportLine,
    );
    for (const line of optional) {
      expect(line).toBeGreaterThanOrEqual(25);
      expect(line).toBeLessThanOrEqual(30);
    }
    expect(new Set(optional).size).toBe(optional.length);
  });

  it("経費以外の欄で、欄8〜31を使わない", () => {
    for (const a of INDIVIDUAL_ACCOUNTS.filter((x) => x.category !== "expense")) {
      if (a.reportLine !== null) {
        expect(a.reportLine < 8 || a.reportLine > 31, a.name).toBe(true);
      }
    }
    expect(byName("売上高")?.reportLine).toBe(1);
  });

  it("sort_order は決算書の順（資産・負債・純資産・売上・経費）で、重複しない", () => {
    const orders = INDIVIDUAL_ACCOUNTS.map((a) => a.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
    const sections = [...INDIVIDUAL_ACCOUNTS]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((a) => a.reportSection);
    const rank = ["BS_ASSET", "BS_LIABILITY", "BS_EQUITY", "PL_SALES", "PL_EXPENSE"];
    const ranks = sections.map((s) => rank.indexOf(s));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks).not.toContain(-1);
  });

  it("経費は欄番号の順に並ぶ", () => {
    const lines = INDIVIDUAL_ACCOUNTS.filter((a) => a.category === "expense")
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((a) => a.reportLine ?? 0);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});
