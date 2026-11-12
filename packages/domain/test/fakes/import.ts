import type {
  AccountMapping,
  ImportBatch,
  ImportRef,
  JournalSignature,
  TaxMapping,
} from "../../src/import/types.ts";
import type { ImportStore } from "../../src/ports.ts";
import type { Journal } from "../../src/types.ts";
import { InMemoryLedgerRepository } from "./ledger.ts";
import { InMemoryMasterRepository } from "./master.ts";
import { fakeUnitOfWork } from "./unit-of-work.ts";

type ImportState = {
  accountMappings: (AccountMapping & { updatedAt: string })[];
  taxMappings: (TaxMapping & { updatedAt: string })[];
  batches: ImportBatch[];
  refs: ImportRef[];
};

const bySourceName = (a: { sourceName: string }, b: { sourceName: string }) =>
  a.sourceName < b.sourceName ? -1 : a.sourceName > b.sourceName ? 1 : 0;

const stripUpdatedAt = <T extends { updatedAt: string }>({ updatedAt: _, ...row }: T) => row;

/**
 * ImportStore のフェイク。仕訳は InMemoryLedgerRepository から読む。
 * DB の制約（取り消されていない参照の freee の仕訳ID の一意、参照先の仕訳・取込の回の存在）も確かめる
 */
export class InMemoryImportStore implements ImportStore {
  state: ImportState = { accountMappings: [], taxMappings: [], batches: [], refs: [] };
  /** true なら insertBatch で例外を投げる（ロールバックの確認用） */
  failOnInsertBatch = false;
  private readonly ledger: InMemoryLedgerRepository;

  constructor(ledger: InMemoryLedgerRepository) {
    this.ledger = ledger;
  }

  get batches(): ImportBatch[] {
    return this.state.batches;
  }
  get refs(): ImportRef[] {
    return this.state.refs;
  }

  listAccountMappings(): AccountMapping[] {
    return this.state.accountMappings.map(stripUpdatedAt).sort(bySourceName);
  }
  upsertAccountMappings(rows: AccountMapping[], updatedAt: string): void {
    for (const row of rows) {
      if (row.subAccountId !== undefined && row.subAccountName !== undefined) {
        throw new Error("CHECK constraint failed: import_account_mappings_sub_account");
      }
      const others = this.state.accountMappings.filter((m) => m.sourceName !== row.sourceName);
      this.state.accountMappings = [...others, { ...structuredClone(row), updatedAt }];
    }
  }

  listTaxMappings(): TaxMapping[] {
    return this.state.taxMappings.map(stripUpdatedAt).sort(bySourceName);
  }
  upsertTaxMappings(rows: TaxMapping[], updatedAt: string): void {
    for (const row of rows) {
      const others = this.state.taxMappings.filter((m) => m.sourceName !== row.sourceName);
      this.state.taxMappings = [...others, { ...row, updatedAt }];
    }
  }

  activeRefsByFreeeIds(ids: string[]): ImportRef[] {
    const wanted = new Set(ids);
    return this.state.refs
      .filter((r) => r.revokedAt === null && wanted.has(r.freeeJournalId))
      .map((r) => ({ ...r }));
  }
  activeRefsInRange(from: string, to: string): ImportRef[] {
    return this.state.refs
      .filter((r) => r.revokedAt === null && r.freeeDate >= from && r.freeeDate <= to)
      .map((r) => ({ ...r }));
  }

  insertBatch(batch: ImportBatch): void {
    if (this.failOnInsertBatch) throw new Error("insertBatch failed");
    if (this.state.batches.some((b) => b.id === batch.id)) {
      throw new Error("UNIQUE constraint failed: import_batches.id");
    }
    this.state.batches.push(structuredClone(batch));
  }

  insertRefs(refs: ImportRef[]): void {
    for (const ref of refs) {
      if (!this.ledger.journals.some((j) => j.id === ref.journalId)) {
        throw new Error("FOREIGN KEY constraint failed: import_journal_refs.journal_id");
      }
      if (!this.state.batches.some((b) => b.id === ref.batchId)) {
        throw new Error("FOREIGN KEY constraint failed: import_journal_refs.batch_id");
      }
      if (this.state.refs.some((r) => r.journalId === ref.journalId)) {
        throw new Error("UNIQUE constraint failed: import_journal_refs.journal_id");
      }
      if (
        this.state.refs.some((r) => r.revokedAt === null && r.freeeJournalId === ref.freeeJournalId)
      ) {
        throw new Error("UNIQUE constraint failed: import_journal_refs.freee_journal_id");
      }
      this.state.refs.push({ ...ref });
    }
  }

  listBatches(): ImportBatch[] {
    return [...this.state.batches]
      .sort(
        (a, b) =>
          b.importedAt.localeCompare(a.importedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .map((b) => structuredClone(b));
  }
  getBatch(id: string): ImportBatch | undefined {
    const found = this.state.batches.find((b) => b.id === id);
    return found === undefined ? undefined : structuredClone(found);
  }

  journalsOfBatch(id: string): { journal: Journal; ref: ImportRef }[] {
    return this.state.refs
      .filter((r) => r.batchId === id)
      .map((ref) => {
        const journal = this.ledger.getJournal(ref.journalId);
        if (journal === undefined) throw new Error(`journal not found: ${ref.journalId}`);
        return { journal, ref: { ...ref } };
      })
      .sort((a, b) => a.journal.journalNo - b.journal.journalNo);
  }

  voidBatch(id: string, reason: string, at: string): void {
    const batch = this.state.batches.find((b) => b.id === id);
    if (batch === undefined || batch.status !== "active") {
      throw new Error(`active import batch not found: ${id}`);
    }
    this.state.batches = this.state.batches.map((b) =>
      b.id === id ? { ...b, status: "voided", voidedAt: at, voidReason: reason } : b,
    );
    this.state.refs = this.state.refs.map((r) =>
      r.batchId === id && r.revokedAt === null ? { ...r, revokedAt: at } : r,
    );
  }

  manualJournalSignatures(from: string, to: string): JournalSignature[] {
    return this.ledger.journals
      .filter(
        (j) => j.source === "manual" && j.status === "active" && j.date >= from && j.date <= to,
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.journalNo - b.journalNo)
      .map((j) => ({
        journalId: j.id,
        journalNo: j.journalNo,
        date: j.date,
        lines: j.lines.map(({ side, accountId, amount }) => ({ side, accountId, amount })),
      }));
  }
}

/** ImportUnitOfWork のフェイク（INV-11） */
export const fakeImportUnitOfWork = (
  ledger = new InMemoryLedgerRepository(),
  masters = new InMemoryMasterRepository(),
  imports = new InMemoryImportStore(ledger),
) => fakeUnitOfWork(ledger, masters, { imports });
