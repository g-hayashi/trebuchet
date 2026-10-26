import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { learnRule, type RuleBody, ruleConfidence, ruleFor } from "../../src/statements/rules.ts";
import type { InferenceRule } from "../../src/types.ts";
import { purposeArb } from "../statements-arbitraries.ts";

// 006 T018。確信度は 0〜95 の整数、学習の後のルールは承認の内容と一致する（R9）

const bodyArb: fc.Arbitrary<RuleBody> = fc.record({
  counterAccountId: fc.constantFrom("a1", "a2", "a3"),
  counterSubAccountId: fc.constantFrom(null, "s1"),
  partnerId: fc.constantFrom(null, "p1", "p2"),
  taxCategory: fc.constantFrom(
    "PURCHASE_10" as const,
    "PURCHASE_8R" as const,
    "OUT_OF_SCOPE" as const,
  ),
  purpose: purposeArb,
  descriptionTemplate: fc.constantFrom(null, "消耗品"),
});

const countArb = fc.nat({ max: 1000 });

const ruleArb: fc.Arbitrary<InferenceRule> = fc
  .tuple(bodyArb, countArb, countArb, fc.constantFrom("active" as const, "paused" as const))
  .map(([body, hits, overrides, status]) => ({
    id: "r",
    normalizedContent: "店#",
    statementAccountId: "s1",
    ...body,
    hits,
    overrides,
    status,
    origin: "approval" as const,
    createdAt: "",
    updatedAt: "",
  }));

describe("ruleConfidence（性質）", () => {
  it("どんな hits・overrides でも 0〜95 の整数。hits が増えれば下がらず、overrides が増えれば上がらない", () => {
    fc.assert(
      fc.property(countArb, countArb, (hits, overrides) => {
        const c = ruleConfidence({ hits, overrides });
        expect(Number.isInteger(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(95);
        expect(ruleConfidence({ hits: hits + 1, overrides })).toBeGreaterThanOrEqual(c);
        expect(ruleConfidence({ hits, overrides: overrides + 1 })).toBeLessThanOrEqual(c);
      }),
    );
  });
});

describe("learnRule（性質）", () => {
  it("学習の後のルールは承認の内容と一致する。hits・overrides は減らない", () => {
    fc.assert(
      fc.property(fc.option(ruleArb, { nil: null }), bodyArb, (rule, body) => {
        const approval = { normalizedContent: "店#", statementAccountId: "s1", body };
        const learned = learnRule(rule, approval);
        const { hits, overrides, normalizedContent, statementAccountId, ...content } = learned.rule;
        expect(content).toEqual(body);
        expect(normalizedContent).toBe("店#");
        expect(statementAccountId).toBe("s1");
        expect(hits).toBeGreaterThanOrEqual(rule?.hits ?? 0);
        expect(overrides).toBeGreaterThanOrEqual(rule?.overrides ?? 0);
        // 1 回の承認で増えるのは hits か overrides のどちらか 1 だけ
        expect(hits + overrides - ((rule?.hits ?? 0) + (rule?.overrides ?? 0))).toBe(1);
        expect(learned.action).toBe(rule === null ? "create" : "update");
      }),
    );
  });

  it("同じ承認を重ねると、確信度は下がらない（同じ内容なら hits だけが増える）", () => {
    fc.assert(
      fc.property(bodyArb, fc.integer({ min: 1, max: 8 }), (body, times) => {
        const approval = { normalizedContent: "店#", statementAccountId: "s1", body };
        let current: InferenceRule | null = null;
        let last = -1;
        for (let i = 0; i < times; i++) {
          const learned = learnRule(current, approval);
          current = {
            id: "r",
            status: "active",
            origin: "approval",
            createdAt: "",
            updatedAt: "",
            ...learned.rule,
          };
          const c = ruleConfidence(current);
          expect(c).toBeGreaterThanOrEqual(last);
          last = c;
        }
        expect(current?.overrides).toBe(0);
        expect(current?.hits).toBe(times);
      }),
    );
  });
});

describe("ruleFor（性質）", () => {
  it("返すのは停止していない・内容が一致・口座が同じかすべての口座のルールだけ。同じ口座があれば必ずそれ", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            content: fc.constantFrom("店#", "別#"),
            account: fc.constantFrom(null, "s1", "s2"),
            status: fc.constantFrom("active" as const, "paused" as const),
          }),
          { maxLength: 8 },
        ),
        (specs) => {
          const rules: InferenceRule[] = specs.map((s, i) => ({
            id: `r${i}`,
            normalizedContent: s.content,
            statementAccountId: s.account,
            counterAccountId: "a1",
            counterSubAccountId: null,
            partnerId: null,
            taxCategory: "PURCHASE_10",
            purpose: "business",
            descriptionTemplate: null,
            hits: 1,
            overrides: 0,
            status: s.status,
            origin: "approval",
            createdAt: "",
            updatedAt: "",
          }));
          const found = ruleFor({ normalizedContent: "店#", statementAccountId: "s1" }, rules);
          const usable = rules.filter(
            (r) =>
              r.status === "active" &&
              r.normalizedContent === "店#" &&
              (r.statementAccountId === "s1" || r.statementAccountId === null),
          );
          if (usable.length === 0) {
            expect(found).toBeUndefined();
            return;
          }
          expect(found).toBeDefined();
          if (usable.some((r) => r.statementAccountId === "s1")) {
            expect(found?.statementAccountId).toBe("s1");
          } else {
            expect(found?.statementAccountId).toBeNull();
          }
        },
      ),
    );
  });
});
