import { describe, expect, it } from "vitest";
import { ACCOUNT_READINGS } from "../src/index.ts";

describe("ACCOUNT_READINGS（R5、D3）", () => {
  it("鍵は 4 桁の科目コード、値は空でないひらがな（長音を含む）", () => {
    const entries = Object.entries(ACCOUNT_READINGS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [code, reading] of entries) {
      expect(code, code).toMatch(/^\d{4}$/);
      expect(reading, code).toMatch(/^[ぁ-ゖー]+$/);
    }
  });

  it("代表の科目の読み", () => {
    expect(ACCOUNT_READINGS["1010"]).toBe("げんきん");
    expect(ACCOUNT_READINGS["4010"]).toBe("うりあげだか");
    expect(ACCOUNT_READINGS["5120"]).toBe("つうしんひ");
  });
});
