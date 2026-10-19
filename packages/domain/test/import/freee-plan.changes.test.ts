import { describe, expect, it } from "vitest";
import { canonicalSnapshot, planImport } from "../../src/import/freee/plan.ts";
import type { ImportRef } from "../../src/import/types.ts";
import { makeFiscalPeriod } from "../arbitraries.ts";
import { EXPECTED_JOURNAL_V2, FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { fixtureJournals, planInput, ref } from "./import-setup.ts";

const CHANGED_ID = EXPECTED_JOURNAL_V2.changedIds[0];
const DELETED_ID = EXPECTED_JOURNAL_V2.deletedIds[0];

/** v1 を取り込んだ状態の参照（帳簿の仕訳番号は取込の順に 1 から） */
function importedV1() {
  const plan = planImport(planInput(fixtureJournals()));
  const refs: ImportRef[] = plan.planned.map((p) =>
    ref(p.freee.freeeJournalId, {
      freeeJournalNo: p.freee.freeeJournalNo,
      freeeDate: p.freee.date,
      snapshotJson: p.snapshot,
    }),
  );
  const journalNos = new Map(refs.map((r, i) => [r.journalId, i + 1]));
  return { refs, journalNos };
}

/** ファイルの仕訳に当たる参照（usecase の activeRefsByFreeeIds と同じ） */
function activeFor(name: string, refs: readonly ImportRef[]) {
  const grouped = fixtureJournals(name);
  const ids = new Set(
    [...grouped.journals, ...grouped.rejected].map((j) => j.freeeJournalId as string),
  );
  return { grouped, activeRefs: refs.filter((r) => ids.has(r.freeeJournalId)) };
}

function planV2(overrides: Parameters<typeof planInput>[1] = {}) {
  const { refs, journalNos } = importedV1();
  const { grouped, activeRefs } = activeFor(FIXTURE_FILES.journalV2, refs);
  return {
    refs,
    journalNos,
    plan: planImport(planInput(grouped, { activeRefs, rangeRefs: refs, journalNos, ...overrides })),
  };
}

describe("planImport の変更・削除の検出（T062, FR-028〜030, research R9）", () => {
  it("v1 を取り込んだ後の v2: 追加は new、内容が変わった仕訳は FREEE_CHANGED、消えた仕訳は FREEE_DELETED", () => {
    const { plan, refs, journalNos } = planV2();
    const p = plan.preview;
    expect(p.items.filter((i) => i.decision === "new").map((i) => i.freeeJournalId)).toEqual([
      ...EXPECTED_JOURNAL_V2.addedIds,
    ]);
    expect(p.counts).toMatchObject({ new: 2, already: 13, excluded: 1, rejected: 0 });

    const changedRef = refs.find((r) => r.freeeJournalId === CHANGED_ID);
    const changedItem = p.items.find((i) => i.freeeJournalId === CHANGED_ID);
    expect(changedItem).toMatchObject({ decision: "already", warnings: ["FREEE_CHANGED"] });
    const after = fixtureJournals(FIXTURE_FILES.journalV2).journals.find(
      (j) => j.freeeJournalId === CHANGED_ID,
    );
    if (changedRef === undefined || after === undefined) throw new Error("fixture");
    const changed = p.warnings.filter((w) => w.code === "FREEE_CHANGED");
    expect(changed).toEqual([
      {
        code: "FREEE_CHANGED",
        message: expect.any(String),
        freeeJournalId: CHANGED_ID,
        details: {
          journalId: changedRef.journalId,
          journalNo: journalNos.get(changedRef.journalId),
          before: changedRef.snapshotJson,
          after: canonicalSnapshot(after),
        },
      },
    ]);
    expect(JSON.parse(changedRef.snapshotJson).lines[0].amount).toBe(4_400);
    expect(JSON.parse(canonicalSnapshot(after)).lines[0].amount).toBe(5_500);

    const deletedRef = refs.find((r) => r.freeeJournalId === DELETED_ID);
    if (deletedRef === undefined) throw new Error("fixture");
    expect(p.warnings.filter((w) => w.code === "FREEE_DELETED")).toEqual([
      {
        code: "FREEE_DELETED",
        message: expect.any(String),
        freeeJournalId: DELETED_ID,
        details: {
          journalId: deletedRef.journalId,
          journalNo: journalNos.get(deletedRef.journalId),
          freeeJournalNo: "5090101",
          before: deletedRef.snapshotJson,
        },
      },
    ]);
    // 変更・削除の警告も件数に含める。帳簿の仕訳は変えない（取り込むのは new だけ）
    expect(p.counts.warnings).toBe(p.warnings.length);
    expect(plan.planned.map((x) => x.freee.freeeJournalId)).toEqual([
      ...EXPECTED_JOURNAL_V2.addedIds,
    ]);
  });

  it("同じファイルをもう一度読むと、変更・削除の警告は出ない", () => {
    const { refs, journalNos } = importedV1();
    const { grouped, activeRefs } = activeFor(FIXTURE_FILES.journal, refs);
    const p = planImport(planInput(grouped, { activeRefs, rangeRefs: refs, journalNos })).preview;
    expect(p.counts).toMatchObject({ new: 0, already: 14 });
    expect(p.warnings.filter((w) => w.code.startsWith("FREEE_"))).toEqual([]);
  });

  it("削除の検出はファイルの日付の範囲（選んだ年度の仕訳の最小〜最大）の参照に限る", () => {
    const { refs, journalNos } = importedV1();
    const outside = [
      ref("800000001", { freeeDate: "2024-12-31", journalId: "j-prev" }),
      ref("800000002", { freeeDate: "2026-01-01", journalId: "j-next" }),
    ];
    const { grouped, activeRefs } = activeFor(FIXTURE_FILES.journalV2, refs);
    const p = planImport(
      planInput(grouped, { activeRefs, rangeRefs: [...refs, ...outside], journalNos }),
    ).preview;
    expect(
      p.warnings.filter((w) => w.code === "FREEE_DELETED").map((w) => w.freeeJournalId),
    ).toEqual([DELETED_ID]);
  });

  it("取消済みの参照・ファイルに残っている取込不可の仕訳は削除にしない。帳簿の仕訳番号が分からなければ null", () => {
    const { refs } = importedV1();
    const revoked = refs.map((r) =>
      r.freeeJournalId === DELETED_ID ? { ...r, revokedAt: "2026-10-19T00:00:00.000Z" } : r,
    );
    const { grouped, activeRefs } = activeFor(FIXTURE_FILES.journalV2, revoked);
    const p = planImport(planInput(grouped, { activeRefs, rangeRefs: revoked })).preview;
    expect(p.warnings.filter((w) => w.code === "FREEE_DELETED")).toEqual([]);
    expect(p.warnings.find((w) => w.code === "FREEE_CHANGED")?.details?.journalNo).toBeNull();

    const rejectedRef = ref("777", { freeeDate: "2025-06-01" });
    const withRejected = {
      ...grouped,
      rejected: [
        ...grouped.rejected,
        {
          freeeJournalId: "777",
          freeeJournalNo: null,
          date: "2025-06-01",
          adjustment: false,
          code: "MISSING_FIELD" as const,
        },
      ],
    };
    const q = planImport(
      planInput(withRejected, { activeRefs, rangeRefs: [...revoked, rejectedRef] }),
    ).preview;
    expect(q.warnings.filter((w) => w.code === "FREEE_DELETED")).toEqual([]);
  });

  it("選んでいない年度の参照は削除にしない", () => {
    const { refs, journalNos } = importedV1();
    const { grouped, activeRefs } = activeFor(FIXTURE_FILES.journalV2, refs);
    const p = planImport(
      planInput(grouped, {
        activeRefs,
        rangeRefs: refs,
        journalNos,
        periods: [makeFiscalPeriod(2025), makeFiscalPeriod(2026)],
        options: { fiscalYears: [2026] },
      }),
    ).preview;
    expect(p.warnings.filter((w) => w.code === "FREEE_DELETED")).toEqual([]);
  });

  it("rangeRefs を渡さなければ削除は検出しない（従来どおり）", () => {
    const { refs } = importedV1();
    const { grouped, activeRefs } = activeFor(FIXTURE_FILES.journalV2, refs);
    const p = planImport(planInput(grouped, { activeRefs })).preview;
    expect(p.warnings.filter((w) => w.code === "FREEE_DELETED")).toEqual([]);
    expect(p.warnings.filter((w) => w.code === "FREEE_CHANGED")).toHaveLength(1);
  });
});
