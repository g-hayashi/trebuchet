import type {
  Account,
  AuditEntry,
  EntityProfile,
  FiscalPeriod,
  MasterRepository,
  OpeningBalance,
  Partner,
  Result,
  SubAccount,
  Tag,
  TaxCategory,
  TaxCategoryCode,
  TaxRate,
  TaxSetting,
} from "@trebuchet/domain";
import type { RunResult } from "better-sqlite3";
import { asc, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { inTransaction } from "./rollback.ts";
import type * as tenantSchema from "./schema/tenant.ts";
import {
  accounts,
  auditLog,
  consumptionTaxSettings,
  entityProfile,
  fiscalPeriods,
  journalLines,
  openingBalances,
  partners,
  subAccounts,
  tags,
  taxCategories,
  taxRates,
} from "./schema/tenant.ts";

/** テナントの DB、またはそのトランザクション */
type TenantConn = BaseSQLiteDatabase<"sync", RunResult, typeof tenantSchema>;

/** 挿入の順（一覧の既定の順） */
const insertionOrder = sql`rowid`;

/** MasterRepository の Drizzle（better-sqlite3）による実装。メソッドはすべて同期 */
export class DrizzleMasterRepository implements MasterRepository {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  /** SQLite のトランザクション（入れ子は SAVEPOINT）。`err` か例外でロールバックする */
  transaction<T>(fn: (tx: MasterRepository) => Result<T>): Result<T> {
    return inTransaction(this.db, (tx) => fn(new DrizzleMasterRepository(tx)));
  }

  appendAudit(entry: AuditEntry): void {
    this.db.insert(auditLog).values(entry).run();
  }

  getProfile(): EntityProfile | undefined {
    return this.db.select().from(entityProfile).limit(1).get();
  }

  saveProfile(profile: EntityProfile): void {
    const { name, kind, fiscalStartMonth, createdAt } = profile;
    this.db
      .insert(entityProfile)
      .values(profile)
      .onConflictDoUpdate({
        target: entityProfile.id,
        set: { name, kind, fiscalStartMonth, createdAt },
      })
      .run();
  }

  // ---- 勘定科目 ----

  listAccounts(): Account[] {
    return this.db
      .select()
      .from(accounts)
      .orderBy(asc(accounts.sortOrder), asc(accounts.code))
      .all();
  }

  getAccount(id: string): Account | undefined {
    return this.db.select().from(accounts).where(eq(accounts.id, id)).get();
  }

  insertAccount(account: Account): void {
    this.db.insert(accounts).values(account).run();
  }

  updateAccount(account: Account): void {
    const { id, ...rest } = account;
    this.db.update(accounts).set(rest).where(eq(accounts.id, id)).run();
  }

  deleteAccount(id: string): void {
    this.db.transaction((tx) => {
      tx.delete(subAccounts).where(eq(subAccounts.accountId, id)).run();
      tx.delete(accounts).where(eq(accounts.id, id)).run();
    });
  }

  isAccountUsed(accountId: string): boolean {
    const row = this.db.get<{ used: number }>(
      sql`SELECT EXISTS (SELECT 1 FROM ${journalLines} WHERE ${journalLines.accountId} = ${accountId})
        OR EXISTS (SELECT 1 FROM ${openingBalances} WHERE ${openingBalances.accountId} = ${accountId}) AS used`,
    );
    return row.used === 1;
  }

  // ---- 補助科目・取引先・タグ ----

  listSubAccounts(accountId?: string): SubAccount[] {
    const query = this.db.select().from(subAccounts);
    return (accountId === undefined ? query : query.where(eq(subAccounts.accountId, accountId)))
      .orderBy(insertionOrder)
      .all();
  }

  insertSubAccount(subAccount: SubAccount): void {
    this.db.insert(subAccounts).values(subAccount).run();
  }

  listPartners(): Partner[] {
    return this.db.select().from(partners).orderBy(insertionOrder).all();
  }

  insertPartner(partner: Partner): void {
    this.db.insert(partners).values(partner).run();
  }

  updatePartner(partner: Partner): void {
    const { id, ...rest } = partner;
    this.db.update(partners).set(rest).where(eq(partners.id, id)).run();
  }

  listTags(): Tag[] {
    return this.db.select().from(tags).orderBy(insertionOrder).all();
  }

  insertTag(tag: Tag): void {
    this.db.insert(tags).values(tag).run();
  }

  // ---- 消費税 ----

  listTaxCategories(): TaxCategory[] {
    return this.db
      .select()
      .from(taxCategories)
      .orderBy(insertionOrder)
      .all()
      .map((row) => ({ ...row, code: row.code as TaxCategoryCode }));
  }

  listTaxRates(): TaxRate[] {
    return this.db
      .select()
      .from(taxRates)
      .orderBy(asc(taxRates.effectiveFrom), insertionOrder)
      .all()
      .map((row) => ({ ...row, categoryCode: row.categoryCode as TaxCategoryCode }));
  }

  listTaxSettings(): TaxSetting[] {
    return this.db
      .select()
      .from(consumptionTaxSettings)
      .orderBy(asc(consumptionTaxSettings.effectiveFrom))
      .all();
  }

  replaceTaxSettings(settings: TaxSetting[]): void {
    this.db.transaction((tx) => {
      tx.delete(consumptionTaxSettings).run();
      if (settings.length > 0) tx.insert(consumptionTaxSettings).values(settings).run();
    });
  }

  // ---- 会計期間 ----

  listFiscalPeriods(): FiscalPeriod[] {
    return this.db.select().from(fiscalPeriods).orderBy(asc(fiscalPeriods.fiscalYear)).all();
  }

  getFiscalPeriodByYear(fiscalYear: number): FiscalPeriod | undefined {
    return this.db
      .select()
      .from(fiscalPeriods)
      .where(eq(fiscalPeriods.fiscalYear, fiscalYear))
      .get();
  }

  insertFiscalPeriod(period: FiscalPeriod): void {
    this.db.insert(fiscalPeriods).values(period).run();
  }

  updateFiscalPeriod(period: FiscalPeriod): void {
    const { id, ...rest } = period;
    this.db.update(fiscalPeriods).set(rest).where(eq(fiscalPeriods.id, id)).run();
  }

  fiscalPeriodHistory(): AuditEntry[] {
    return this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetType, "fiscal_period"))
      .orderBy(sql`${auditLog}.rowid`)
      .all();
  }

  // ---- 期首残高 ----

  listOpeningBalances(fiscalPeriodId: string): OpeningBalance[] {
    return this.db
      .select()
      .from(openingBalances)
      .where(eq(openingBalances.fiscalPeriodId, fiscalPeriodId))
      .orderBy(insertionOrder)
      .all();
  }

  /** 期間の期首残高を全件置き換える（1トランザクション） */
  replaceOpeningBalances(fiscalPeriodId: string, rows: OpeningBalance[]): void {
    this.db.transaction((tx) => {
      tx.delete(openingBalances).where(eq(openingBalances.fiscalPeriodId, fiscalPeriodId)).run();
      if (rows.length > 0) tx.insert(openingBalances).values(rows).run();
    });
  }
}
