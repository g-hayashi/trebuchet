import { describe, expect, it } from "vitest";
import {
  commitFreeeImport,
  previewFreeeImport,
  voidImportBatch,
} from "../../src/usecases/import-freee.ts";
import { EXPECTED_JOURNAL_V2, FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { commitFixture, journalInput, setup, stateOf } from "./import-usecase-setup.ts";

const CHANGED_ID = EXPECTED_JOURNAL_V2.changedIds[0];
const DELETED_ID = EXPECTED_JOURNAL_V2.deletedIds[0];
const v2 = (overrides = {}) =>
  journalInput(FIXTURE_FILES.journalV2, {
    expected: { fileSha256: "a".repeat(64), countNew: 2 },
    ...overrides,
  });

function bookJournalOf(s: ReturnType<typeof setup>, freeeJournalId: string) {
  const r = s.uow.imports.refs.find((x) => x.freeeJournalId === freeeJournalId);
  const j = r === undefined ? undefined : s.ledger.getJournal(r.journalId);
  if (r === undefined || j === undefined) throw new Error(freeeJournalId);
  return { ref: r, journal: j };
}

describe("差分の取込（T066, FR-028〜030）", () => {
  it("v1 を取り込んだ後の v2 のプレビュー: 追加2件が new、変更・削除を帳簿の仕訳番号つきで警告する", () => {
    const s = setup();
    commitFixture(s);
    const changed = bookJournalOf(s, CHANGED_ID);
    const deleted = bookJournalOf(s, DELETED_ID);
    const before = stateOf(s);

    const r = previewFreeeImport(s, v2());
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.counts).toMatchObject({ new: 2, already: 13, excluded: 1 });
    expect(r.value.warnings.find((w) => w.code === "FREEE_CHANGED")).toMatchObject({
      freeeJournalId: CHANGED_ID,
      details: {
        journalId: changed.journal.id,
        journalNo: changed.journal.journalNo,
        before: changed.ref.snapshotJson,
        after: expect.stringContaining("5500"),
      },
    });
    expect(r.value.warnings.find((w) => w.code === "FREEE_DELETED")).toEqual({
      code: "FREEE_DELETED",
      message: expect.any(String),
      freeeJournalId: DELETED_ID,
      details: {
        journalId: deleted.journal.id,
        journalNo: deleted.journal.journalNo,
        freeeJournalNo: "5090101",
        before: deleted.ref.snapshotJson,
      },
    });
    expect(stateOf(s)).toEqual(before);
  });

  it("v2 を確定すると追加分だけを登録し、変更・削除された仕訳は帳簿のまま。警告の数を取込の回に残す", () => {
    const s = setup();
    commitFixture(s);
    const changed = bookJournalOf(s, CHANGED_ID);
    const deleted = bookJournalOf(s, DELETED_ID);

    const r = commitFreeeImport(s, v2());
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.batch).toMatchObject({ countNew: 2, countAlready: 13 });
    expect(r.value.batch.countWarnings).toBe(r.value.preview.warnings.length);
    expect(
      r.value.preview.warnings.filter((w) => w.code.startsWith("FREEE_")).map((w) => w.code),
    ).toEqual(["FREEE_CHANGED", "FREEE_DELETED"]);
    expect(s.ledger.getJournal(changed.journal.id)).toEqual(changed.journal);
    expect(s.ledger.getJournal(deleted.journal.id)).toEqual(deleted.journal);
    expect(
      s.uow.imports.refs.filter((x) => x.batchId === r.value.batch.id).map((x) => x.freeeJournalId),
    ).toEqual([...EXPECTED_JOURNAL_V2.addedIds]);
  });

  it("取込を取り消した後は、v1 の参照を変更・削除の比較に使わない", () => {
    const s = setup();
    const { batch } = commitFixture(s);
    expect(voidImportBatch(s, { batchId: batch.id, reason: "やり直す" }).ok).toBe(true);
    const r = previewFreeeImport(s, v2());
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.counts.new).toBe(15);
    expect(r.value.warnings.filter((w) => w.code.startsWith("FREEE_"))).toEqual([]);
  });
});
