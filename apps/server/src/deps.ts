import { randomUUIDv7 } from "node:crypto";
import {
  createClosingUnitOfWork,
  createImportUnitOfWork,
  createInvoicingUnitOfWork,
  createReceiptFileStore,
  createReceiptUnitOfWork,
  createRecurringUnitOfWork,
  createStatementUnitOfWork,
  DrizzleAiSettingsStore,
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
  openAuth,
  openRegistry,
  openTenant,
  type TenantDb,
  TMP_ROOT,
} from "@trebuchet/db";
import {
  type AuthStore,
  type BackupStore,
  type Clock,
  type ClosingReadDeps,
  type ClosingSettingsDeps,
  type ClosingStore,
  type ClosingUnitOfWork,
  type CommitAdjustmentDeps,
  domainError,
  err,
  type HomeDeps,
  type IdGenerator,
  type ImportStore,
  type ImportUnitOfWork,
  type InvoicingStore,
  type InvoicingUnitOfWork,
  type LedgerDeps,
  type MasterDeps,
  type ReceiptDeps,
  type ReceiptFileStore,
  type ReceiptImageTool,
  type ReceiptReader,
  type ReceiptReadingDeps,
  type RecurringStore,
  type RecurringUnitOfWork,
  type ReportDeps,
  type SecretStore,
  type StatementUnitOfWork,
  type SuggestionProvider,
  type TaxReturnRecordDeps,
} from "@trebuchet/domain";
import { type BackupRunner, createBackupRunner } from "./lib/backup-run.ts";
import { createFmServer } from "./lib/fm-server.ts";
import { createImageTool } from "./lib/image-tool.ts";
import { createKeychainSecretStore, createMemorySecretStore } from "./lib/keychain.ts";
import { todayOf } from "./lib/today.ts";
import { createVault, type Vault } from "./lib/vault.ts";

/** R8: 主キーは UUIDv7 */
export const ids: IdGenerator = { next: () => randomUUIDv7() };

/**
 * 既定の時計。`createApp({ clock })` と main・バックアップの実行が既定値として使う。
 * ルートは `routes(options: RouteOptions)` で受け取った clock を使い、これを直接参照しない（005 R22）
 */
export const clock: Clock = { now: () => new Date().toISOString() };

/** ルートの組み立てに渡す依存。`createApp` が全ルートに同じ clock を渡す */
export type RouteOptions = { clock: Clock };

export const registryRepository = () => new DrizzleRegistryRepository(openRegistry());

/**
 * 認証の情報（auth.sqlite。暗号化しないので施錠中も使える。008 の D2）。要求のたびに今のデータの置き場所を開く。
 * リモートの設定とペアリングのトークンも auth.sqlite なので施錠中も使える（004/T016）。
 * app_settings だけは registry から読むので、施錠中は VaultLockedError
 */
export const authStore = (): AuthStore => new DrizzleAuthStore(openAuth(), openRegistry);

/** 解錠中の DK（008 の D3）。app と背景の処理（main.ts）が同じものを使う */
export const vault: Vault = createVault({ store: authStore });

/** バックアップの実行の記録（registry の backup_runs） */
export const backupStore = (): BackupStore => new DrizzleBackupStore(openRegistry());

/**
 * バックアップのパスフレーズの置き場所（R12）。macOS はキーチェーン。それ以外はメモリだけ（保存しない）。
 * キーチェーンが使えない Mac では、ここをメモリの実装に替える（未入力の間は自動のバックアップが止まる）
 */
export const secretStore: SecretStore =
  process.platform === "darwin" ? createKeychainSecretStore() : createMemorySecretStore();

/** AI の接続の設定（registry の ai_settings。006 R12）。要求のたびに今のデータの置き場所の registry を開く */
export const aiSettingsStore = (): DrizzleAiSettingsStore =>
  new DrizzleAiSettingsStore(openRegistry());

/**
 * 端末内の AI（`fm serve`）。最初の推定で起動し、server の終了で止める（006 R10）。
 * ポートは環境変数 `TREBUCHET_FM_PORT`（既定 18790）
 */
export const fmServer = createFmServer({
  port: Number.parseInt(process.env.TREBUCHET_FM_PORT ?? "", 10) || 18790,
});

/** バックアップの実行（同時に 1 つだけ）。app と自動のスケジューラーが同じものを使う */
export const backupRunner: BackupRunner = createBackupRunner({
  auth: authStore,
  backups: backupStore,
  clock,
  ids,
  dataDir,
  tmpRoot: TMP_ROOT,
});

/** リクエストの事業体の DB（c.var.db）に対するマスタのユースケースの依存 */
export function masterDeps(db: TenantDb, clock: Clock): MasterDeps {
  return { repo: new DrizzleMasterRepository(db), ids, clock };
}

/**
 * 決算の UnitOfWork（マスタと ClosingStore を同じトランザクションで扱う）を使うユースケースの依存。
 * 科目の変更（updateAccount。欄番号の変更の履歴を ClosingStore に残す）が使う
 */
export function accountUpdateDeps(
  db: TenantDb,
  clock: Clock,
): {
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
  clock: Clock,
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
export function commitAdjustmentDeps(db: TenantDb, clock: Clock): CommitAdjustmentDeps {
  return {
    uow: createClosingUnitOfWork(db),
    reports: new DrizzleLedgerRepository(db),
    ids,
    clock,
  };
}

/** リクエストの事業体の DB に対する仕訳のユースケース（登録・訂正・取消・参照）の依存 */
export function journalDeps(db: TenantDb, clock: Clock): LedgerDeps {
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
 * `invoicing` はトランザクションの外の読み取り（`originOfJournal` など）に使う
 */
export function invoicingDeps(
  db: TenantDb,
  clock: Clock,
): {
  uow: InvoicingUnitOfWork;
  invoicing: InvoicingStore;
  ids: IdGenerator;
  clock: Clock;
} {
  return {
    uow: createInvoicingUnitOfWork(db),
    invoicing: new DrizzleInvoicingStore(db),
    ids,
    clock,
  };
}

/**
 * ホーム（011 US1）の依存。項目ごとに既存のユースケースの UnitOfWork・ストアを読み取りに使う
 * （要約は保存しない。書き込みはない）
 */
export function homeDeps(db: TenantDb): HomeDeps {
  return {
    statements: { uow: createStatementUnitOfWork(db) },
    receipts: { uow: createReceiptUnitOfWork(db) },
    invoicing: { uow: createInvoicingUnitOfWork(db) },
    recurring: { uow: createRecurringUnitOfWork(db) },
    blueReturn: blueReturnDeps(db),
    ledger: new DrizzleLedgerRepository(db),
  };
}

/** 定期仕訳（005）のユースケースの依存 */
export function recurringDeps(
  db: TenantDb,
  clock: Clock,
): {
  uow: RecurringUnitOfWork;
  recurring: RecurringStore;
  ids: IdGenerator;
  clock: Clock;
} {
  return {
    uow: createRecurringUnitOfWork(db),
    recurring: new DrizzleRecurringStore(db),
    ids,
    clock,
  };
}

/** 端末内・外部の AI の推定（006 R10）。実物は `lib/ai-runtime.ts` が作り、`createApp` が差す */
export type SuggestionProviders = { local: SuggestionProvider; external: SuggestionProvider };

/** 「使えない」を返す SuggestionProvider（実物を差すまでの既定。006 T006） */
export const unavailableSuggestionProvider: SuggestionProvider = {
  available: async () => false,
  suggest: async () => err(domainError("AI_NOT_CONFIGURED", "AI を使えません")),
};

/**
 * 明細の取込と AI 仕訳（006）のユースケースの依存。仕訳・マスタ・明細の記録を1つのトランザクションで扱う
 * （INV-47）。`providers` を省略した側は「使えない」（`unavailableSuggestionProvider`）
 */
export function statementDeps(
  db: TenantDb,
  clock: Clock,
  providers: Partial<SuggestionProviders> = {},
): {
  uow: StatementUnitOfWork;
  ids: IdGenerator;
  clock: Clock;
  suggestion: SuggestionProviders;
} {
  return {
    uow: createStatementUnitOfWork(db),
    ids,
    clock,
    suggestion: {
      local: providers.local ?? unavailableSuggestionProvider,
      external: providers.external ?? unavailableSuggestionProvider,
    },
  };
}

/** 証憑（010）の日付は `Asia/Tokyo` の暦日で決める（R2、I2。実行環境のタイムゾーンによらない） */
export const RECEIPT_TIME_ZONE = "Asia/Tokyo";

/** ISO 8601（UTC）の日時を `Asia/Tokyo` の `YYYY-MM-DD` にする（`ReceiptDeps.dateOf`） */
export const receiptDateOf = (iso: string): string =>
  todayOf({ now: () => iso }, RECEIPT_TIME_ZONE);

/** 証憑の画像の変換器（sips。010/R12）。作業ファイルは `.tmp/` の下 */
export const receiptImageTool: ReceiptImageTool = createImageTool({ tmpRoot: TMP_ROOT });

/**
 * 証憑のルートが使う、差し替えられる部品（`createApp({ receipts })`。010/X3）。
 * `files` は事業体ごとの暗号化したファイルの置き場（既定は db の `createReceiptFileStore`。施錠中は VaultLockedError）
 */
export type ReceiptRuntime = {
  imageTool: ReceiptImageTool;
  files: (entityId: string) => ReceiptFileStore;
  /**
   * 外部の AI による読み取り（010 R13。`createApp` が `ai-runtime.ts` の `receipts` を差す）。
   * undefined（または `model()` が undefined）なら設定が無効で、`readReceipt` は呼ばずに AI_NOT_CONFIGURED
   */
  reader: ReceiptReader | undefined;
};

export const defaultReceiptRuntime: ReceiptRuntime = {
  imageTool: receiptImageTool,
  files: createReceiptFileStore,
  reader: undefined,
};

/**
 * 証憑（010）のユースケースの依存。証憑の記録・仕訳を 1 つのトランザクションで扱い（INV-62・64）、
 * ファイルは事業体ごとの `ReceiptFileStore` に書く。`dateOf` は `Asia/Tokyo` 固定
 */
export function receiptDeps(
  db: TenantDb,
  clock: Clock,
  entityId: string,
  runtime: Pick<ReceiptRuntime, "files"> = defaultReceiptRuntime,
): ReceiptDeps {
  return {
    uow: createReceiptUnitOfWork(db),
    files: runtime.files(entityId),
    clock,
    ids,
    dateOf: receiptDateOf,
  };
}

/** 証憑の読み取り（010 US4）の依存。`reader` と `imageTool` は `ReceiptRuntime`（`createApp` が差す） */
export function receiptReadingDeps(
  db: TenantDb,
  clock: Clock,
  entityId: string,
  runtime: ReceiptRuntime = defaultReceiptRuntime,
): ReceiptReadingDeps {
  return {
    ...receiptDeps(db, clock, entityId, runtime),
    images: runtime.imageTool,
    reader: runtime.reader,
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
export function importDeps(
  db: TenantDb,
  clock: Clock,
): {
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
