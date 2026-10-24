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
import type { Result } from "@trebuchet/domain";
import Database from "better-sqlite3";
import { contentSha256, packArchive, unpackArchive } from "./archive.ts";
import { type BackupHeader, type CryptoOptions, decryptBackup, encryptBackup } from "./crypto.ts";
import { beforeRestoreFileName, compactStamp, writeBackupFile } from "./file.ts";
import { createSnapshotDir, currentAppVersion, snapshotDataDir } from "./snapshot.ts";
import type { ManifestEntity, UnpackedArchive } from "./types.ts";

/**
 * 復元の失敗の種類（パスフレーズ・鍵・内容を含めない）。
 * - INVALID: パスフレーズが違う、ファイルが壊れている、読めない（区別しない）
 * - VERSION_MISMATCH: アプリの版が今と一致しない（新しくても古くても）
 * - CANCELLED: 確認で拒否された
 * - BEFORE_BACKUP_FAILED: 復元前のバックアップを書けなかった（何も変えていない）
 * - RESTORE_FAILED: 展開、integrity_check、改名のどれかの失敗（元のデータ場所は無傷）
 */
export type RestoreErrorCode =
  | "INVALID"
  | "VERSION_MISMATCH"
  | "CANCELLED"
  | "BEFORE_BACKUP_FAILED"
  | "RESTORE_FAILED";

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
};

export type RestoreResult = {
  summary: RestoreSummary;
  /** 復元前のバックアップの絶対パス。データ場所に帳簿がなければ null */
  beforeRestoreBackup: string | null;
  /** 元のデータ場所の改名先。元のデータ場所がなかった（または空だった）なら null */
  previousDataDir: string | null;
};

/** テストが失敗を注入するための差し替え。本番は node:fs */
export type RestoreIo = {
  rename?: (from: string, to: string) => void;
  writeFile?: (path: string, bytes: Uint8Array) => void;
};

export type RestoreOptions = {
  /** `.tbk` のパス */
  file: string;
  passphrase: string;
  /** 置き換えるデータ場所 */
  dataDir: string;
  /** 復元前のバックアップの平文の写しを作る場所（`.tmp/`）。写しは finally で必ず消す */
  tmpRoot: string;
  /** 要約を見せて続けてよいかを返す。false なら CANCELLED（何も作らない） */
  confirm: (summary: RestoreSummary) => boolean | Promise<boolean>;
  now?: () => Date;
  crypto?: CryptoOptions;
  io?: RestoreIo;
};

const fail = (error: RestoreErrorCode) => ({ ok: false, error }) as const;

function hasExistingLedger(dataDir: string): boolean {
  if (existsSync(join(dataDir, "registry.sqlite"))) return true;
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
  const registryFile = join(dataDir, "registry.sqlite");
  if (!existsSync(registryFile)) return diffs;
  const registry = new Database(registryFile, { readonly: true, fileMustExist: true });
  try {
    const existing = new Set(
      (registry.prepare("SELECT id FROM entities").all() as { id: string }[]).map((r) =>
        r.id.toLowerCase(),
      ),
    );
    for (const entity of archive.manifest.entities) {
      const id = entity.id.toLowerCase();
      if (!existing.has(id)) continue;
      const currentFile = join(dataDir, "tenants", `${id}.sqlite`);
      const backupFile = archive.files.find((f) => f.path.toLowerCase() === `tenants/${id}.sqlite`);
      if (!existsSync(currentFile) || backupFile === undefined) continue;
      const current = new Database(currentFile, { readonly: true, fileMustExist: true });
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
  const file = join(dataDir, "registry.sqlite");
  if (!existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
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

/** 許すのは `registry.sqlite` と `tenants/<UUID>.sqlite` の形だけ（unpackArchive の検査に重ねる） */
const SAFE_PATH =
  /^(?:registry|tenants\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sqlite$/;

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

/**
 * バックアップの復元（research R13。contracts/cli.md の手順 2〜6）。全部か無か。
 * 復号と検査 → 確認 → 今の帳簿のバックアップ → `<dataDir>.restore-<日時>/` に展開して integrity_check →
 * `app_settings` の引き継ぎ → 改名の入れ替え。失敗はどの経路でも展開先を消し、元の `dataDir` に触らない。
 * server が動いていないことは呼び出し側が確かめる。マイグレーションは当てない。
 */
export async function restoreBackup(
  options: RestoreOptions,
): Promise<Result<RestoreResult, RestoreErrorCode>> {
  const dataDir = resolve(options.dataDir);
  const rename = options.io?.rename ?? renameSync;
  const writeFile = options.io?.writeFile ?? writeFileSync;
  const appVersion = currentAppVersion();

  // 2. 復号と検査（誤ったパスフレーズ・壊れたファイルは区別しない。版の不一致は何も作らず拒否）
  let bytes: Buffer;
  try {
    bytes = readFileSync(options.file);
  } catch {
    return fail("INVALID");
  }
  const decrypted = await decryptBackup(bytes, options.passphrase, appVersion, options.crypto);
  if (!decrypted.ok) return fail(decrypted.error);
  const unpacked = unpackArchive(decrypted.value.archive);
  if (!unpacked.ok) return fail("INVALID");
  const archive = unpacked.value;
  const header = decrypted.value.header;

  // 3. 要約と確認
  const hasLedger = hasExistingLedger(dataDir);
  let differences: RestoreEntityDiff[] = [];
  if (hasLedger) {
    try {
      differences = computeDifferences(dataDir, archive);
    } catch {
      differences = [];
    }
  }
  const summary: RestoreSummary = {
    createdAt: header.createdAt,
    macId: header.macId,
    appVersion: header.appVersion,
    entities: archive.manifest.entities,
    hasExistingLedger: hasLedger,
    differences,
  };
  if (!(await options.confirm(summary))) return fail("CANCELLED");

  const at = pickStamp(dataDir, (options.now ?? (() => new Date()))());
  const stamp = compactStamp(at);
  const restoreDir = `${dataDir}.restore-${stamp}`;
  const beforeDir = `${dataDir}.before-restore-${stamp}`;

  // 4. 今の帳簿を同じパスフレーズ・同じ形式でバックアップ（db の関数だけ。backup_runs には記録しない）
  let beforeRestoreBackup: string | null = null;
  let settings: SettingRow[];
  if (hasLedger) {
    try {
      settings = readAppSettings(dataDir);
      const macId = settings.find((s) => s.key === "mac_id")?.value ?? randomUUID();
      const name = beforeRestoreFileName(at);
      const snapDir = createSnapshotDir(options.tmpRoot);
      try {
        const snapshot = snapshotDataDir(dataDir, snapDir);
        const plain = packArchive(snapshot);
        const sha = contentSha256(plain);
        const encrypted = await encryptBackup(
          plain,
          options.passphrase,
          { appVersion, macId, createdAt: at.toISOString() },
          options.crypto,
        );
        await writeBackupFile(dirname(dataDir), name, encrypted, async (readBack) => {
          const check = await decryptBackup(
            readBack,
            options.passphrase,
            appVersion,
            options.crypto,
          );
          return (
            check.ok &&
            unpackArchive(check.value.archive).ok &&
            contentSha256(check.value.archive) === sha
          );
        });
      } finally {
        rmSync(snapDir, { recursive: true, force: true });
      }
      beforeRestoreBackup = join(dirname(dataDir), name);
    } catch {
      return fail("BEFORE_BACKUP_FAILED");
    }
  } else {
    settings = [];
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
      if (!SAFE_PATH.test(path)) throw new Error("path");
      writeFile(join(restoreDir, path), file.bytes);
    }
    for (const file of archive.files) {
      if (!integrityOk(join(restoreDir, file.path.toLowerCase()))) throw new Error("integrity");
    }
    const registry = new Database(join(restoreDir, "registry.sqlite"), { fileMustExist: true });
    try {
      const insert = registry.prepare(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
      );
      registry.transaction(() => {
        for (const s of settings) insert.run(s.key, s.value, s.updated_at);
      })();
    } finally {
      registry.close();
    }

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

  return { ok: true, value: { summary, beforeRestoreBackup, previousDataDir } };
}
