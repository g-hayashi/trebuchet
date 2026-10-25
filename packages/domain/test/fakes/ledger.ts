import {
  type JournalReplacement,
  type LedgerRepository,
  type NewJournal,
  RepositoryConflictError,
} from "../../src/ports.ts";
import type { AuditEntry, Journal, JournalQuery, Page, Result } from "../../src/types.ts";

/** LedgerRepository のフェイク。transaction は err か例外のときに状態を巻き戻す */
export class InMemoryLedgerRepository implements LedgerRepository {
  state: { journals: Journal[]; audits: AuditEntry[] } = { journals: [], audits: [] };
  /** true なら appendAudit で例外を投げる（ロールバックの確認用） */
  failOnAppendAudit = false;

  get journals(): Journal[] {
    return this.state.journals;
  }
  get audits(): AuditEntry[] {
    return this.state.audits;
  }

  transaction<T>(fn: (tx: LedgerRepository) => Result<T>): Result<T> {
    const snapshot = structuredClone(this.state);
    try {
      const result = fn(this);
      if (!result.ok) this.state = snapshot;
      return result;
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  appendAudit(entry: AuditEntry): void {
    if (this.failOnAppendAudit) throw new Error("appendAudit failed");
    this.state.audits.push(entry);
  }

  nextJournalNo(): number {
    return Math.max(0, ...this.state.journals.map((j) => j.journalNo)) + 1;
  }

  lastJournal(): Journal | undefined {
    return this.state.journals.reduce<Journal | undefined>(
      (last, j) => (last === undefined || j.journalNo > last.journalNo ? j : last),
      undefined,
    );
  }

  insertJournal(journal: NewJournal): Journal {
    if (this.state.journals.some((j) => j.journalNo === journal.journalNo)) {
      throw new Error("UNIQUE constraint failed: journals.journal_no");
    }
    const saved: Journal = {
      ...journal,
      status: "active",
      source: journal.source ?? "manual",
      version: 1,
      updatedAt: journal.createdAt,
    };
    this.state.journals.push(structuredClone(saved));
    return saved;
  }

  getJournal(id: string): Journal | undefined {
    const found = this.state.journals.find((j) => j.id === id);
    return found === undefined ? undefined : structuredClone(found);
  }

  recentJournals(limit: number): Journal[] {
    return [...this.state.journals]
      .sort((a, b) => b.date.localeCompare(a.date) || b.journalNo - a.journalNo)
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }

  replaceJournal(
    id: string,
    journal: JournalReplacement,
    expectedVersion: number,
    updatedAt: string,
  ): Journal {
    const current = this.lockForUpdate(id, expectedVersion);
    const saved: Journal = {
      ...current,
      ...structuredClone(journal),
      version: current.version + 1,
      updatedAt,
    };
    this.state.journals = this.state.journals.map((j) => (j.id === id ? saved : j));
    return structuredClone(saved);
  }

  voidJournal(id: string, expectedVersion: number, updatedAt: string): Journal {
    const current = this.lockForUpdate(id, expectedVersion);
    const saved: Journal = {
      ...current,
      status: "voided",
      version: current.version + 1,
      updatedAt,
    };
    this.state.journals = this.state.journals.map((j) => (j.id === id ? saved : j));
    return structuredClone(saved);
  }

  journalHistory(id: string): AuditEntry[] {
    return this.state.audits.filter((a) => a.targetType === "journal" && a.targetId === id);
  }

  correctingJournalsOf(id: string): Journal[] {
    return this.state.journals
      .filter((j) => j.correctsJournalId === id)
      .sort((a, b) => a.journalNo - b.journalNo)
      .map((j) => structuredClone(j));
  }

  /**
   * 日付の範囲（dateFrom・dateTo）・取消済みを含めるか・cursor・limit だけを扱う（db の実装と同じ並びと cursor）。
   * 金額・取引先・科目・タグ・全文の検索はフェイクでは扱わない（packages/db のテストで確認する）
   */
  findJournals(query: JournalQuery): Page<Journal> {
    const { dateFrom, dateTo, includeVoided, cursor, limit, ...unsupported } = query;
    if (Object.values(unsupported).some((v) => v !== undefined)) {
      throw new Error("この検索はフェイクでは扱わない（packages/db のテストで確認する）");
    }
    const max = limit ?? 50;
    let rows = this.state.journals
      .filter((j) => includeVoided === true || j.status === "active")
      .filter((j) => dateFrom === undefined || j.date >= dateFrom)
      .filter((j) => dateTo === undefined || j.date <= dateTo)
      .sort((a, b) => b.date.localeCompare(a.date) || b.journalNo - a.journalNo);
    if (cursor !== undefined) {
      const [date = "", no = "0"] = cursor.split("_");
      rows = rows.filter((j) => j.date < date || (j.date === date && j.journalNo < Number(no)));
    }
    const page = rows.slice(0, max);
    const last = page.at(-1);
    return {
      items: structuredClone(page),
      nextCursor: rows.length > max && last !== undefined ? `${last.date}_${last.journalNo}` : null,
    };
  }

  private lockForUpdate(id: string, expectedVersion: number): Journal {
    const current = this.state.journals.find((j) => j.id === id);
    if (current === undefined) throw new Error(`journal not found: ${id}`);
    if (current.version !== expectedVersion) {
      throw new RepositoryConflictError("仕訳は他の操作で変更されています");
    }
    return current;
  }
}
