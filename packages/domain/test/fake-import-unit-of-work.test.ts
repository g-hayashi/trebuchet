import { describe, expect, it } from "vitest";
import type { ImportBatch } from "../src/import/types.ts";
import type { NewJournal } from "../src/ports.ts";
import { FakeImportUnitOfWork } from "./fakes.ts";

const batch: ImportBatch = {
  id: "batch-1",
  source: "freee_journal",
  fileName: "journal.csv",
  fileSha256: "0".repeat(64),
  importedAt: "2026-10-19T00:00:00.000Z",
  periodFrom: "2025-03-01",
  periodTo: "2025-03-01",
  fiscalYears: [2025],
  countNew: 1,
  countAlready: 0,
  countExcluded: 0,
  countRejected: 0,
  countWarnings: 0,
  status: "active",
  voidedAt: null,
  voidReason: null,
};

const journal = (id: string, journalNo: number, source?: NewJournal["source"]): NewJournal => ({
  id,
  journalNo,
  date: "2025-03-01",
  fiscalPeriodId: "period-2025",
  memo: null,
  correctsJournalId: null,
  createdAt: "2026-10-19T00:00:00.000Z",
  source,
  lines: [
    {
      id: `${id}-1`,
      lineNo: 1,
      side: "debit",
      accountId: "a",
      subAccountId: null,
      amount: 100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
    {
      id: `${id}-2`,
      lineNo: 2,
      side: "credit",
      accountId: "b",
      subAccountId: null,
      amount: 100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
  ],
});

const ref = (journalId: string, freeeJournalId: string) => ({
  journalId,
  batchId: batch.id,
  freeeJournalId,
  freeeJournalNo: "1",
  freeeDate: "2025-03-01",
  snapshotJson: "{}",
  revokedAt: null,
});

describe("FakeImportUnitOfWork", () => {
  it("例外で仕訳・マスタ・取込の記録をすべて元に戻す（INV-11）", () => {
    const uow = new FakeImportUnitOfWork();
    expect(() =>
      uow.transaction(({ ledger, masters, imports }) => {
        masters.insertTag({ id: "tag-1", name: "出張" });
        ledger.insertJournal(journal("j-1", 1, "import_freee"));
        imports.upsertTaxMappings([{ sourceName: "対象外", taxCategory: "OUT_OF_SCOPE" }], "t");
        imports.insertBatch(batch);
        imports.insertRefs([ref("j-1", "F-1")]);
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(uow.ledger.journals).toEqual([]);
    expect(uow.masters.listTags()).toEqual([]);
    expect(uow.imports.listTaxMappings()).toEqual([]);
    expect(uow.imports.batches).toEqual([]);
    expect(uow.imports.refs).toEqual([]);
  });

  it("insertBatch の失敗の注入でも全体が元に戻る", () => {
    const uow = new FakeImportUnitOfWork();
    uow.imports.failOnInsertBatch = true;
    expect(() =>
      uow.transaction(({ ledger, imports }) => {
        ledger.insertJournal(journal("j-1", 1, "import_freee"));
        imports.insertBatch(batch);
      }),
    ).toThrow("insertBatch failed");
    expect(uow.ledger.journals).toEqual([]);
  });

  it("取り消されていない参照の freee の仕訳ID は一意。voidBatch の後は同じ ID を入れられる（INV-12）", () => {
    const uow = new FakeImportUnitOfWork();
    uow.transaction(({ ledger, imports }) => {
      ledger.insertJournal(journal("j-1", 1, "import_freee"));
      ledger.insertJournal(journal("j-2", 2, "import_freee"));
      imports.insertBatch(batch);
      imports.insertRefs([ref("j-1", "F-1")]);
    });
    expect(() => uow.imports.insertRefs([ref("j-2", "F-1")])).toThrow(/UNIQUE/);
    uow.imports.voidBatch(batch.id, "誤り", "2026-10-20T00:00:00.000Z");
    expect(uow.imports.getBatch(batch.id)?.status).toBe("voided");
    expect(uow.imports.activeRefsByFreeeIds(["F-1"])).toEqual([]);
    expect(() => uow.imports.insertRefs([ref("j-2", "F-1")])).not.toThrow();
    expect(() => uow.imports.voidBatch(batch.id, "もう一度", "t")).toThrow();
  });

  it("仕訳の source は既定で manual。manualJournalSignatures は手入力の有効な仕訳だけ", () => {
    const uow = new FakeImportUnitOfWork();
    uow.ledger.insertJournal(journal("j-1", 1));
    uow.ledger.insertJournal(journal("j-2", 2, "import_freee"));
    expect(uow.ledger.journals.map((j) => j.source)).toEqual(["manual", "import_freee"]);
    expect(uow.imports.manualJournalSignatures("2025-01-01", "2025-12-31")).toEqual([
      {
        journalId: "j-1",
        journalNo: 1,
        date: "2025-03-01",
        lines: [
          { side: "debit", accountId: "a", amount: 100 },
          { side: "credit", accountId: "b", amount: 100 },
        ],
      },
    ]);
  });
});
