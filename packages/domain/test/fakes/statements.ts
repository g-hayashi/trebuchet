import type { StatementAccount, StatementBatch, StatementSettings } from "@trebuchet/schema";
import type {
  StatementStore,
  SuggestionContext,
  SuggestionPayload,
  SuggestionProvider,
} from "../../src/ports.ts";
import {
  domainError,
  err,
  type Result,
  type StatementAuditEntry,
  type StatementCandidateRecord,
  type StatementLinkRecord,
  type StatementRecord,
} from "../../src/types.ts";
import { InMemoryLedgerRepository } from "./ledger.ts";
import { InMemoryMasterRepository } from "./master.ts";
import { fakeUnitOfWork } from "./unit-of-work.ts";

type StatementState = {
  audits: StatementAuditEntry[];
  accounts: StatementAccount[];
  batches: StatementBatch[];
  statements: StatementRecord[];
  candidates: StatementCandidateRecord[];
  links: StatementLinkRecord[];
  settings: StatementSettings | undefined;
};

/**
 * StatementStore のフェイク。メソッドは各ストーリーのタスクで、ポートと実装と同時に足す。
 * DB の制約（口座名・`stable_key`・`external_id` の一意、回・口座の存在）も確かめる
 */
export class InMemoryStatementStore implements StatementStore {
  state: StatementState = {
    audits: [],
    accounts: [],
    batches: [],
    statements: [],
    candidates: [],
    links: [],
    settings: undefined,
  };
  /** true なら insertStatements で、1 行目を書いた後に例外を投げる（ロールバックの確認用） */
  failOnInsertStatements = false;

  get audits(): StatementAuditEntry[] {
    return this.state.audits;
  }

  appendStatementAudit(entry: StatementAuditEntry): void {
    this.state.audits.push(structuredClone(entry));
  }

  listStatementAccounts(): StatementAccount[] {
    return structuredClone(this.state.accounts).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  upsertStatementAccount(account: StatementAccount): void {
    if (this.state.accounts.some((a) => a.name === account.name && a.id !== account.id)) {
      throw new Error("UNIQUE constraint failed: statement_accounts.name");
    }
    const copy = structuredClone(account);
    const index = this.state.accounts.findIndex((a) => a.id === account.id);
    if (index < 0) this.state.accounts.push(copy);
    else this.state.accounts[index] = copy;
  }

  insertStatementBatch(batch: StatementBatch): void {
    if (this.state.batches.some((b) => b.id === batch.id)) {
      throw new Error("UNIQUE constraint failed: statement_batches.id");
    }
    this.state.batches.push(structuredClone(batch));
  }

  listStatementBatches(): StatementBatch[] {
    return structuredClone(this.state.batches).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  }

  insertStatements(rows: StatementRecord[]): void {
    for (const [i, row] of rows.entries()) {
      if (!this.state.batches.some((b) => b.id === row.batchId)) {
        throw new Error("FOREIGN KEY constraint failed: statements.batch_id");
      }
      if (!this.state.accounts.some((a) => a.id === row.statementAccountId)) {
        throw new Error("FOREIGN KEY constraint failed: statements.statement_account_id");
      }
      if (this.state.statements.some((s) => s.stableKey === row.stableKey)) {
        throw new Error("UNIQUE constraint failed: statements.stable_key");
      }
      if (
        row.externalId !== null &&
        this.state.statements.some((s) => s.externalId === row.externalId)
      ) {
        throw new Error("UNIQUE constraint failed: statements.external_id");
      }
      this.state.statements.push(structuredClone(row));
      if (this.failOnInsertStatements && i === 0) throw new Error("insertStatements failed");
    }
  }

  listStatements(): StatementRecord[] {
    return structuredClone(this.state.statements);
  }

  markStatementChanged(id: string, changedJson: string): void {
    const target = this.state.statements.find((s) => s.id === id);
    if (target === undefined) throw new Error(`statement not found: ${id}`);
    target.changedJson = changedJson;
    target.changedAckAt = null;
  }

  listStatementCandidates(): StatementCandidateRecord[] {
    return structuredClone(this.state.candidates);
  }

  upsertStatementCandidate(candidate: StatementCandidateRecord): void {
    if (!this.state.statements.some((s) => s.id === candidate.statementId)) {
      throw new Error("FOREIGN KEY constraint failed: statement_candidates.statement_id");
    }
    const none = candidate.method === "none";
    const shapeOk = none
      ? candidate.purpose === null && candidate.confidence === null && candidate.draftJson === null
      : candidate.purpose !== null && candidate.confidence !== null;
    if (!shapeOk) throw new Error("CHECK constraint failed: statement_candidates_shape");
    const copy = structuredClone(candidate);
    const index = this.state.candidates.findIndex((c) => c.statementId === candidate.statementId);
    if (index < 0) this.state.candidates.push(copy);
    else this.state.candidates[index] = copy;
  }

  deleteStatementCandidate(statementId: string): void {
    this.state.candidates = this.state.candidates.filter((c) => c.statementId !== statementId);
  }

  listStatementLinks(): StatementLinkRecord[] {
    return structuredClone(this.state.links);
  }

  insertStatementLink(link: StatementLinkRecord): void {
    if (!this.state.statements.some((s) => s.id === link.statementId)) {
      throw new Error("FOREIGN KEY constraint failed: statement_links.statement_id");
    }
    if (link.revokedAt === null) {
      const active = this.state.links.filter((l) => l.revokedAt === null);
      if (active.some((l) => l.statementId === link.statementId)) {
        throw new Error("UNIQUE constraint failed: statement_links.statement_id");
      }
      if (active.some((l) => l.journalLineId === link.journalLineId)) {
        throw new Error("UNIQUE constraint failed: statement_links.journal_line_id");
      }
    }
    this.state.links.push(structuredClone(link));
  }

  getStatementSettings(): StatementSettings | undefined {
    return structuredClone(this.state.settings);
  }

  saveStatementSettings(settings: StatementSettings): void {
    this.state.settings = structuredClone(settings);
  }
}

/** StatementUnitOfWork のフェイク（INV-47。db の `createStatementUnitOfWork` と同じ性質） */
export const fakeStatementUnitOfWork = (
  ledger = new InMemoryLedgerRepository(),
  masters = new InMemoryMasterRepository(),
  statements = new InMemoryStatementStore(),
) => fakeUnitOfWork(ledger, masters, { statements });
export type FakeStatementUnitOfWork = ReturnType<typeof fakeStatementUnitOfWork>;

/**
 * SuggestionProvider のフェイク。既定は使えない（`available` が false、`suggest` は失敗）。
 * `respondWith` で応答を決め、`calls` で渡された内容を確かめる。AI は CI で呼ばない
 */
export class FakeSuggestionProvider implements SuggestionProvider {
  readonly calls: { payload: SuggestionPayload; context: SuggestionContext }[] = [];
  private isAvailable: boolean;
  private response: Result<unknown> = err(domainError("VALIDATION", "AI を使えません"));

  constructor(options: { available?: boolean } = {}) {
    this.isAvailable = options.available ?? false;
  }

  setAvailable(value: boolean): void {
    this.isAvailable = value;
  }

  respondWith(response: Result<unknown>): void {
    this.response = response;
  }

  async available(): Promise<boolean> {
    return this.isAvailable;
  }

  async suggest(payload: SuggestionPayload, context: SuggestionContext): Promise<Result<unknown>> {
    this.calls.push({ payload: structuredClone(payload), context: structuredClone(context) });
    return this.response;
  }
}
