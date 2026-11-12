import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeContent } from "../../src/statements/normalize.ts";
import type { InferenceRule } from "../../src/types.ts";
import { createJournal } from "../../src/usecases/create-journal.ts";
import { seedRulesFromJournals } from "../../src/usecases/inference-rules.ts";
import { approveCandidate } from "../../src/usecases/statement-approval.ts";
import { unwrap } from "../result.ts";
import { setupStatements } from "../statements-setup.ts";

// 011 T018・INV-71（R9、data-model §1.2）。managed_by = 'user' のルールは、任意のルールの集合と
// 承認・`seedRulesFromJournals` の列の後も、科目・税区分・状態（と内容・hits・overrides）が変わらず、履歴も増えない

const CONTENTS = ["ショップ001", "サンプル商店", "テスト通信 料金"] as const;

type Slot = { kind: "none" | "auto" | "user"; counter: "rent" | "supplies"; paused: boolean };
const slotArb: fc.Arbitrary<Slot> = fc.record({
  kind: fc.constantFrom("none" as const, "auto" as const, "user" as const),
  counter: fc.constantFrom("rent" as const, "supplies" as const),
  paused: fc.boolean(),
});

type Op = { counter: "rent" | "supplies"; seedBefore: boolean };
const opArb: fc.Arbitrary<Op> = fc.record({
  counter: fc.constantFrom("rent" as const, "supplies" as const),
  seedBefore: fc.boolean(),
});

describe("INV-71: managedBy が user のルールは承認・seed で変わらない（性質）", () => {
  it("任意のルールの集合と承認・seed の列の後も、user のルールは同じ。履歴も増えない", () => {
    fc.assert(
      fc.property(
        // 内容 3 つ × 口座（取込元・すべて）の 6 つの枠
        fc.array(slotArb, { minLength: 6, maxLength: 6 }),
        fc.array(fc.constantFrom(...CONTENTS), { minLength: 1, maxLength: 6 }),
        fc.array(opArb, { minLength: 6, maxLength: 6 }),
        (slots, contents, ops) => {
          const ctx = setupStatements();
          ctx.mapAll();
          const bankAccountId =
            ctx.uow.statements.state.accounts.find((a) => a.name === "サンプル銀行")?.id ?? "";
          // seed の対象になる手入力の仕訳（サンプル商店 × 2、相手は地代家賃）
          for (const date of ["2026-03-01", "2026-03-02"]) {
            unwrap(
              createJournal(ctx.ledgerDeps, {
                date,
                memo: "手入力",
                lines: [
                  {
                    side: "debit",
                    accountId: ctx.a.rent,
                    amount: 1000,
                    description: "サンプル商店",
                  },
                  { side: "credit", accountId: ctx.a.bank, amount: 1000 },
                ],
              }),
            );
          }

          const preset: InferenceRule[] = [];
          for (const [i, slot] of slots.entries()) {
            if (slot.kind === "none") continue;
            const content = CONTENTS[Math.floor(i / 2)] ?? "";
            const rule: InferenceRule = {
              id: `preset-${i}`,
              normalizedContent: normalizeContent(content),
              statementAccountId: i % 2 === 0 ? bankAccountId : null,
              counterAccountId: ctx.a[slot.counter],
              counterSubAccountId: null,
              partnerId: null,
              taxCategory: slot.counter === "rent" ? "PURCHASE_10" : "OUT_OF_SCOPE",
              purpose: "business",
              descriptionTemplate: null,
              hits: i + 1,
              overrides: i % 3,
              status: slot.paused ? "paused" : "active",
              origin: "approval",
              managedBy: slot.kind,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            };
            ctx.uow.statements.insertInferenceRule(rule);
            preset.push(rule);
          }
          const userRules = preset.filter((r) => r.managedBy === "user");
          const historyOfUser = () =>
            ctx.uow.statements.state.ruleHistory.filter((h) =>
              userRules.some((r) => r.id === h.ruleId),
            ).length;

          ctx.importRows(
            contents.map((content, i) =>
              ctx.row({ content, date: `2026-05-${String(10 + i).padStart(2, "0")}` }),
            ),
          );
          for (const [i] of contents.entries()) {
            const op = ops[i];
            if (op?.seedBefore === true) unwrap(seedRulesFromJournals(ctx.deps));
            const target =
              ctx.statements().find((s) => s.date === `2026-05-${String(10 + i).padStart(2, "0")}`)
                ?.id ?? "";
            unwrap(
              approveCandidate(ctx.deps, target, {
                draft: ctx.shapeDraft(target, "business", ctx.a[op?.counter ?? "rent"]),
              }),
            );
          }
          unwrap(seedRulesFromJournals(ctx.deps));

          for (const before of userRules) {
            const after = ctx.uow.statements.state.rules.find((r) => r.id === before.id);
            expect(after).toEqual(before);
          }
          expect(historyOfUser()).toBe(0);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("auto のルールは承認で今までどおり学ぶ（hits か overrides が増える）", () => {
    fc.assert(
      fc.property(fc.constantFrom("rent" as const, "supplies" as const), (counter) => {
        const ctx = setupStatements();
        ctx.mapAll();
        ctx.importRows([ctx.row({ content: "ショップ001" }), ctx.row({ content: "ショップ002" })]);
        const first = ctx.idOf("ショップ001");
        unwrap(approveCandidate(ctx.deps, first, { draft: ctx.shapeDraft(first, "business") }));
        const second = ctx.idOf("ショップ002");
        unwrap(
          approveCandidate(ctx.deps, second, {
            draft: ctx.shapeDraft(second, "business", ctx.a[counter]),
          }),
        );
        const [rule] = ctx.uow.statements.state.rules;
        expect(rule?.managedBy).toBe("auto");
        expect((rule?.hits ?? 0) + (rule?.overrides ?? 0)).toBe(2);
      }),
      { numRuns: 10 },
    );
  });
});
