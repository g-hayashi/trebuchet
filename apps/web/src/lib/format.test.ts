import { describe, expect, it } from "vitest";
import { formatSignedYen, formatYen, parseYenInput } from "./format";

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
