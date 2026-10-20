import { randomUUIDv7 } from "node:crypto";
import {
  DrizzleClosingStore,
  DrizzleImportStore,
  DrizzleImportUnitOfWork,
  DrizzleLedgerRepository,
  DrizzleMasterRepository,
  DrizzleRegistryRepository,
  openRegistry,
  type TenantDb,
} from "@trebuchet/db";
import type {
  Clock,
  ClosingStore,
  IdGenerator,
  ImportStore,
  ImportUnitOfWork,
  LedgerDeps,
  MasterDeps,
  MasterRepository,
  ReportDeps,
} from "@trebuchet/domain";

/** R8: 主キーは UUIDv7 */
export const ids: IdGenerator = { next: () => randomUUIDv7() };

export const clock: Clock = { now: () => new Date().toISOString() };

export const registryRepository = () => new DrizzleRegistryRepository(openRegistry());

/** リクエストの事業体の DB（c.var.db）に対するマスタのユースケースの依存 */
export function masterDeps(db: TenantDb): MasterDeps {
  return { repo: new DrizzleMasterRepository(db), ids, clock };
}

/** テナントの DB、またはそのトランザクション */
type TenantConn = ConstructorParameters<typeof DrizzleMasterRepository>[0];

/** 決算処理と確定申告の設定（003）の ClosingStore */
export const closingStore = (db: TenantConn): ClosingStore => new DrizzleClosingStore(db);

/**
 * マスタと ClosingStore を同じ接続（トランザクションを渡せばそのトランザクション）で扱う依存。
 * 科目の欄番号の変更（setAccountReportLine）のように、マスタと決算の履歴を同時に書くときに使う
 */
export function masterClosingDeps(db: TenantConn): MasterDeps & { closing: ClosingStore } {
  return { repo: new DrizzleMasterRepository(db), closing: closingStore(db), ids, clock };
}

/** リクエストの事業体の DB に対する決算書の参照（getBlueReturn）の依存 */
export function blueReturnDeps(db: TenantDb): ReportDeps & { closing: ClosingStore } {
  return { ...reportDeps(db), closing: closingStore(db) };
}

/** 控除の回答（getDeductionAnswers・saveDeductionAnswers）の依存。トランザクションを渡せる */
export function deductionAnswersDeps(db: TenantConn): {
  masters: MasterRepository;
  closing: ClosingStore;
  ids: IdGenerator;
  clock: Clock;
} {
  return { masters: new DrizzleMasterRepository(db), closing: closingStore(db), ids, clock };
}

/** リクエストの事業体の DB に対する仕訳のユースケース（登録・訂正・取消・参照）の依存 */
export function journalDeps(db: TenantDb): LedgerDeps {
  return {
    ledger: new DrizzleLedgerRepository(db),
    masters: new DrizzleMasterRepository(db),
    ids,
    clock,
  };
}

/** リクエストの事業体の DB に対する帳票のユースケースの依存 */
export function reportDeps(db: TenantDb): ReportDeps {
  return { masters: new DrizzleMasterRepository(db), reports: new DrizzleLedgerRepository(db) };
}

/**
 * リクエストの事業体の DB に対する取込のユースケースの依存。
 * 仕訳・マスタ・取込の記録を1つのトランザクションで扱う（research R10）
 */
export function importDeps(db: TenantDb): {
  uow: ImportUnitOfWork;
  imports: ImportStore;
  ids: IdGenerator;
  clock: Clock;
} {
  return {
    uow: new DrizzleImportUnitOfWork(db),
    imports: new DrizzleImportStore(db),
    ids,
    clock,
  };
}
