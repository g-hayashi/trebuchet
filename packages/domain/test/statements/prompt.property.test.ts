import { AiSuggestion, TaxCategoryCode } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AiPayload } from "../../src/statements/mask.ts";
import {
  buildPrompt,
  counterAccounts,
  isCounterAccount,
  parseSuggestion,
} from "../../src/statements/prompt.ts";
import type { Account } from "../../src/types.ts";

// 006 T023（R10、INV-46）。AI の出力は AiSuggestion で検証し、相手になりうる有効な科目と既知の税区分だけを通す

const TAX_CATEGORIES = TaxCategoryCode.options;

const acct = (code: string, over: Partial<Account> = {}): Account => ({
  id: `id-${code}`,
  code,
  name: `科目${code}`,
  category: "expense",
  normalSide: "debit",
  reportSection: "PL_EXPENSE",
  reportLine: null,
  sortOrder: 1,
  isSystem: false,
  isActive: true,
  ...over,
});
const ACCOUNTS: Account[] = [
  acct("5110"),
  acct("5120"),
  acct("5130", { isActive: false }),
  acct("3010", { category: "equity" }), // 事業主借
  acct("3090", { category: "equity" }), // 事業主貸
];

const valid = {
  accountCode: "5110",
  taxCategory: "PURCHASE_10",
  purpose: "business",
  confidence: 80,
  reason: "過去の同じ店の明細",
};

describe("counterAccounts", () => {
  it("使用停止と事業主貸・事業主借を除く", () => {
    expect(counterAccounts(ACCOUNTS).map((a) => a.code)).toEqual(["5110", "5120"]);
    expect(isCounterAccount(acct("3010"))).toBe(false);
    expect(isCounterAccount(acct("5130", { isActive: false }))).toBe(false);
  });
});

describe("parseSuggestion", () => {
  it("正しい出力から科目の ID つきで返す。JSON の文字列・コードフェンスつきも読む", () => {
    const r = parseSuggestion(valid, ACCOUNTS);
    expect(r).toEqual({ ok: true, value: { ...valid, accountId: "id-5110" } });
    expect(parseSuggestion(JSON.stringify(valid), ACCOUNTS).ok).toBe(true);
    expect(parseSuggestion(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, ACCOUNTS).ok).toBe(true);
  });

  it.each([
    ["一覧にない科目", { ...valid, accountCode: "9999" }],
    ["使用停止の科目", { ...valid, accountCode: "5130" }],
    ["事業主借", { ...valid, accountCode: "3010" }],
    ["未知の税区分", { ...valid, taxCategory: "PURCHASE_5" }],
    ["確信度が範囲外", { ...valid, confidence: 101 }],
    ["確信度が小数", { ...valid, confidence: 80.5 }],
    ["判定が違う", { ...valid, purpose: "other" }],
    ["理由が長すぎる", { ...valid, reason: "あ".repeat(201) }],
    ["項目の欠け", { accountCode: "5110" }],
    ["JSON でない文字列", "これは JSON ではありません"],
    ["null", null],
    ["配列", [valid]],
  ])("捨てる: %s", (_label, raw) => {
    expect(parseSuggestion(raw, ACCOUNTS).ok).toBe(false);
  });

  it("性質: 任意の JSON で、通ったものは AiSuggestion の形で、有効な科目・既知の税区分だけ", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const r = parseSuggestion(raw, ACCOUNTS);
        if (!r.ok) return;
        expect(AiSuggestion.safeParse(raw).success).toBe(true);
        const account = ACCOUNTS.find((a) => a.id === r.value.accountId);
        expect(account?.code).toBe(r.value.accountCode);
        expect(account !== undefined && isCounterAccount(account)).toBe(true);
        expect(TAX_CATEGORIES).toContain(r.value.taxCategory);
      }),
    );
  });

  it("性質: 科目・税区分・判定・確信度を組み合わせても、通るのは有効なものだけ", () => {
    const codeArb = fc.constantFrom("5110", "5120", "5130", "3010", "3090", "9999", "");
    const taxArb = fc.oneof(fc.constantFrom(...TAX_CATEGORIES), fc.string({ maxLength: 8 }));
    const purposeArb = fc.constantFrom("business", "private", "x");
    const confArb = fc.oneof(fc.integer({ min: -5, max: 105 }), fc.double({ noNaN: true }));
    fc.assert(
      fc.property(codeArb, taxArb, purposeArb, confArb, (accountCode, taxCategory, purpose, c) => {
        const raw = { accountCode, taxCategory, purpose, confidence: c, reason: "x" };
        const r = parseSuggestion(raw, ACCOUNTS);
        const expected =
          (accountCode === "5110" || accountCode === "5120") &&
          (TAX_CATEGORIES as readonly string[]).includes(taxCategory) &&
          (purpose === "business" || purpose === "private") &&
          Number.isInteger(c) &&
          c >= 0 &&
          c <= 100;
        expect(r.ok).toBe(expected);
      }),
    );
  });
});

describe("buildPrompt", () => {
  const payload: AiPayload = {
    date: "2026-05-10",
    amount: 1200,
    direction: "out",
    content: "ショップ",
    categoryMajor: "食費",
    categoryMinor: null,
    accountKind: "card",
    accountUsage: "mixed",
  };

  it("system に科目のコードと名前・税区分・出力の形、user に明細の内容を入れる", () => {
    const eligible = counterAccounts(ACCOUNTS);
    const prompt = buildPrompt(payload, eligible, TAX_CATEGORIES);
    for (const a of eligible) {
      expect(prompt.system).toContain(a.code);
      expect(prompt.system).toContain(a.name);
    }
    for (const t of TAX_CATEGORIES) expect(prompt.system).toContain(t);
    expect(prompt.system).toContain("accountCode");
    expect(prompt.user).toContain("ショップ");
    expect(prompt.user).toContain("2026-05-10");
    expect(prompt.system).not.toContain("5130");
    expect(prompt.system).not.toContain("3010");
  });

  it("性質: user には payload の項目だけが出る（JSON として読み戻すと payload と一致）", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.integer({ min: 1, max: 999_999 }), (c, n) => {
        const p: AiPayload = { ...payload, content: c, amount: n };
        const prompt = buildPrompt(p, counterAccounts(ACCOUNTS), TAX_CATEGORIES);
        expect(JSON.parse(prompt.user)).toEqual(p);
      }),
    );
  });
});
