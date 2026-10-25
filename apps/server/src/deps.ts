import { randomUUIDv7 } from "node:crypto";
import {
  createClosingUnitOfWork,
  createImportUnitOfWork,
  createInvoicingUnitOfWork,
  createRecurringUnitOfWork,
  DrizzleAuthStore,
  DrizzleBackupStore,
  DrizzleClosingStore,
  DrizzleImportStore,
  DrizzleInvoicingStore,
  DrizzleLedgerRepository,
  DrizzleMasterRepository,
  DrizzleRecurringStore,
  DrizzleRegistryRepository,
  dataDir,
  openRegistry,
  openTenant,
  type TenantDb,
} from "@trebuchet/db";
import type {
  AuthStore,
  BackupStore,
  Clock,
  ClosingReadDeps,
  ClosingSettingsDeps,
  ClosingStore,
  ClosingUnitOfWork,
  CommitAdjustmentDeps,
  IdGenerator,
  ImportStore,
  ImportUnitOfWork,
  InvoicingStore,
  InvoicingUnitOfWork,
  LedgerDeps,
  MasterDeps,
  RecurringStore,
  RecurringUnitOfWork,
  ReportDeps,
  SecretStore,
  TaxReturnRecordDeps,
} from "@trebuchet/domain";
import { type BackupRunner, createBackupRunner } from "./lib/backup-run.ts";
import { createKeychainSecretStore, createMemorySecretStore } from "./lib/keychain.ts";
import { TMP_ROOT } from "./lib/paths.ts";

/** R8: 主キーは UUIDv7 */
export const ids: IdGenerator = { next: () => randomUUIDv7() };

export const clock: Clock = { now: () => new Date().toISOString() };

export const registryRepository = () => new DrizzleRegistryRepository(openRegistry());

/** 認証の情報（registry の DB）。要求のたびに今のデータの置き場所の registry を開く */
export const authStore = (): AuthStore => new DrizzleAuthStore(openRegistry());

/** バックアップの実行の記録（registry の backup_runs） */
export const backupStore = (): BackupStore => new DrizzleBackupStore(openRegistry());

/**
 * バックアップのパスフレーズの置き場所（R12）。macOS はキーチェーン。それ以外はメモリだけ（保存しない）。
 * キーチェーンが使えない Mac では、ここをメモリの実装に替える（未入力の間は自動のバックアップが止まる）
 */
export const secretStore: SecretStore =
  process.platform === "darwin" ? createKeychainSecretStore() : createMemorySecretStore();

/** バックアップの実行（同時に 1 つだけ）。app と自動のスケジューラーが同じものを使う */
export const backupRunner: BackupRunner = createBackupRunner({
  auth: authStore,
  backups: backupStore,
  secrets: secretStore,
  clock,
  ids,
  dataDir,
  tmpRoot: TMP_ROOT,
});

/** リクエストの事業体の DB（c.var.db）に対するマスタのユースケースの依存 */
export function masterDeps(db: TenantDb): MasterDeps {
  return { repo: new DrizzleMasterRepository(db), ids, clock };
}

/**
 * 決算の UnitOfWork（マスタと ClosingStore を同じトランザクションで扱う）を使うユースケースの依存。
 * 科目の変更（updateAccount。欄番号の変更の履歴を ClosingStore に残す）が使う
 */
export function accountUpdateDeps(db: TenantDb): {
  uow: ClosingUnitOfWork;
  ids: IdGenerator;
  clock: Clock;
} {
  return { uow: createClosingUnitOfWork(db), ids, clock };
}

/** リクエストの事業体の DB に対する決算書の参照（getBlueReturn）の依存 */
export function blueReturnDeps(db: TenantDb): ReportDeps & { closing: ClosingStore } {
  return { ...reportDeps(db), closing: new DrizzleClosingStore(db) };
}

/**
 * 決算の設定（控除の回答・メモ・按分・内訳・資産・控え）の依存。読み取りは masters・closing、
 * 保存は uow（保存と履歴を 1 つのトランザクションで書く）を使う
 */
export function closingSettingsDeps(
  db: TenantDb,
): ClosingSettingsDeps & ClosingReadDeps & TaxReturnRecordDeps {
  return {
    uow: createClosingUnitOfWork(db),
    masters: new DrizzleMasterRepository(db),
    closing: new DrizzleClosingStore(db),
    ids,
    clock,
  };
}

/**
 * 決算整理の仕訳の案の確定（commitAdjustment）の依存。案の作り直しに使う帳簿の読み取りは、
 * トランザクションと同じ接続（c.var.db）から読む（取込の期首残高の案と同じ形）
 */
export function commitAdjustmentDeps(db: TenantDb): CommitAdjustmentDeps {
  return {
    uow: createClosingUnitOfWork(db),
    reports: new DrizzleLedgerRepository(db),
    ids,
    clock,
  };
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
 * 請求書（005）のユースケースの依存。仕訳・マスタ・請求の記録を1つのトランザクションで扱う（R9）。
 * `clock` はルートが `invoicingRoutes({ clock })` で受け取るので、ここには含めない（R22）。
 * `invoicing` はトランザクションの外の読み取り（`originOfJournal` など）に使う
 */
export function invoicingDeps(db: TenantDb): {
  uow: InvoicingUnitOfWork;
  invoicing: InvoicingStore;
  ids: IdGenerator;
} {
  return {
    uow: createInvoicingUnitOfWork(db),
    invoicing: new DrizzleInvoicingStore(db),
    ids,
  };
}

/** 定期仕訳（005）のユースケースの依存。`clock` はルートから渡す（R22） */
export function recurringDeps(db: TenantDb): {
  uow: RecurringUnitOfWork;
  recurring: RecurringStore;
  ids: IdGenerator;
} {
  return {
    uow: createRecurringUnitOfWork(db),
    recurring: new DrizzleRecurringStore(db),
    ids,
  };
}

/** 定期仕訳の自動登録（スケジューラー）が判定する事業体の ID。registry の全事業体 */
export const entityIds = (): string[] =>
  registryRepository()
    .listEntities()
    .map((e) => e.id);

/** 定期仕訳の自動登録（スケジューラー）が使う、事業体ごとの UnitOfWork */
export const openRecurringUnitOfWork = (entityId: string): RecurringUnitOfWork =>
  createRecurringUnitOfWork(openTenant(entityId));

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
    uow: createImportUnitOfWork(db),
    imports: new DrizzleImportStore(db),
    ids,
    clock,
  };
}
