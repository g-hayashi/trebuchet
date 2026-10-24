import { randomUUIDv7 } from "node:crypto";
import {
  DrizzleAuthStore,
  DrizzleBackupStore,
  DrizzleClosingStore,
  DrizzleClosingUnitOfWork,
  DrizzleImportStore,
  DrizzleImportUnitOfWork,
  DrizzleInvoicingStore,
  DrizzleInvoicingUnitOfWork,
  DrizzleLedgerRepository,
  DrizzleMasterRepository,
  DrizzleRecurringStore,
  DrizzleRecurringUnitOfWork,
  DrizzleRegistryRepository,
  dataDir,
  openRegistry,
  type TenantDb,
} from "@trebuchet/db";
import type {
  AuthStore,
  BackupStore,
  Clock,
  ClosingSettingsDeps,
  ClosingStore,
  CommitAdjustmentDeps,
  IdGenerator,
  ImportStore,
  ImportUnitOfWork,
  InvoicingStore,
  InvoicingUnitOfWork,
  LedgerDeps,
  MasterDeps,
  MasterRepository,
  RecurringStore,
  RecurringUnitOfWork,
  ReportDeps,
  SecretStore,
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

/** 家事按分・地代家賃の内訳（list・save 系）の依存。トランザクションを渡せる */
export function closingSettingsDeps(db: TenantConn): ClosingSettingsDeps {
  return { masters: new DrizzleMasterRepository(db), closing: closingStore(db), ids, clock };
}

/**
 * 決算整理の仕訳の案の確定（commitAdjustment）の依存。案の作り直しに使う帳簿の読み取りは、
 * トランザクションと同じ接続（c.var.db）から読む（取込の期首残高の案と同じ形）
 */
export function commitAdjustmentDeps(db: TenantDb): CommitAdjustmentDeps {
  return {
    uow: new DrizzleClosingUnitOfWork(db),
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
    uow: new DrizzleInvoicingUnitOfWork(db),
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
    uow: new DrizzleRecurringUnitOfWork(db),
    recurring: new DrizzleRecurringStore(db),
    ids,
  };
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
