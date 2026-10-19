import { describe, expect, it } from "vitest";
import {
  BalanceSheetQuery,
  GeneralLedgerQuery,
  JournalBookQuery,
  ProfitAndLossQuery,
  TrialBalanceQuery,
} from "../src/index.ts";

const ID = "0190f3a0-0000-7000-8000-000000000001";

describe("帳票のクエリ（US4）", () => {
  it("期間の帳票は from・to を受け付け、format の既定は json", () => {
    for (const Query of [JournalBookQuery, TrialBalanceQuery]) {
      expect(Query.parse({ from: "2026-01-01", to: "2026-12-31" })).toEqual({
        from: "2026-01-01",
        to: "2026-12-31",
        format: "json",
      });
    }
  });

  it("from と to が同じ日でもよい", () => {
    expect(TrialBalanceQuery.safeParse({ from: "2026-05-01", to: "2026-05-01" }).success).toBe(
      true,
    );
  });

  it.each([
    { from: "2026-12-31", to: "2026-01-01" },
    { from: "2026-02-30", to: "2026-12-31" },
    { from: "2026-01-01" },
    { from: "2026-01-01", to: "2026-12-31", format: "pdf" },
  ])("不正な期間・形式を拒否する %#", (input) => {
    expect(TrialBalanceQuery.safeParse(input).success).toBe(false);
  });

  it("from が to より後なら to の項目のエラーにする", () => {
    const r = JournalBookQuery.safeParse({ from: "2026-12-31", to: "2026-01-01" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["to"]);
  });

  it("総勘定元帳は accountId が必須で、subAccountId は任意", () => {
    expect(
      GeneralLedgerQuery.parse({
        from: "2026-01-01",
        to: "2026-12-31",
        accountId: ID,
        format: "csv",
      }),
    ).toEqual({ from: "2026-01-01", to: "2026-12-31", accountId: ID, format: "csv" });
    expect(GeneralLedgerQuery.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success).toBe(
      false,
    );
    expect(
      GeneralLedgerQuery.safeParse({
        from: "2026-01-01",
        to: "2026-12-31",
        accountId: ID,
        subAccountId: "x",
      }).success,
    ).toBe(false);
  });

  it("損益計算書・貸借対照表は compare=previous-year を受け付ける", () => {
    expect(
      ProfitAndLossQuery.parse({ from: "2026-01-01", to: "2026-12-31", compare: "previous-year" })
        .compare,
    ).toBe("previous-year");
    expect(BalanceSheetQuery.parse({ asOf: "2026-12-31" })).toEqual({
      asOf: "2026-12-31",
      format: "json",
    });
    expect(BalanceSheetQuery.safeParse({ asOf: "2026-12-31", compare: "budget" }).success).toBe(
      false,
    );
    expect(BalanceSheetQuery.safeParse({}).success).toBe(false);
  });
});
