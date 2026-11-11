import { describe, expect, it } from "vitest";
import {
  PRIOR_ERROR,
  PRIOR_YEAR_ERROR,
  parsePriorAccumulated,
  priorFieldsOf,
} from "./prior-accumulated";

describe("parsePriorAccumulated", () => {
  it("空欄は累計 0・年なしで通る", () => {
    const r = parsePriorAccumulated({ priorAccumulated: "", priorThroughYear: "" });
    expect(r).toEqual({
      value: { prior: 0, year: null },
      priorError: undefined,
      priorYearError: undefined,
    });
  });

  it("累計が正なら年が要る", () => {
    const r = parsePriorAccumulated({ priorAccumulated: "1000", priorThroughYear: "" });
    expect(r.value).toBeUndefined();
    expect(r.priorYearError).toBe(PRIOR_YEAR_ERROR);
  });

  it("累計と 4 桁の年を整数と年にする", () => {
    const r = parsePriorAccumulated({ priorAccumulated: "1,000", priorThroughYear: " 2024 " });
    expect(r.value).toEqual({ prior: 1000, year: 2024 });
  });

  it("累計が整数でない、年が 4 桁でないときはそれぞれの誤りを返す", () => {
    const r = parsePriorAccumulated({ priorAccumulated: "abc", priorThroughYear: "24" });
    expect(r.value).toBeUndefined();
    expect(r.priorError).toBe(PRIOR_ERROR);
    expect(r.priorYearError).toBe(PRIOR_YEAR_ERROR);
  });
});

describe("priorFieldsOf", () => {
  it("0 の累計と年なしは空欄にする", () => {
    expect(priorFieldsOf({ priorAccumulated: 0, priorThroughYear: null })).toEqual({
      priorAccumulated: "",
      priorThroughYear: "",
    });
    expect(priorFieldsOf({ priorAccumulated: 500, priorThroughYear: 2024 })).toEqual({
      priorAccumulated: "500",
      priorThroughYear: "2024",
    });
  });
});
