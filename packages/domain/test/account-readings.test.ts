import { ACCOUNT_READINGS } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { INDIVIDUAL_ACCOUNTS } from "../src/seed/accounts.individual.ts";

describe("科目の読み（011 R5）と seed の対応", () => {
  it("seed の全コードに読みがあり、seed にないコードの読みはない", () => {
    const seedCodes = INDIVIDUAL_ACCOUNTS.map((a) => a.code).sort();
    expect(Object.keys(ACCOUNT_READINGS).sort()).toEqual(seedCodes);
  });
});
