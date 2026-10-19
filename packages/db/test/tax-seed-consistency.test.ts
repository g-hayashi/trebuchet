import { randomUUIDv7 } from "node:crypto";
import { TAX_CATEGORIES, TAX_RATES } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTenant } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("tax-seed");
});
afterEach(() => tmp.cleanup());

const byKey =
  <T>(key: (row: T) => string) =>
  (a: T, b: T) =>
    key(a).localeCompare(key(b));

describe("税区分・税率の投入（T025）とドメインの正本（T044）の一致", () => {
  it("tax_categories がドメインの TAX_CATEGORIES と同じ", () => {
    const rows = openTenant(randomUUIDv7())
      .$client.prepare("SELECT code, name, kind FROM tax_categories")
      .all() as { code: string; name: string; kind: string | null }[];
    const expected = TAX_CATEGORIES.map((c) => ({ code: c.code, name: c.name, kind: c.kind }));
    const key = (r: { code: string }) => r.code;
    expect(rows.sort(byKey(key))).toEqual(expected.sort(byKey(key)));
  });

  it("tax_rates がドメインの TAX_RATES と同じで、source_url が空でない", () => {
    const rows = openTenant(randomUUIDv7())
      .$client.prepare(
        "SELECT category_code AS categoryCode, rate, effective_from AS effectiveFrom, source_url AS sourceUrl FROM tax_rates",
      )
      .all() as { categoryCode: string; rate: number; effectiveFrom: string; sourceUrl: string }[];
    const key = (r: { categoryCode: string; effectiveFrom: string }) =>
      `${r.categoryCode}@${r.effectiveFrom}`;
    expect(rows.sort(byKey(key))).toEqual([...TAX_RATES].sort(byKey(key)));
    for (const r of rows) expect(r.sourceUrl).not.toBe("");
  });
});
