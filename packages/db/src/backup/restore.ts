import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Result, WrappedKey } from "@trebuchet/domain";
import { Database } from "../driver.ts";
import { parseRecoveryKey } from "../recovery-key.ts";
import {
  createAuthFile,
  type DbKeyScope,
  encryptSqliteFile,
  openEncryptedSqlite,
  REGISTRY_FILE_NAME,
  registryFile,
  tenantRelPath,
  withDataKeyOverride,
} from "../tenant-store.ts";
import { sha256Hex } from "../util.ts";
import { unwrapDataKey } from "../vault-crypto.ts";
import { isArchivePath, packArchive, unpackArchive } from "./archive.ts";
import {
  type BackupHeader,
  decryptBackup,
  decryptBackupWithRecoveryKey,
  encryptBackup,
} from "./crypto.ts";
import { beforeRestoreFileName, compactStamp, writeBackupFile } from "./file.ts";
import {
  receiptRefsFromSnapshotFiles,
  receiptStoreDir,
  restoreReceiptsFromStore,
} from "./receipts.ts";
import { createSnapshotDir, currentAppVersion, snapshotDataDir } from "./snapshot.ts";
import type { ManifestEntity, UnpackedArchive } from "./types.ts";

/**
 * 復元の失敗の種類（回復キー・鍵・内容を含めない）。
 * - INVALID: 回復キーが違う、ファイルが壊れている、読めない（区別しない）
 * - VERSION_MISMATCH: アプリの版が今と一致しない（新しくても古くても）
 * - CANCELLED: 確認で拒否された
 * - BEFORE_BACKUP_FAILED: 復元前のバックアップを書けなかった（何も変えていない）
 * - RESTORE_FAILED: 展開、integrity_check、改名のどれかの失敗（元のデータ場所は無傷）
 * - RECEIPTS_MISSING: `receipt_files` の証憑のファイルが置き場所に欠ける・壊れている（010 の INV-68。
 *   `allowMissingReceipts` がなければ、何も作らず何も変えない。件数は `onReceiptsMissing` で受け取る）
 */
export type RestoreErrorCode =
  | "INVALID"
  | "VERSION_MISMATCH"
  | "CANCELLED"
  | "BEFORE_BACKUP_FAILED"
  | "RESTORE_FAILED"
  | "RECEIPTS_MISSING";

/** 事業体 1 件の、仕訳の件数と最後の更新（仕訳の updated_at の最大。仕訳がなければ null） */
export type RestoreEntitySide = { journals: number; lastUpdatedAt: string | null };

/** 復元先に同じ事業体（id）が既にあるときの、今の帳簿とバックアップの差 */
export type RestoreEntityDiff = {
  id: string;
  name: string;
  current: RestoreEntitySide;
  backup: RestoreEntitySide;
};

export type RestoreSummary = {
  createdAt: string;
  macId: string;
  appVersion: BackupHeader["appVersion"];
  entities: ManifestEntity[];
  /** データ場所に帳簿（registry か事業体の DB）があるか。あれば復元前に今の帳簿をバックアップする */
  hasExistingLedger: boolean;
  differences: RestoreEntityDiff[];
  /** 差の計算に失敗した（`differences` は空だが「差がない」ではない）。確認の画面でその旨を出す */
  differencesUnavailable: boolean;
  /** 失敗した例外の名前（メッセージは値や鍵のパスを含みうるので入れない）。失敗していなければ null */
  differencesError: string | null;
};

export type RestoreResult = {
  summary: RestoreSummary;
  /** 復元前のバックアップの絶対パス。データ場所に帳簿がなければ null */
  beforeRestoreBackup: string | null;
  /** 元のデータ場所の改名先。元のデータ場所がなかった（または空だった）なら null */
  previousDataDir: string | null;
  /** 置き場所に欠けて（壊れて）いたため戻せなかった証憑の数（`allowMissingReceipts` のときだけ 0 以外） */
  missingReceipts: number;
};

/** テストが失敗を注入するための差し替え。本番は node:fs */
export type RestoreIo = {
  rename?: (from: string, to: string) => void;
  writeFile?: (path: string, bytes: Uint8Array) => void;
};

export type RestoreOptions = {
  /** `.tbk` のパス */
  file: string;
  /** 回復キー（表記ゆれは受ける）。ヘッダーの包み → 今のデータ場所の `auth.sqlite` の包みの順に試す */
  recoveryKey: string;
  /** 置き換えるデータ場所 */
  dataDir: string;
  /** 復元前のバックアップの平文の写しを作る場所（`.tmp/`）。写しは finally で必ず消す */
  tmpRoot: string;
  /** 要約を見せて続けてよいかを返す。false なら CANCELLED（何も作らない） */
  confirm: (summary: RestoreSummary) => boolean | Promise<boolean>;
  /** 証憑の写しのフォルダ（`trebuchet-receipts/`）。既定は `.tbk` と同じフォルダの `trebuchet-receipts/` */
  receiptsDir?: string;
  /** true なら、欠けた証憑があっても帳簿だけを戻す（既定は `RECEIPTS_MISSING` で失敗） */
  allowMissingReceipts?: boolean;
  /** `RECEIPTS_MISSING` で失敗するとき、欠けた・壊れた証憑の数を受け取る */
  onReceiptsMissing?: (count: number) => void;
  now?: () => Date;
  io?: RestoreIo;
};

const fail = (error: RestoreErrorCode) => ({ ok: false, error }) as const;

function hasExistingLedger(dataDir: string): boolean {
  if (existsSync(registryFile(dataDir))) return true;
  try {
    return readdirSync(join(dataDir, "tenants")).some((n) => n.endsWith(".sqlite"));
  } catch {
    return false;
  }
}

function journalStats(db: Database.Database): RestoreEntitySide {
  const row = db
    .prepare("SELECT count(*) AS journals, max(updated_at) AS last FROM journals")
    .get() as { journals: number; last: string | null };
  return { journals: row.journals, lastUpdatedAt: row.last };
}

/** データ場所の registry に同じ id の事業体があるものだけ、仕訳の件数と最後の更新を比べる */
function computeDifferences(dataDir: string, archive: UnpackedArchive): RestoreEntityDiff[] {
  const diffs: RestoreEntityDiff[] = [];
  const registryPath = registryFile(dataDir);
  if (!existsSync(registryPath)) return diffs;
  const registry = openEncryptedSqlite(registryPath, "registry", {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const existing = new Set(
      (registry.prepare("SELECT id FROM entities").all() as { id: string }[]).map((r) =>
        r.id.toLowerCase(),
      ),
    );
    for (const entity of archive.manifest.entities) {
      const id = entity.id.toLowerCase();
      if (!existing.has(id)) continue;
      const currentFile = join(dataDir, tenantRelPath(id));
      const backupFile = archive.files.find((f) => f.path.toLowerCase() === tenantRelPath(id));
      if (!existsSync(currentFile) || backupFile === undefined) continue;
      const current = openEncryptedSqlite(
        currentFile,
        { tenant: id },
        { readonly: true, fileMustExist: true },
      );
      // バックアップ側はメモリに読み込んで開く（平文をディスクに書かない）
      const backup = new Database(backupFile.bytes);
      try {
        diffs.push({
          id: entity.id,
          name: entity.name,
          current: journalStats(current),
          backup: journalStats(backup),
        });
      } finally {
        current.close();
        backup.close();
      }
    }
  } finally {
    registry.close();
  }
  return diffs;
}

type SettingRow = { key: string; value: string; updated_at: string };

/** データ場所の registry の `app_settings` の全行。表がなければ空 */
function readAppSettings(dataDir: string): SettingRow[] {
  const file = registryFile(dataDir);
  if (!existsSync(file)) return [];
  const db = openEncryptedSqlite(file, "registry", { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
      )
      .get();
    if (table === undefined) return [];
    return db.prepare("SELECT key, value, updated_at FROM app_settings").all() as SettingRow[];
  } finally {
    db.close();
  }
}

type AiSettingsRow = {
  id: number;
  local_enabled: number;
  external_enabled: number;
  external_base_url: string | null;
  external_model: string | null;
  receipt_images_enabled: number;
  updated_at: string;
};

/** データ場所の registry の `ai_settings`（端末の AI の接続の設定。006 R12）。表・行がなければ undefined */
function readAiSettings(dataDir: string): AiSettingsRow | undefined {
  const file = registryFile(dataDir);
  if (!existsSync(file)) return undefined;
  const db = openEncryptedSqlite(file, "registry", { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'ai_settings'")
      .get();
    if (table === undefined) return undefined;
    return db
      .prepare(
        "SELECT id, local_enabled, external_enabled, external_base_url, external_model, receipt_images_enabled, updated_at FROM ai_settings WHERE id = 1",
      )
      .get() as AiSettingsRow | undefined;
  } finally {
    db.close();
  }
}

function integrityOk(file: string): boolean {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.pragma("integrity_check") as { integrity_check: string }[];
    return rows.length === 1 && rows[0]?.integrity_check === "ok";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** tbk・展開先・改名先がすべて空いている日時（同じ秒の 2 回目は 1 秒ずつ進める） */
function pickStamp(dataDir: string, start: Date): Date {
  let at = start;
  for (let i = 0; i < 1000; i++) {
    const stamp = compactStamp(at);
    const taken = [
      join(dirname(dataDir), beforeRestoreFileName(at)),
      `${dataDir}.restore-${stamp}`,
      `${dataDir}.before-restore-${stamp}`,
    ].some((p) => existsSync(p));
    if (!taken) return at;
    at = new Date(at.getTime() + 1000);
  }
  throw new Error("空いている名前がない");
}

/** データ場所の `auth.sqlite`（暗号化しない）の recovery の包み。ファイル・行がなければ undefined */
function readCurrentRecoveryWrap(dataDir: string): WrappedKey | undefined {
  const file = join(dataDir, "auth.sqlite");
  if (!existsSync(file)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    return db
      .prepare("SELECT salt, iv, tag, wrapped FROM key_wraps WHERE kind = 'recovery'")
      .get() as WrappedKey | undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** この DK でデータ場所の registry が開けるか（開けなければ SQLITE_NOTADB） */
function opensRegistry(dataDir: string, dk: Uint8Array): boolean {
  return withDataKeyOverride(dk, () => {
    try {
      openEncryptedSqlite(registryFile(dataDir), "registry", {
        readonly: true,
        fileMustExist: true,
      }).close();
      return true;
    } catch {
      return false;
    }
  });
}

/** 今のデータ場所の帳簿を読める DK と、その DK を開く recovery の包み（復元前のバックアップのヘッダー用） */
type CurrentKey = { dk: Buffer; wrap: WrappedKey };

/**
 * 今の帳簿を開ける DK を探す。①今の `auth.sqlite` の recovery の包みを回復キーで開いた DK
 * ②バックアップの DK（同じ DK の系列のとき）の順に、registry が開けた最初のもの。
 * どれでも開けなければ null（別の系列の帳簿。読めないので、差・設定の引き継ぎ・復元前のバックアップはしない。
 * 元のデータ場所は `.before-restore-<日時>` にそのまま残る）。registry がないとき（事業体の DB だけ）は
 * 検査できないので②を返す
 */
function resolveCurrentKey(
  dataDir: string,
  secret: Buffer,
  backupDk: Buffer,
  openedWrap: WrappedKey,
): CurrentKey | null {
  const registryExists = existsSync(registryFile(dataDir));
  const currentWrap = readCurrentRecoveryWrap(dataDir);
  if (currentWrap !== undefined) {
    const dk = unwrapDataKey(currentWrap, secret, "recovery", null);
    if (dk !== null) {
      if (!registryExists || opensRegistry(dataDir, dk)) return { dk, wrap: currentWrap };
      dk.fill(0);
    }
  }
  if (!registryExists || opensRegistry(dataDir, backupDk)) {
    return { dk: Buffer.from(backupDk), wrap: openedWrap };
  }
  return null;
}

/**
 * バックアップの復元（research R13。contracts/cli.md の手順 2〜6）。全部か無か。
 * 回復キーで DK を開いて復号と検査 → 確認 → 今の帳簿のバックアップ → `<dataDir>.restore-<日時>/` に展開して
 * integrity_check → `app_settings` の引き継ぎ → バックアップの DK で暗号化 → `auth.sqlite`（recovery の包みだけ）を
 * 作る → 改名の入れ替え。失敗はどの経路でも展開先を消し、元の `dataDir` に触らない。
 * server が動いていないことは呼び出し側が確かめる。マイグレーションは当てない（008 の D9）。
 */
export async function restoreBackup(
  options: RestoreOptions,
): Promise<Result<RestoreResult, RestoreErrorCode>> {
  const dataDir = resolve(options.dataDir);
  const appVersion = currentAppVersion();

  // 2. 復号と検査（誤った回復キー・壊れたファイルは区別しない。版の不一致は何も作らず拒否）
  let bytes: Buffer;
  try {
    bytes = readFileSync(options.file);
  } catch {
    return fail("INVALID");
  }
  const currentWrap = readCurrentRecoveryWrap(dataDir);
  const decrypted = decryptBackupWithRecoveryKey(
    bytes,
    options.recoveryKey,
    appVersion,
    currentWrap === undefined ? [] : [currentWrap],
  );
  if (!decrypted.ok) return fail(decrypted.error);
  const backupDk = decrypted.value.dk;
  const secret = parseRecoveryKey(options.recoveryKey);
  if (secret === null) {
    backupDk.fill(0);
    return fail("INVALID");
  }
  const hasLedger = hasExistingLedger(dataDir);
  const current = hasLedger
    ? resolveCurrentKey(dataDir, secret, backupDk, decrypted.value.recoveryWrap)
    : null;
  try {
    return await applyRestore(options, dataDir, appVersion, decrypted.value, hasLedger, current);
  } finally {
    backupDk.fill(0);
    secret.fill(0);
    current?.dk.fill(0);
  }
}

type Decrypted = { header: BackupHeader; archive: Buffer; dk: Buffer; recoveryWrap: WrappedKey };

async function applyRestore(
  options: RestoreOptions,
  dataDir: string,
  appVersion: ReturnType<typeof currentAppVersion>,
  decrypted: Decrypted,
  hasLedger: boolean,
  current: CurrentKey | null,
): Promise<Result<RestoreResult, RestoreErrorCode>> {
  const rename = options.io?.rename ?? renameSync;
  const writeFile = options.io?.writeFile ?? writeFileSync;
  const unpacked = unpackArchive(decrypted.archive);
  if (!unpacked.ok) return fail("INVALID");
  const archive = unpacked.value;
  const header = decrypted.header;

  // 3. 要約と確認
  let differences: RestoreEntityDiff[] = [];
  let differencesError: string | null = null;
  if (hasLedger && current !== null) {
    try {
      differences = withDataKeyOverride(current.dk, () => computeDifferences(dataDir, archive));
    } catch (e) {
      // 握りつぶさない。差が出ないまま上書きに進まないよう、要約に失敗を出す
      differences = [];
      differencesError = e instanceof Error ? e.name : "unknown";
    }
  }
  const summary: RestoreSummary = {
    createdAt: header.createdAt,
    macId: header.macId,
    appVersion: header.appVersion,
    entities: archive.manifest.entities,
    hasExistingLedger: hasLedger,
    differences,
    differencesUnavailable: differencesError !== null,
    differencesError,
  };
  if (!(await options.confirm(summary))) return fail("CANCELLED");

  const at = pickStamp(dataDir, (options.now ?? (() => new Date()))());
  const stamp = compactStamp(at);
  const restoreDir = `${dataDir}.restore-${stamp}`;
  const beforeDir = `${dataDir}.before-restore-${stamp}`;

  // 3b. 証憑のファイル（010/R11、INV-68）: 今の帳簿に触れる前に、展開先へ全件を戻す。1 件でも欠ける・壊れていれば
  // （`allowMissingReceipts` でなければ）展開先を消して失敗する。復元前のバックアップも作らず、何も変えない
  let refs: ReturnType<typeof receiptRefsFromSnapshotFiles>;
  try {
    refs = receiptRefsFromSnapshotFiles(archive.files);
  } catch {
    // 事業体の DB が読めない（壊れている）。何も作らない
    return fail("RESTORE_FAILED");
  }
  let missingReceipts = 0;
  if (refs.some((r) => r.sha256s.length > 0)) {
    try {
      mkdirSync(dirname(dataDir), { recursive: true });
      const restored = restoreReceiptsFromStore({
        dk: decrypted.dk,
        storeDir: options.receiptsDir ?? receiptStoreDir(dirname(resolve(options.file))),
        refs,
        targetDir: join(restoreDir, "receipts"),
      });
      missingReceipts = restored.missing;
    } catch {
      rmSync(restoreDir, { recursive: true, force: true });
      return fail("RESTORE_FAILED");
    }
    if (missingReceipts > 0 && options.allowMissingReceipts !== true) {
      rmSync(restoreDir, { recursive: true, force: true });
      options.onReceiptsMissing?.(missingReceipts);
      return fail("RECEIPTS_MISSING");
    }
  }

  // 4. 今の帳簿を同じ形式でバックアップ（db の関数だけ。backup_runs には記録しない）。今の帳簿を読める
  // DK がないとき（別の系列の帳簿）は作らない。元のデータ場所は `.before-restore-<日時>` にそのまま残る
  let beforeRestoreBackup: string | null = null;
  let settings: SettingRow[] = [];
  let aiSettings: AiSettingsRow | undefined;
  if (hasLedger && current !== null) {
    try {
      const currentDk = current.dk;
      const read = withDataKeyOverride(currentDk, () => ({
        settings: readAppSettings(dataDir),
        aiSettings: readAiSettings(dataDir),
      }));
      settings = read.settings;
      aiSettings = read.aiSettings;
      const macId = settings.find((s) => s.key === "mac_id")?.value ?? randomUUID();
      const name = beforeRestoreFileName(at);
      const snapDir = createSnapshotDir(options.tmpRoot);
      try {
        const snapshot = withDataKeyOverride(currentDk, () => snapshotDataDir(dataDir, snapDir));
        const plain = packArchive(snapshot);
        const sha = sha256Hex(plain);
        const encrypted = encryptBackup(plain, currentDk, {
          appVersion,
          macId,
          createdAt: at.toISOString(),
          recoveryWrap: current.wrap,
        });
        await writeBackupFile(dirname(dataDir), name, encrypted, async (readBack) => {
          const check = decryptBackup(readBack, currentDk, appVersion);
          return (
            check.ok &&
            unpackArchive(check.value.archive).ok &&
            sha256Hex(check.value.archive) === sha
          );
        });
      } finally {
        rmSync(snapDir, { recursive: true, force: true });
      }
      beforeRestoreBackup = join(dirname(dataDir), name);
    } catch {
      rmSync(restoreDir, { recursive: true, force: true });
      return fail("BEFORE_BACKUP_FAILED");
    }
  }

  // 5〜6. 展開 → integrity_check → app_settings の引き継ぎ → 改名の入れ替え
  let swapped = false;
  let previousDataDir: string | null = null;
  try {
    mkdirSync(dirname(dataDir), { recursive: true });
    mkdirSync(join(restoreDir, "tenants"), { recursive: true });
    for (const file of archive.files) {
      // マニフェストのパスを信用せず、許す形だけを書く
      const path = file.path.toLowerCase();
      if (!isArchivePath(path)) throw new Error("path");
      writeFile(join(restoreDir, path), file.bytes);
    }
    for (const file of archive.files) {
      if (!integrityOk(join(restoreDir, file.path.toLowerCase()))) throw new Error("integrity");
    }
    const registry = new Database(registryFile(restoreDir), { fileMustExist: true });
    try {
      const insert = registry.prepare(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
      );
      registry.transaction(() => {
        for (const s of settings) insert.run(s.key, s.value, s.updated_at);
        // ai_settings も app_settings と同じく端末の値のまま引き継ぐ（006 R12）
        if (aiSettings !== undefined) {
          registry
            .prepare(
              "INSERT OR REPLACE INTO ai_settings (id, local_enabled, external_enabled, external_base_url, external_model, receipt_images_enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              aiSettings.id,
              aiSettings.local_enabled,
              aiSettings.external_enabled,
              aiSettings.external_base_url,
              aiSettings.external_model,
              aiSettings.receipt_images_enabled,
              aiSettings.updated_at,
            );
        }
      })();
    } finally {
      registry.close();
    }
    // 展開した平文のファイルを、バックアップの DK から作った鍵で暗号化する（008 の D2・D9。入れ替えの前に）
    withDataKeyOverride(decrypted.dk, () => {
      for (const file of archive.files) {
        const path = file.path.toLowerCase();
        const scope: DbKeyScope =
          path === REGISTRY_FILE_NAME
            ? "registry"
            : { tenant: path.slice("tenants/".length, -".sqlite".length) };
        encryptSqliteFile(join(restoreDir, path), scope);
      }
    });
    // auth.sqlite は recovery の包み（DK を開けたもの）だけで作り直す。パスキー・セッションは空。
    // 次の起動で回復キーで解錠し、パスキーを登録する
    createAuthFile(join(restoreDir, "auth.sqlite"), decrypted.recoveryWrap, at.toISOString());

    let removedEmpty = false;
    if (existsSync(dataDir)) {
      if (readdirSync(dataDir).length === 0) {
        rmdirSync(dataDir);
        removedEmpty = true;
      } else {
        rename(dataDir, beforeDir);
        previousDataDir = beforeDir;
      }
    }
    try {
      rename(restoreDir, dataDir);
      swapped = true;
    } catch (e) {
      // 1 回目の改名を元に戻す（全部か無か）
      try {
        if (previousDataDir !== null) rename(beforeDir, dataDir);
        else if (removedEmpty) mkdirSync(dataDir, { recursive: true });
      } catch {
        // 戻せなければ、元のデータは beforeDir に残っている。呼び出し側へは RESTORE_FAILED で知らせる
      }
      throw e;
    }
  } catch {
    return fail("RESTORE_FAILED");
  } finally {
    if (!swapped) rmSync(restoreDir, { recursive: true, force: true });
  }

  return { ok: true, value: { summary, beforeRestoreBackup, previousDataDir, missingReceipts } };
}
