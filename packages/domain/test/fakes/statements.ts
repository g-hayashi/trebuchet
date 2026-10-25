import type {
  StatementStore,
  SuggestionContext,
  SuggestionPayload,
  SuggestionProvider,
} from "../../src/ports.ts";
import { domainError, err, type Result, type StatementAuditEntry } from "../../src/types.ts";
import { InMemoryLedgerRepository } from "./ledger.ts";
import { InMemoryMasterRepository } from "./master.ts";
import { fakeUnitOfWork } from "./unit-of-work.ts";

type StatementState = {
  audits: StatementAuditEntry[];
};

/**
 * StatementStore のフェイク。メソッドは各ストーリーのタスクで、ポートと実装と同時に足す
 */
export class InMemoryStatementStore implements StatementStore {
  state: StatementState = { audits: [] };

  get audits(): StatementAuditEntry[] {
    return this.state.audits;
  }

  appendStatementAudit(entry: StatementAuditEntry): void {
    this.state.audits.push(structuredClone(entry));
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
