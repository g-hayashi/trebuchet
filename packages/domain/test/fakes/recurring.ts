import type { Recurring } from "@trebuchet/schema";
import type { RecurringStore } from "../../src/ports.ts";
import type { InvoicingAuditEntry, RecurringRunRecord } from "../../src/types.ts";
import { InMemoryLedgerRepository } from "./ledger.ts";
import { InMemoryMasterRepository } from "./master.ts";
import { fakeUnitOfWork } from "./unit-of-work.ts";

/** RecurringStore のフェイク。一意制約（定義 × 対象月、仕訳）の違反は例外（DB と同じ） */
export class InMemoryRecurringStore implements RecurringStore {
  state: {
    audits: InvoicingAuditEntry[];
    defs: Recurring[];
    runs: RecurringRunRecord[];
  } = { audits: [], defs: [], runs: [] };

  get audits(): InvoicingAuditEntry[] {
    return this.state.audits;
  }

  appendRecurringAudit(entry: InvoicingAuditEntry): void {
    this.state.audits.push(structuredClone(entry));
  }

  listRecurring(): Recurring[] {
    return structuredClone(
      [...this.state.defs].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }

  getRecurring(id: string): Recurring | null {
    const found = this.state.defs.find((d) => d.id === id);
    return found === undefined ? null : structuredClone(found);
  }

  insertRecurring(def: Recurring): void {
    if (this.state.defs.some((d) => d.id === def.id)) {
      throw new Error("UNIQUE constraint failed: recurring_journals.id");
    }
    this.state.defs.push(structuredClone(def));
  }

  updateRecurring(def: Recurring): void {
    const index = this.state.defs.findIndex((d) => d.id === def.id);
    if (index < 0) throw new Error(`定期仕訳がない: ${def.id}`);
    this.state.defs[index] = structuredClone(def);
  }

  listRuns(recurringId?: string): RecurringRunRecord[] {
    return structuredClone(
      this.state.runs
        .filter((r) => recurringId === undefined || r.recurringId === recurringId)
        .sort(
          (a, b) =>
            a.targetMonth.localeCompare(b.targetMonth) ||
            a.recurringId.localeCompare(b.recurringId),
        ),
    );
  }

  insertRun(run: RecurringRunRecord): void {
    const dup = this.state.runs.some(
      (r) =>
        r.id === run.id ||
        (r.recurringId === run.recurringId && r.targetMonth === run.targetMonth) ||
        (run.journalId !== null && r.journalId === run.journalId),
    );
    if (dup) throw new Error("UNIQUE constraint failed: recurring_runs");
    this.state.runs.push(structuredClone(run));
  }

  markRunsAcknowledged(runIds: string[], at: string): void {
    for (const id of runIds) {
      const found = this.state.runs.find((r) => r.id === id);
      if (found === undefined) throw new Error(`回がない: ${id}`);
      if (found.acknowledgedAt !== null) throw new Error("確認済みの回は更新できません");
      found.acknowledgedAt = at;
    }
  }
}

/** RecurringUnitOfWork のフェイク */
export const fakeRecurringUnitOfWork = (
  ledger = new InMemoryLedgerRepository(),
  masters = new InMemoryMasterRepository(),
  recurring = new InMemoryRecurringStore(),
) => fakeUnitOfWork(ledger, masters, { recurring });
export type FakeRecurringUnitOfWork = ReturnType<typeof fakeRecurringUnitOfWork>;
