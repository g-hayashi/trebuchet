import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { commitFreeeImport, type FreeeCommitInput, previewFreeeImport } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPECTED_JOURNAL,
  EXPECTED_JOURNAL_V2,
  FIXTURE_FILES,
} from "../../domain/test/fixtures/freee/expected.ts";
import { createImportUnitOfWork, DrizzleImportStore } from "../src/import-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import {
  createTestEntity,
  type TempDataDir,
  testClock,
  testIds,
  useTempDataDir,
} from "../src/testing.ts";

// T063: 差分の取込の統合テスト（v1 → v2。FR-028〜030、research R9）

let tmp: TempDataDir;
let db: TenantDb;
let ledger: DrizzleLedgerRepository;
let imports: DrizzleImportStore;

const ids = testIds();
const clock = testClock();

function inputOf(fileName: string, countNew: number): FreeeCommitInput {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../domain/test/fixtures/freee/${fileName}`, import.meta.url)),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, fileName, sha256, options: {}, expected: { fileSha256: sha256, countNew } };
}

const deps = () => ({ uow: createImportUnitOfWork(db), ids, clock });

beforeEach(() => {
  tmp = useTempDataDir("import-incremental");
  db = openTenant(createTestEntity({ firstFiscalYear: 2025 }).id);
  ledger = new DrizzleLedgerRepository(db);
  imports = new DrizzleImportStore(db);
  new DrizzleMasterRepository(db).replaceTaxSettings([
    {
      id: ids.next(),
      effectiveFrom: "2025-01-01",
      taxpayerStatus: "general",
      accountingMethod: "tax_included",
    },
  ]);
});
afterEach(() => tmp.cleanup());

function refOf(freeeJournalId: string) {
  const found = imports
    .activeRefsInRange("2000-01-01", "2100-12-31")
    .find((r) => r.freeeJournalId === freeeJournalId);
  if (found === undefined) throw new Error(`参照がない: ${freeeJournalId}`);
  return found;
}

describe("差分の取込（v1 → v2。createImportUnitOfWork）", () => {
  it("2回目は追加分だけを登録し、変更・削除された仕訳の帳簿は変わらない。警告の数を取込の回に残す", () => {
    const v1Count = EXPECTED_JOURNAL.journalCount - EXPECTED_JOURNAL.priorYearClosingIds.length;
    const first = commitFreeeImport(deps(), inputOf(FIXTURE_FILES.journal, v1Count));
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(first.value.batch.countWarnings).toBe(first.value.preview.warnings.length);

    const changedId = EXPECTED_JOURNAL_V2.changedIds[0];
    const deletedId = EXPECTED_JOURNAL_V2.deletedIds[0];
    const changedRef = refOf(changedId);
    const deletedRef = refOf(deletedId);
    const changedBefore = ledger.getJournal(changedRef.journalId);
    const deletedBefore = ledger.getJournal(deletedRef.journalId);
    if (changedBefore === undefined || deletedBefore === undefined) throw new Error("仕訳がない");
    const journalsBefore = (
      db.$client.prepare("SELECT count(*) AS n FROM journals").get() as { n: number }
    ).n;

    const v2Count = EXPECTED_JOURNAL_V2.addedIds.length;
    const second = commitFreeeImport(deps(), inputOf(FIXTURE_FILES.journalV2, v2Count));
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    const { batch, preview } = second.value;

    expect(batch.countNew).toBe(2);
    expect(batch.countWarnings).toBe(preview.warnings.length);
    expect(batch.countWarnings).toBeGreaterThanOrEqual(2);
    expect(imports.getBatch(batch.id)?.countWarnings).toBe(batch.countWarnings);

    const changed = preview.warnings.find((w) => w.code === "FREEE_CHANGED");
    expect(changed).toMatchObject({
      freeeJournalId: changedId,
      details: {
        journalId: changedBefore.id,
        journalNo: changedBefore.journalNo,
        before: changedRef.snapshotJson,
      },
    });
    expect(preview.warnings.filter((w) => w.code === "FREEE_CHANGED")).toHaveLength(1);
    const deleted = preview.warnings.find((w) => w.code === "FREEE_DELETED");
    expect(deleted).toMatchObject({
      freeeJournalId: deletedId,
      details: {
        journalId: deletedBefore.id,
        journalNo: deletedBefore.journalNo,
        before: deletedRef.snapshotJson,
      },
    });
    expect(preview.warnings.filter((w) => w.code === "FREEE_DELETED")).toHaveLength(1);

    // 帳簿の仕訳は version・状態・行を含めてそのまま
    const changedAfter = ledger.getJournal(changedBefore.id);
    const deletedAfter = ledger.getJournal(deletedBefore.id);
    expect(changedAfter).toEqual(changedBefore);
    expect(deletedAfter).toEqual(deletedBefore);
    expect(changedAfter?.version).toBe(changedBefore.version);
    expect(changedAfter?.status).toBe(changedBefore.status);
    expect(deletedAfter?.status).toBe(deletedBefore.status);
    expect(refOf(changedId).snapshotJson).toBe(changedRef.snapshotJson);

    const journalsAfter = (
      db.$client.prepare("SELECT count(*) AS n FROM journals").get() as { n: number }
    ).n;
    expect(journalsAfter).toBe(journalsBefore + 2);
  });

  it("プレビューは変更・削除を警告し、何も書き込まない", () => {
    const v1Count = EXPECTED_JOURNAL.journalCount - EXPECTED_JOURNAL.priorYearClosingIds.length;
    const first = commitFreeeImport(deps(), inputOf(FIXTURE_FILES.journal, v1Count));
    if (!first.ok) throw new Error(JSON.stringify(first.error));

    const preview = previewFreeeImport(deps(), inputOf(FIXTURE_FILES.journalV2, 2));
    if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    expect(preview.value.counts.new).toBe(2);
    expect(preview.value.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["FREEE_CHANGED", "FREEE_DELETED"]),
    );
    expect(imports.listBatches()).toHaveLength(1);
  });
});
