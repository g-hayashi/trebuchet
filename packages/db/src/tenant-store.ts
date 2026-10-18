import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as registrySchema from "./schema/registry.ts";
import * as tenantSchema from "./schema/tenant.ts";

export type TenantDb = BetterSQLite3Database<typeof tenantSchema> & {
  $client: Database.Database;
};
export type RegistryDb = BetterSQLite3Database<typeof registrySchema> & {
  $client: Database.Database;
};

const MIGRATIONS = {
  tenant: fileURLToPath(new URL("../drizzle/tenant", import.meta.url)),
  registry: fileURLToPath(new URL("../drizzle/registry", import.meta.url)),
};

const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../../data", import.meta.url));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidEntityIdError extends Error {
  constructor(entityId: string) {
    super(`invalid entityId: ${JSON.stringify(entityId)}`);
    this.name = "InvalidEntityIdError";
  }
}

export function isValidEntityId(entityId: string): boolean {
  return UUID_PATTERN.test(entityId);
}

/** データの置き場所。既定はリポジトリ直下の data/、TREBUCHET_DATA_DIR で変更できる */
export function dataDir(): string {
  return resolve(process.env.TREBUCHET_DATA_DIR ?? DEFAULT_DATA_DIR);
}

/** entityId を検証してから DB ファイルのパスを返す（パストラバーサル防止） */
export function tenantFile(entityId: string): string {
  if (!isValidEntityId(entityId)) throw new InvalidEntityIdError(entityId);
  return join(dataDir(), "tenants", `${entityId.toLowerCase()}.sqlite`);
}

export function registryFile(): string {
  return join(dataDir(), "registry.sqlite");
}

const handles = new Map<string, Database.Database>();

function openSqlite(file: string): { client: Database.Database; created: boolean } {
  const cached = handles.get(file);
  if (cached) return { client: cached, created: false };
  mkdirSync(join(file, ".."), { recursive: true });
  const client = new Database(file);
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  handles.set(file, client);
  return { client, created: true };
}

const tenantDbs = new WeakMap<Database.Database, TenantDb>();
const registryDbs = new WeakMap<Database.Database, RegistryDb>();

/** 事業体の DB を開く。初回はマイグレーションを適用し、以降は同じハンドルを返す */
export function openTenant(entityId: string): TenantDb {
  const { client, created } = openSqlite(tenantFile(entityId));
  const existing = tenantDbs.get(client);
  if (existing && !created) return existing;
  const db = drizzle({ client, schema: tenantSchema });
  migrate(db, { migrationsFolder: MIGRATIONS.tenant });
  tenantDbs.set(client, db);
  return db;
}

export function openRegistry(): RegistryDb {
  const { client, created } = openSqlite(registryFile());
  const existing = registryDbs.get(client);
  if (existing && !created) return existing;
  const db = drizzle({ client, schema: registrySchema });
  migrate(db, { migrationsFolder: MIGRATIONS.registry });
  registryDbs.set(client, db);
  return db;
}

/** 開いている DB をすべて閉じる（テストとシャットダウン用） */
export function closeAll(): void {
  for (const client of handles.values()) client.close();
  handles.clear();
}

/** registry に登録済みの事業体なら正規化した ID を返す。DB ファイルは作らない */
export function findRegisteredEntityId(entityId: string): string | undefined {
  if (!isValidEntityId(entityId)) return undefined;
  const row = openRegistry()
    .select({ id: registrySchema.entities.id })
    .from(registrySchema.entities)
    .where(eq(registrySchema.entities.id, entityId.toLowerCase()))
    .get();
  return row?.id;
}
