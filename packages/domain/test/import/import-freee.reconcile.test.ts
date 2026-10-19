import { describe, expect, it } from "vitest";
import { reconcileFreee, voidImportBatch } from "../../src/usecases/import-freee.ts";
import { FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { readFixture } from "../fixtures/freee/load.ts";
import { commitFixture, registerFixtureOpening, setup, stateOf } from "./import-usecase-setup.ts";

const ledgerBytes = () => readFixture(FIXTURE_FILES.ledger);
const journalBytes = () => readFixture(FIXTURE_FILES.journal);
const DRAWINGS_ID = "900000132";
const DRAWINGS_NO = "5090101";

function imported() {
  const s = setup();
  const commit = commitFixture(s);
  registerFixtureOpening(s);
  return { s, batch: commit.batch };
}

describe("reconcileFreee（T050, FR-021〜023）", () => {
  it("仕訳帳と期首残高を取り込んだ帳簿は、元帳と全科目で一致する。帳簿は変えない", () => {
    const { s } = imported();
    const before = stateOf(s);
    const r = reconcileFreee(s, { bytes: ledgerBytes(), fiscalYear: 2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unmapped).toEqual([]);
    expect(r.value.rows.filter((x) => !x.matched)).toEqual([]);
    expect(r.value.allMatched).toBe(true);
    expect(stateOf(s)).toEqual(before);
  });

  it("取込を取り消すと不一致になり、原因の候補は VOIDED_IMPORT", () => {
    const { s, batch } = imported();
    expect(voidImportBatch(s, { batchId: batch.id, reason: "取消" }).ok).toBe(true);
    const r = reconcileFreee(s, { bytes: ledgerBytes(), fiscalYear: 2025 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.allMatched).toBe(false);
    const drawings = r.value.rows.find((x) => x.accountId === s.code("3090"));
    expect(drawings?.candidates).toEqual([
      {
        date: "2025-09-01",
        freeeJournalNo: DRAWINGS_NO,
        debit: 50_000,
        credit: 0,
        cause: "VOIDED_IMPORT",
      },
    ]);
  });

  it("仕訳帳も渡すと、取込対象外にした仕訳の候補は EXCLUDED（理由つき）", () => {
    const s = setup();
    commitFixture(s, {
      options: { exclude: [DRAWINGS_ID] },
      expected: { fileSha256: "a".repeat(64), countNew: 13 },
    });
    registerFixtureOpening(s);
    const r = reconcileFreee(s, {
      bytes: ledgerBytes(),
      fiscalYear: 2025,
      journal: { bytes: journalBytes(), options: { exclude: [DRAWINGS_ID] } },
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const drawings = r.value.rows.find((x) => x.accountId === s.code("3090"));
    expect(drawings?.matched).toBe(false);
    expect(drawings?.candidates).toEqual([
      {
        date: "2025-09-01",
        freeeJournalNo: DRAWINGS_NO,
        debit: 50_000,
        credit: 0,
        cause: "EXCLUDED",
        reason: "USER_EXCLUDED",
      },
    ]);

    const withoutJournal = reconcileFreee(s, { bytes: ledgerBytes(), fiscalYear: 2025 });
    if (!withoutJournal.ok) throw new Error(JSON.stringify(withoutJournal.error));
    expect(
      withoutJournal.value.rows.find((x) => x.accountId === s.code("3090"))?.candidates[0]?.cause,
    ).toBe("NOT_IMPORTED");
  });

  it("ファイルの誤り: 読めない → IMPORT_UNKNOWN_FORMAT、仕訳帳 → IMPORT_WRONG_KIND", () => {
    const s = setup();
    const unknown = reconcileFreee(s, {
      bytes: new TextEncoder().encode("a,b\n1,2\n"),
      fiscalYear: 2025,
    });
    expect(unknown.ok ? undefined : unknown.error).toMatchObject({
      code: "IMPORT_UNKNOWN_FORMAT",
      details: { expected: "ledger" },
    });
    const wrong = reconcileFreee(s, { bytes: journalBytes(), fiscalYear: 2025 });
    expect(wrong.ok ? undefined : wrong.error).toMatchObject({
      code: "IMPORT_WRONG_KIND",
      details: { expected: "ledger", actual: "journal" },
    });
    const wrongJournal = reconcileFreee(s, {
      bytes: ledgerBytes(),
      fiscalYear: 2025,
      journal: { bytes: ledgerBytes() },
    });
    expect(wrongJournal.ok ? undefined : wrongJournal.error).toMatchObject({
      code: "IMPORT_WRONG_KIND",
      details: { expected: "journal", actual: "ledger" },
    });
  });

  it("会計期間がない年度 → OUT_OF_PERIOD", () => {
    const s = setup();
    const noPeriod = reconcileFreee(s, { bytes: ledgerBytes(), fiscalYear: 2030 });
    expect(noPeriod.ok ? undefined : noPeriod.error.code).toBe("OUT_OF_PERIOD");
  });
});
