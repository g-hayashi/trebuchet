import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type PlanImportInput, planImport } from "../../src/import/freee/plan.ts";
import { groupFreeeJournals, readFreeeFile } from "../../src/import/freee/read.ts";
import { validateJournal } from "../../src/journal.ts";
import { type FreeeModel, freeeModelArb, toFreeeJournalCsv } from "../freee-arbitraries.ts";
import { planInput, ref } from "./import-setup.ts";

const runs = { numRuns: 40 };

function grouped(model: FreeeModel) {
  const file = readFreeeFile(toFreeeJournalCsv(model));
  if (!file.ok) throw new Error(JSON.stringify(file.error));
  return groupFreeeJournals(file.value);
}

type Scenario = {
  model: FreeeModel;
  imported: string[];
  revoked: string[];
  fiscalYears: number[] | undefined;
  include: string[];
};

/** モデルと、取込済みにする仕訳（取り消し済みの参照を含む）と年度の選択 */
const scenarioArb: fc.Arbitrary<Scenario> = freeeModelArb({ maxJournals: 8 }).chain((model) => {
  const ids = [model.closing.id, ...model.journals.map((j) => j.id)];
  return fc.record({
    model: fc.constant(model),
    imported: fc.subarray(ids),
    revoked: fc.subarray(ids),
    fiscalYears: fc.constantFrom<number[] | undefined>(undefined, [2025], [2026], [], [2024, 2025]),
    include: fc.subarray([model.closing.id]),
  });
});

function inputOf(s: Scenario): PlanImportInput {
  const g = grouped(s.model);
  return planInput(g, {
    activeRefs: s.imported.map((id) => ref(id)),
    options: {
      ...(s.fiscalYears === undefined ? {} : { fiscalYears: s.fiscalYears }),
      include: s.include,
    },
  });
}

function contextWithCreations(input: PlanImportInput, plan: ReturnType<typeof planImport>) {
  return {
    accounts: input.accounts,
    subAccounts: [
      ...input.subAccounts,
      ...plan.creations.subAccounts.map((s) => ({ ...s, isActive: true })),
    ],
    partners: [...input.partners, ...plan.creations.partners],
    tags: [...input.tags, ...plan.creations.tags],
    periods: input.periods,
    taxSettings: input.taxSettings,
    taxRates: input.taxRates,
  };
}

describe("planImport のプロパティ（T021）", () => {
  it("(1) INV-13 new の下書きはすべて validateJournal を通り、税額は検証の値と同じ", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const input = inputOf(s);
        const plan = planImport(input);
        const ctx = contextWithCreations(input, plan);
        for (const item of plan.preview.items.filter((i) => i.decision === "new")) {
          if (item.draft === undefined) throw new Error("new なのに下書きがない");
          const valid = validateJournal(item.draft, ctx);
          expect(valid.ok, JSON.stringify(valid)).toBe(true);
          if (valid.ok) {
            expect(item.draft.lines.map((l) => l.taxAmount ?? 0)).toEqual(
              valid.value.lines.map((l) => l.taxAmount),
            );
          }
        }
      }),
      runs,
    );
  });

  it("(2) new + already + excluded + rejected = ファイルの仕訳の数", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const input = inputOf(s);
        const { preview } = planImport(input);
        const { counts } = preview;
        const total = input.journals.length + input.rejected.length;
        expect(counts.new + counts.already + counts.excluded + counts.rejected).toBe(total);
        expect(preview.items).toHaveLength(total);
        const yearTotal = preview.years.reduce(
          (n, y) => n + y.counts.new + y.counts.already + y.counts.excluded + y.counts.rejected,
          0,
        );
        expect(yearTotal).toBe(total);
      }),
      runs,
    );
  });

  it("(3) totals.debit = totals.credit = new の仕訳の借方の合計", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { preview } = planImport(inputOf(s));
        expect(preview.totals.debit).toBe(preview.totals.credit);
        const debit = preview.items
          .flatMap((i) => (i.decision === "new" ? (i.draft?.lines ?? []) : []))
          .filter((l) => l.side === "debit")
          .reduce((n, l) => n + l.amount, 0);
        expect(preview.totals.debit).toBe(debit);
      }),
      runs,
    );
  });

  it("(4) 取り消されていない参照がある仕訳はすべて already、取り消し済みの参照は数えない", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const input = inputOf(s);
        const revokedOnly = s.revoked.filter((id) => !s.imported.includes(id));
        const { preview } = planImport({
          ...input,
          activeRefs: [
            ...input.activeRefs,
            ...revokedOnly.map((id) => ref(id, { revokedAt: "2025-06-01T00:00:00.000Z" })),
          ],
        });
        for (const item of preview.items) {
          const isImported = s.imported.includes(item.freeeJournalId);
          expect(item.decision === "already", item.freeeJournalId).toBe(isImported);
          if (isImported) expect(item.reason).toBe("ALREADY_IMPORTED");
        }
      }),
      runs,
    );
  });

  it("(5) fiscalYears で選ばなかった年度の仕訳（取込済みでないもの）はすべて YEAR_NOT_SELECTED", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { preview } = planImport(inputOf(s));
        const selected = s.fiscalYears === undefined || s.fiscalYears.includes(2025);
        for (const item of preview.items) {
          if (s.imported.includes(item.freeeJournalId)) continue;
          if (selected) expect(item.reason).not.toBe("YEAR_NOT_SELECTED");
          else expect(item).toMatchObject({ decision: "excluded", reason: "YEAR_NOT_SELECTED" });
        }
      }),
      runs,
    );
  });

  it("(6) planImport は入力を変えず、同じ入力から同じ結果を返す（純関数）", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const input = inputOf(s);
        const before = structuredClone(input);
        const first = planImport(input);
        expect(input).toEqual(before);
        expect(planImport(input)).toEqual(first);
      }),
      runs,
    );
  });
});
