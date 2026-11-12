import { describe, expect, it } from "vitest";
import { accountByCode } from "../src/accounts.ts";
import { INDIVIDUAL_ACCOUNT_LIST } from "./blue-return-arbitraries.ts";

describe("accountByCode（コードで科目を引く。ACCOUNT_NOT_FOUND の文言はここに 1 つ）", () => {
  it("あれば ok で科目を返す", () => {
    const r = accountByCode(INDIVIDUAL_ACCOUNT_LIST, "5180");
    expect(r.ok && r.value.code).toBe("5180");
  });

  it("なければ ACCOUNT_NOT_FOUND（details.code）と 1 つの文言", () => {
    const r = accountByCode(INDIVIDUAL_ACCOUNT_LIST, "9999");
    expect(!r.ok && r.error).toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
      message: "勘定科目（コード 9999）が見つかりません",
      details: { code: "9999" },
    });
  });
});
