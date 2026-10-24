import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { isValidEntityId } from "../tenant-store.ts";
import { sha256Hex } from "./archive.ts";
import type { AppVersion, ManifestEntity, Snapshot, SnapshotFile } from "./types.ts";

/** 平文の写しの作業場所の名前。`.tmp/backup-snapshot-<乱数>/` */
export const SNAPSHOT_DIR_PREFIX = "backup-snapshot-";

/** バックアップに含めない registry の表（すべて端末に結びつく。R9・FR-028） */
const EXCLUDED_REGISTRY_TABLES = [
  "passkeys",
  "recovery_codes",
  "sessions",
  "auth_events",
  "app_settings",
  "backup_runs",
  "pairing_tokens",
] as const;

const MIGRATION_JOURNALS = {
  registry: fileURLToPath(new URL("../../drizzle/registry/meta/_journal.json", import.meta.url)),
  tenant: fileURLToPath(new URL("../../drizzle/tenant/meta/_journal.json", import.meta.url)),
};

let cachedVersion: AppVersion | undefined;

/** 今のアプリの版 = registry と tenant のマイグレーションの適用数（R8） */
export function currentAppVersion(): AppVersion {
  if (cachedVersion === undefined) {
    const count = (file: string): number => {
      const journal = JSON.parse(readFileSync(file, "utf8")) as { entries: unknown[] };
      return journal.entries.length;
    };
    cachedVersion = {
      registry: count(MIGRATION_JOURNALS.registry),
      tenant: count(MIGRATION_JOURNALS.tenant),
    };
  }
  return { ...cachedVersion };
}

/** `.tmp/backup-snapshot-<乱数>/` を作って返す。呼び出し側が try/finally で必ず消す */
export function createSnapshotDir(tmpRoot: string): string {
  const dir = join(tmpRoot, `${SNAPSHOT_DIR_PREFIX}${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 前回の異常終了で残った平文の写し（`backup-snapshot-*` のフォルダ）を消す。消した数を返す */
export function removeStaleSnapshots(tmpRoot: string): number {
  if (!existsSync(tmpRoot)) return 0;
  let removed = 0;
  for (const entry of readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(SNAPSHOT_DIR_PREFIX)) continue;
    rmSync(join(tmpRoot, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function vacuumInto(source: string, dest: string): void {
  const db = new Database(source, { fileMustExist: true });
  try {
    db.exec(`VACUUM INTO ${quote(dest)}`);
  } finally {
    db.close();
  }
}

/** 写しを 1 ファイルにする（WAL の付属ファイルを残さない） */
function closeAsSingleFile(db: Database.Database): void {
  db.pragma("journal_mode = DELETE");
  db.close();
}

/**
 * registry の写しの加工（R9）:
 * トリガーを控えて DROP → 7 表の全行を削除 → トリガーを作り直す → VACUUM（消した行を空き領域に残さない）。
 */
function sanitizeRegistryCopy(file: string, hasTenant: (entityId: string) => boolean): void {
  const db = new Database(file, { fileMustExist: true });
  try {
    const triggers = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL")
      .all() as { name: string; sql: string }[];
    const orphans = (db.prepare("SELECT id FROM entities").all() as { id: string }[])
      .map((r) => r.id)
      .filter((id) => !isValidEntityId(id) || !hasTenant(id));
    db.transaction(() => {
      for (const t of triggers) db.exec(`DROP TRIGGER "${t.name.replaceAll('"', '""')}"`);
      for (const table of EXCLUDED_REGISTRY_TABLES) db.exec(`DELETE FROM "${table}"`);
      // tenant の DB のない事業体の行も消す（復元後に開けない事業体を残さない）
      const remove = db.prepare("DELETE FROM entities WHERE id = ?");
      for (const id of orphans) remove.run(id);
      for (const t of triggers) db.exec(t.sql);
    })();
    db.exec("VACUUM");
  } finally {
    closeAsSingleFile(db);
  }
}

function listEntities(registryCopy: string): { id: string; name: string }[] {
  const db = new Database(registryCopy, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT id, name FROM entities ORDER BY created_at, id").all() as {
      id: string;
      name: string;
    }[];
  } finally {
    db.close();
  }
}

function fiscalYears(tenantCopy: string): ManifestEntity["fiscalYears"] {
  const db = new Database(tenantCopy, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT p.fiscal_year AS year,
                (SELECT count(*) FROM journals j WHERE j.fiscal_period_id = p.id) AS journals
         FROM fiscal_periods p ORDER BY p.fiscal_year`,
      )
      .all() as ManifestEntity["fiscalYears"];
  } finally {
    db.close();
  }
}

/**
 * registry と全事業体の DB に VACUUM INTO を実行して、一貫した写しを作る（書き込みを止めない）。
 * 写しは平文なので `tmpDir`（`.tmp/` の下）に作る。呼び出し側が try/finally で `tmpDir` を必ず消す
 * （この関数も失敗したときは `tmpDir` を消してから例外を投げる）。
 * マニフェストの事業体は、registry の写しと事業体の DB の写しの両方にあるものだけ。
 */
export function snapshotDataDir(dataDir: string, tmpDir: string): Snapshot {
  try {
    const registrySource = join(dataDir, "registry.sqlite");
    if (!existsSync(registrySource)) throw new Error("registry.sqlite が見つからない");
    mkdirSync(join(tmpDir, "tenants"), { recursive: true });

    // registry を先に写す。写した後に追加された事業体は、registry にないのでどちらにも載らない
    const registryCopy = join(tmpDir, "registry.sqlite");
    vacuumInto(registrySource, registryCopy);
    sanitizeRegistryCopy(registryCopy, (id) =>
      existsSync(join(dataDir, "tenants", `${id}.sqlite`)),
    );

    const files: SnapshotFile[] = [];
    const entities: ManifestEntity[] = [];
    const tenantFiles: SnapshotFile[] = [];
    for (const entity of listEntities(registryCopy)) {
      if (!isValidEntityId(entity.id)) continue;
      const source = join(dataDir, "tenants", `${entity.id}.sqlite`);
      if (!existsSync(source)) continue;
      const copy = join(tmpDir, "tenants", `${entity.id}.sqlite`);
      vacuumInto(source, copy);
      closeAsSingleFile(new Database(copy, { fileMustExist: true }));
      entities.push({ id: entity.id, name: entity.name, fiscalYears: fiscalYears(copy) });
      tenantFiles.push({ path: `tenants/${entity.id}.sqlite`, bytes: readFileSync(copy) });
    }
    files.push({ path: "registry.sqlite", bytes: readFileSync(registryCopy) }, ...tenantFiles);

    return {
      files,
      manifest: {
        files: files.map((f) => ({
          path: f.path,
          size: f.bytes.length,
          sha256: sha256Hex(f.bytes),
        })),
        entities,
      },
    };
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
}
