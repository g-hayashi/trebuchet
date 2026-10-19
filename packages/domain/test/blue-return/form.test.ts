import { describe, expect, it } from "vitest";
import { BLUE_RETURN_FORMS, formForYear } from "../../src/blue-return/form.ts";
import { INDIVIDUAL_ACCOUNTS } from "../../src/seed/accounts.individual.ts";

const form = formForYear(2025);

describe("青色申告決算書（一般用）の様式", () => {
  it("欄番号は 1〜45 で重複しない", () => {
    const nos = form.pl.map((l) => l.no);
    expect(new Set(nos).size).toBe(nos.length);
    expect(nos).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
  });

  it("任意欄は 25〜30 の 6 欄で、kind が optional の欄と一致する", () => {
    expect(form.optionalLines).toEqual([25, 26, 27, 28, 29, 30]);
    const optional = form.pl.filter((l) => l.kind === "optional").map((l) => l.no);
    expect(optional).toEqual([25, 26, 27, 28, 29, 30]);
  });

  it("欄の kind の割り当て", () => {
    const kindOf = (no: number) => form.pl.find((l) => l.no === no)?.kind;
    expect(kindOf(1)).toBe("account");
    for (const no of [2, 3, 4, 5, 6, 7, 34, 35, 36, 37, 38, 39, 40, 41, 42]) {
      expect(kindOf(no), `欄${no}`).toBe("unused");
    }
    for (let no = 8; no <= 24; no++) expect(kindOf(no), `欄${no}`).toBe("account");
    expect(kindOf(31)).toBe("account");
    for (const no of [32, 33, 43, 44, 45]) expect(kindOf(no), `欄${no}`).toBe("computed");
  });

  it("主な欄の名前", () => {
    const labelOf = (no: number) => form.pl.find((l) => l.no === no)?.label;
    expect(labelOf(8)).toBe("租税公課");
    expect(labelOf(18)).toBe("減価償却費");
    expect(labelOf(24)).toBe("貸倒金");
    expect(labelOf(31)).toBe("雑費");
    expect(labelOf(43)).toBe("青色申告特別控除前の所得金額");
    expect(labelOf(44)).toBe("青色申告特別控除額");
    expect(labelOf(45)).toBe("所得金額");
  });

  it("初期セットの損益計算書の科目は、reportLine の欄が様式にある", () => {
    for (const a of INDIVIDUAL_ACCOUNTS) {
      if (a.reportLine === null) continue;
      const line = form.pl.find((l) => l.no === a.reportLine);
      expect(line, `${a.code} ${a.name}`).toBeDefined();
      expect(["account", "optional"], `${a.code} ${a.name}`).toContain(line?.kind);
    }
  });

  it("初期セットの資産・負債・純資産の全科目が貸借対照表のどこかに対応する", () => {
    const mapped = new Map<string, number>();
    const add = (code: string) => mapped.set(code, (mapped.get(code) ?? 0) + 1);
    for (const row of form.bsRows) for (const c of row.accountCodes) add(c);
    for (const side of ["asset", "liability_equity"] as const) {
      for (const c of form.blankRowAccountCodes[side]) add(c);
    }
    for (const a of INDIVIDUAL_ACCOUNTS) {
      if (!a.reportSection.startsWith("BS_")) continue;
      expect(mapped.get(a.code), `${a.code} ${a.name}`).toBe(1);
    }
  });

  it("様式に行のない科目は空欄の行に出す", () => {
    expect(form.blankRowAccountCodes.asset).toEqual(["1050", "1070", "1080"]);
    expect(form.blankRowAccountCodes.liability_equity).toEqual(["2030"]);
  });

  it("貸借対照表の行の対応（R2）", () => {
    const rowOf = (code: string) => form.bsRows.find((r) => r.accountCodes.includes(code));
    expect(rowOf("1010")?.label).toBe("現金");
    expect(rowOf("1020")?.label).toBe("その他の預金");
    expect(rowOf("1060")?.label).toBe("工具器具備品");
    expect(rowOf("3090")?.label).toBe("事業主貸");
    expect(rowOf("3090")?.side).toBe("asset");
    expect(rowOf("2010")?.label).toBe("借入金");
    expect(rowOf("3010")?.label).toBe("事業主借");
    expect(rowOf("3020")?.label).toBe("元入金");
    expect(rowOf("3020")?.side).toBe("liability_equity");
  });

  it("貸借対照表の最後の行は青色申告特別控除前の所得金額（計算）", () => {
    const last = form.bsRows[form.bsRows.length - 1];
    expect(last?.label).toBe("青色申告特別控除前の所得金額");
    expect(last?.kind).toBe("income");
    expect(last?.side).toBe("liability_equity");
  });

  it("売上先の明細の行数は正の整数", () => {
    expect(Number.isInteger(form.salesPartnerRows)).toBe(true);
    expect(form.salesPartnerRows).toBeGreaterThan(0);
  });

  it("formForYear は年度以前で最も新しい様式、なければ最も古い様式を返す", () => {
    expect(BLUE_RETURN_FORMS).toHaveLength(1);
    expect(formForYear(2024).year).toBe(2025);
    expect(formForYear(2025).year).toBe(2025);
    expect(formForYear(2030).year).toBe(2025);
  });
});
