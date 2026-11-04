import { describe, expect, it } from "vitest";
import { filterAccounts, matchesAccount } from "./account-search";

const accounts = [
  { code: "1010", name: "現金", isSystem: true },
  { code: "1020", name: "普通預金", isSystem: true },
  { code: "5120", name: "通信費", isSystem: true },
  { code: "5320", name: "つうしん強化費", isSystem: false },
  { code: "1090", name: "ＡＢＣ口座", isSystem: false },
];

const codes = (query: string) => filterAccounts(accounts, query).map((a) => a.code);

describe("account-search（R5、D3）", () => {
  it("空の検索はすべて返す（順序を変えない）", () => {
    expect(codes("")).toEqual(["1010", "1020", "5120", "5320", "1090"]);
    expect(codes("  ")).toEqual(["1010", "1020", "5120", "5320", "1090"]);
  });

  it("名前の部分一致", () => {
    expect(codes("預金")).toEqual(["1020"]);
  });

  it("コードの部分一致", () => {
    expect(codes("512")).toEqual(["5120"]);
    expect(codes("10")).toEqual(["1010", "1020", "1090"]);
  });

  it("NFKC: 全角の入力・大文字小文字を区別しない", () => {
    expect(codes("５１２")).toEqual(["5120"]);
    expect(codes("abc")).toEqual(["1090"]);
    expect(codes("ａｂｃ")).toEqual(["1090"]);
  });

  it("最初からある科目はひらがなの読みで探せる", () => {
    expect(codes("げんきん")).toEqual(["1010"]);
    expect(codes("つうしん")).toEqual(["5120", "5320"]);
  });

  it("利用者の科目は名前とコードだけ（読みの表は使わない）", () => {
    // 5320 は読みの表にないが、名前に「つうしん」を含むので名前で一致する
    expect(codes("つうしん")).toContain("5320");
    // 利用者の科目のコードが偶然 seed のコードと同じでも、読みでは一致しない
    expect(matchesAccount({ code: "1010", name: "別の科目", isSystem: false }, "げんきん")).toBe(
      false,
    );
    expect(matchesAccount({ code: "1010", name: "別の科目", isSystem: true }, "げんきん")).toBe(
      true,
    );
  });

  it("一致しなければ空", () => {
    expect(codes("存在しない")).toEqual([]);
  });
});
