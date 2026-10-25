import { describe, expect, it } from "vitest";
import { formatSignedYen, formatYen, parseHalfStep, parseWholeYen, parseYenInput } from "./format";

describe("parseWholeYen", () => {
  it("min 以上の整数だけを返し、それ以外は null", () => {
    expect(parseWholeYen("1,000", { min: 0 })).toBe(1000);
    expect(parseWholeYen("１２３", { min: 1 })).toBe(123);
    expect(parseWholeYen("0", { min: 0 })).toBe(0);
    expect(parseWholeYen("0", { min: 1 })).toBeNull();
    expect(parseWholeYen("-5", { min: 0 })).toBeNull();
    expect(parseWholeYen("1.5", { min: 0 })).toBeNull();
    expect(parseWholeYen("", { min: 0 })).toBeNull();
    expect(parseWholeYen("abc", { min: 0 })).toBeNull();
    expect(parseWholeYen("1e20", { min: 0 })).toBeNull();
  });
});

describe("parseHalfStep", () => {
  it("0.5 の倍数だけを返し、それ以外は null", () => {
    expect(parseHalfStep("1.5")).toBe(1.5);
    expect(parseHalfStep(" 8 ")).toBe(8);
    expect(parseHalfStep("0")).toBe(0);
    expect(parseHalfStep("0.3")).toBeNull();
    expect(parseHalfStep("-0.5")).toBeNull();
    expect(parseHalfStep("")).toBeNull();
    expect(parseHalfStep("abc")).toBeNull();
  });

  it("min 未満は null", () => {
    expect(parseHalfStep("0", { min: 0.5 })).toBeNull();
    expect(parseHalfStep("0.5", { min: 0.5 })).toBe(0.5);
  });
});

describe("formatYen", () => {
  it("3桁区切りで表示する", () => {
    expect(formatYen(1234567)).toBe("1,234,567");
    expect(formatYen(0)).toBe("0");
    expect(formatYen(-5000)).toBe("-5,000");
  });
});

describe("formatSignedYen", () => {
  it("帳票の金額: 3桁区切りで、マイナスは ▲ を付ける", () => {
    expect(formatSignedYen(1234567)).toBe("1,234,567");
    expect(formatSignedYen(0)).toBe("0");
    expect(formatSignedYen(-15000)).toBe("▲15,000");
  });
});

describe("parseYenInput", () => {
  it("空欄や数値でない入力は undefined", () => {
    expect(parseYenInput("")).toBeUndefined();
    expect(parseYenInput("  ")).toBeUndefined();
    expect(parseYenInput("abc")).toBeUndefined();
  });

  it("カンマや全角数字を許す", () => {
    expect(parseYenInput("1,000")).toBe(1000);
    expect(parseYenInput("１２３")).toBe(123);
  });

  it("小数はそのまま返し、検証に任せる", () => {
    expect(parseYenInput("1.5")).toBe(1.5);
  });
});
