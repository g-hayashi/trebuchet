import { describe, expect, it } from "vitest";
import { formatInvoiceNo } from "../../src/invoicing/number.ts";

describe("formatInvoiceNo（R6）", () => {
  it("YYYYMMDD-NNN（3 桁に 0 埋め）", () => {
    expect(formatInvoiceNo("2026-11-01", 43)).toBe("20261101-043");
    expect(formatInvoiceNo("2026-11-01", 1)).toBe("20261101-001");
    expect(formatInvoiceNo("2026-11-01", 999)).toBe("20261101-999");
  });

  it("1000 以上は桁が増える", () => {
    expect(formatInvoiceNo("2026-11-01", 1000)).toBe("20261101-1000");
    expect(formatInvoiceNo("2026-11-01", 12345)).toBe("20261101-12345");
  });
});
