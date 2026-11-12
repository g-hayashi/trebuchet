import type {
  InferenceRule,
  InferenceRuleHistoryRecord,
  StatementAuditEntry,
  StatementCandidateRecord,
  StatementLinkRecord,
  StatementRecord,
  StatementStore,
  StatementUnitOfWork,
} from "@trebuchet/domain";
import {
  type StatementAccount,
  type StatementBatch,
  type StatementSettings,
  StatementSource,
} from "@trebuchet/schema";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { asTaxCategory, insertionOrder, type TenantConn } from "./internal.ts";
import {
  inferenceRuleHistory,
  inferenceRules,
  statementAccounts,
  statementAuditLog,
  statementBatches,
  statementCandidates,
  statementLinks,
  statementSettings,
  statementSources,
  statements,
} from "./schema/tenant.ts";
import { drizzleUnitOfWork } from "./unit-of-work.ts";

type StatementRow = typeof statements.$inferSelect;

const toRecord = (row: StatementRow): StatementRecord => ({
  ...row,
  transferFlag: row.transferFlag === 1,
});

const toRow = (record: StatementRecord): StatementRow => ({
  ...record,
  transferFlag: record.transferFlag ? 1 : 0,
});

type SourceRow = typeof statementSources.$inferSelect;

/** 保存した JSON を Zod で検証して戻す（壊れていれば例外）。見出しの署名は JSON 配列か NULL */
const toSource = (row: SourceRow): StatementSource => ({
  id: row.id,
  name: row.name,
  fixedAccountName: row.fixedAccountName,
  mapping: StatementSource.shape.mapping.parse(JSON.parse(row.mappingJson)),
  header:
    row.headerSignature === null
      ? null
      : StatementSource.shape.header.parse(JSON.parse(row.headerSignature)),
  lastUsedAt: row.lastUsedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toSourceRow = (source: StatementSource): SourceRow => ({
  id: source.id,
  name: source.name,
  fixedAccountName: source.fixedAccountName,
  headerSignature: source.header === null ? null : JSON.stringify(source.header),
  mappingJson: JSON.stringify(source.mapping),
  lastUsedAt: source.lastUsedAt,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});

/**
 * StatementStore の Drizzle（better-sqlite3）による実装。メソッドはすべて同期。
 */
export class DrizzleStatementStore implements StatementStore {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  appendStatementAudit(entry: StatementAuditEntry): void {
    this.db.insert(statementAuditLog).values(entry).run();
  }

  listStatementAccounts(): StatementAccount[] {
    return this.db.select().from(statementAccounts).orderBy(asc(statementAccounts.name)).all();
  }

  upsertStatementAccount(account: StatementAccount): void {
    const { id: _id, createdAt: _createdAt, ...changes } = account;
    this.db
      .insert(statementAccounts)
      .values(account)
      .onConflictDoUpdate({ target: statementAccounts.id, set: changes })
      .run();
  }

  listStatementSources(): StatementSource[] {
    return this.db
      .select()
      .from(statementSources)
      .orderBy(asc(statementSources.name))
      .all()
      .map(toSource);
  }

  upsertStatementSource(source: StatementSource): void {
    const row = toSourceRow(source);
    const { id: _id, createdAt: _createdAt, ...changes } = row;
    this.db
      .insert(statementSources)
      .values(row)
      .onConflictDoUpdate({ target: statementSources.id, set: changes })
      .run();
  }

  deleteStatementSource(id: string): void {
    const result = this.db.delete(statementSources).where(eq(statementSources.id, id)).run();
    if (result.changes === 0) throw new Error(`statement source not found: ${id}`);
  }

  insertStatementBatch(batch: StatementBatch): void {
    this.db.insert(statementBatches).values(batch).run();
  }

  listStatementBatches(): StatementBatch[] {
    return this.db
      .select()
      .from(statementBatches)
      .orderBy(desc(statementBatches.createdAt), desc(statementBatches.id))
      .all();
  }

  insertStatements(rows: StatementRecord[]): void {
    for (const row of rows) this.db.insert(statements).values(toRow(row)).run();
  }

  listStatements(): StatementRecord[] {
    return this.db.select().from(statements).orderBy(insertionOrder).all().map(toRecord);
  }

  markStatementChanged(id: string, changedJson: string): void {
    const result = this.db
      .update(statements)
      .set({ changedJson, changedAckAt: null })
      .where(eq(statements.id, id))
      .run();
    if (result.changes === 0) throw new Error(`statement not found: ${id}`);
  }

  acknowledgeStatementChange(id: string, at: string): void {
    const result = this.db
      .update(statements)
      .set({ changedAckAt: at })
      .where(eq(statements.id, id))
      .run();
    if (result.changes === 0) throw new Error(`statement not found: ${id}`);
  }

  setStatementExcluded(id: string, excluded: { at: string; reason: string | null } | null): void {
    const result = this.db
      .update(statements)
      .set({ excludedAt: excluded?.at ?? null, excludedReason: excluded?.reason ?? null })
      .where(eq(statements.id, id))
      .run();
    if (result.changes === 0) throw new Error(`statement not found: ${id}`);
  }

  listStatementCandidates(): StatementCandidateRecord[] {
    return this.db.select().from(statementCandidates).orderBy(insertionOrder).all();
  }

  upsertStatementCandidate(candidate: StatementCandidateRecord): void {
    const { statementId: _statementId, ...changes } = candidate;
    this.db
      .insert(statementCandidates)
      .values(candidate)
      .onConflictDoUpdate({ target: statementCandidates.statementId, set: changes })
      .run();
  }

  deleteStatementCandidate(statementId: string): void {
    this.db
      .delete(statementCandidates)
      .where(eq(statementCandidates.statementId, statementId))
      .run();
  }

  listStatementLinks(): StatementLinkRecord[] {
    return this.db.select().from(statementLinks).orderBy(insertionOrder).all();
  }

  /** 索引 `statement_links_journal` で引く */
  listLinksOfJournal(journalId: string): StatementLinkRecord[] {
    return this.db
      .select()
      .from(statementLinks)
      .where(eq(statementLinks.journalId, journalId))
      .orderBy(insertionOrder)
      .all();
  }

  insertStatementLink(link: StatementLinkRecord): void {
    this.db.insert(statementLinks).values(link).run();
  }

  revokeStatementLink(id: string, at: string, reason: string): void {
    const result = this.db
      .update(statementLinks)
      .set({ revokedAt: at, revokedReason: reason })
      .where(and(eq(statementLinks.id, id), isNull(statementLinks.revokedAt)))
      .run();
    if (result.changes === 0) throw new Error(`active statement link not found: ${id}`);
  }

  listInferenceRules(): InferenceRule[] {
    return this.db
      .select()
      .from(inferenceRules)
      .orderBy(insertionOrder)
      .all()
      .map((row) => ({ ...row, taxCategory: asTaxCategory(row.taxCategory) }));
  }

  insertInferenceRule(rule: InferenceRule): void {
    this.db.insert(inferenceRules).values(rule).run();
  }

  updateInferenceRule(rule: InferenceRule): void {
    const { id: _id, createdAt: _createdAt, ...changes } = rule;
    const result = this.db
      .update(inferenceRules)
      .set(changes)
      .where(eq(inferenceRules.id, rule.id))
      .run();
    if (result.changes === 0) throw new Error(`inference rule not found: ${rule.id}`);
  }

  appendInferenceRuleHistory(entry: InferenceRuleHistoryRecord): void {
    this.db.insert(inferenceRuleHistory).values(entry).run();
  }

  listInferenceRuleHistory(ruleId: string): InferenceRuleHistoryRecord[] {
    return this.db
      .select()
      .from(inferenceRuleHistory)
      .where(eq(inferenceRuleHistory.ruleId, ruleId))
      .orderBy(insertionOrder)
      .all();
  }

  getStatementSettings(): StatementSettings | undefined {
    const row = this.db.select().from(statementSettings).where(eq(statementSettings.id, 1)).get();
    if (row === undefined) return undefined;
    return {
      bulkThreshold: row.bulkThreshold,
      externalThreshold: row.externalThreshold,
      updatedAt: row.updatedAt,
    };
  }

  saveStatementSettings(settings: StatementSettings): void {
    this.db
      .insert(statementSettings)
      .values({ id: 1, ...settings })
      .onConflictDoUpdate({ target: statementSettings.id, set: settings })
      .run();
  }
}

/** StatementUnitOfWork の実装。仕訳・マスタ・明細の記録を同じトランザクションで扱う（INV-47） */
export const createStatementUnitOfWork = (db: TenantConn): StatementUnitOfWork =>
  drizzleUnitOfWork(db, (tx) => ({ statements: new DrizzleStatementStore(tx) }));
