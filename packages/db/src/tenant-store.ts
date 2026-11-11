import { hkdfSync, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WrappedKey } from "@trebuchet/domain";
import { SHA256_PATTERN } from "@trebuchet/schema";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Database, type DrizzleDb, drizzleOf } from "./driver.ts";
import * as authSchema from "./schema/auth.ts";
import * as registrySchema from "./schema/registry.ts";
import * as tenantSchema from "./schema/tenant.ts";
import { DK_BYTES } from "./vault-crypto.ts";

export type TenantDb = DrizzleDb<typeof tenantSchema>;
export type RegistryDb = DrizzleDb<typeof registrySchema>;
export type AuthDb = DrizzleDb<typeof authSchema>;

const MIGRATIONS = {
  tenant: fileURLToPath(new URL("../drizzle/tenant", import.meta.url)),
  registry: fileURLToPath(new URL("../drizzle/registry", import.meta.url)),
  auth: fileURLToPath(new URL("../drizzle/auth", import.meta.url)),
};

const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../../data", import.meta.url));

/** 一時ファイルの置き場所（リポジトリ直下の .tmp/）。/tmp や os.tmpdir() は使わない */
export const TMP_ROOT = fileURLToPath(new URL("../../../.tmp/", import.meta.url));

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

/** registry の DB のファイル名（データ場所の直下。バックアップの中のパスも同じ） */
export const REGISTRY_FILE_NAME = "registry.sqlite";

/** `<データ場所>/registry.sqlite`。`dir` を渡すと、その場所（復元・バックアップの作業場所など）の下のパス */
export function registryFile(dir: string = dataDir()): string {
  return join(dir, REGISTRY_FILE_NAME);
}

/** データ場所からの相対パス `tenants/<entityId 小文字>.sqlite`（registry の `db_file`、バックアップの中のパス）。形は検査しない */
export function tenantRelPath(entityId: string): string {
  return `tenants/${entityId.toLowerCase()}.sqlite`;
}

/** entityId を検証してから DB ファイルのパスを返す（パストラバーサル防止） */
export function tenantFile(entityId: string): string {
  if (!isValidEntityId(entityId)) throw new InvalidEntityIdError(entityId);
  return join(dataDir(), tenantRelPath(entityId));
}

export class InvalidReceiptHashError extends Error {
  constructor() {
    super("invalid receipt file name (expected 64 lowercase hex characters)");
    this.name = "InvalidReceiptHashError";
  }
}

/** 証憑のファイルの置き場所 `<データ場所>/receipts/<entityId 小文字>/`（`tenants/` の下に置かない。010/R9） */
export function receiptsDir(entityId: string): string {
  if (!isValidEntityId(entityId)) throw new InvalidEntityIdError(entityId);
  return join(dataDir(), "receipts", entityId.toLowerCase());
}

/** 証憑のファイルのパス `<receiptsDir>/<sha256>.trc`。entityId と sha256 の形を検査する（パストラバーサル防止） */
export function receiptFile(entityId: string, sha256: string): string {
  const dir = receiptsDir(entityId);
  if (!SHA256_PATTERN.test(sha256)) throw new InvalidReceiptHashError();
  return join(dir, `${sha256}.trc`);
}

/** 認証の表（暗号化しない。008 の D2） */
export function authFile(): string {
  return join(dataDir(), "auth.sqlite");
}

// ---- データ鍵（DK）と DB の鍵（008 の D1。INV-51） ----

/** 施錠中（DK がない）に registry・事業体の DB を開こうとした */
export class VaultLockedError extends Error {
  constructor() {
    super("vault is locked");
    this.name = "VaultLockedError";
  }
}

/** 暗号化する DB の種類。事業体は entityId ごとに別の鍵 */
export type DbKeyScope = "registry" | { tenant: string };

export const DB_KEY_INFO_REGISTRY = "trebuchet/db/registry/v1";

export function tenantDbKeyInfo(entityId: string): string {
  return `trebuchet/db/tenant:${entityId.toLowerCase()}/v1`;
}

/** DB の鍵 = HKDF-SHA256(DK, salt=空, info) の 32 バイト。使い終えたら呼び出し側が fill(0) する */
export function deriveDbKey(dk: Uint8Array, scope: DbKeyScope): Buffer {
  const info = scope === "registry" ? DB_KEY_INFO_REGISTRY : tenantDbKeyInfo(scope.tenant);
  return Buffer.from(hkdfSync("sha256", dk, Buffer.alloc(0), info, DK_BYTES));
}

/** 解錠中の DK（メモリーだけに置く。ディスク・環境変数・ログに出さない） */
let dataKey: Uint8Array | null = null;

/**
 * 解錠: DK（32 バイト）を渡す。渡したバッファはこのモジュールが持ち、`clearDataKey` で 0 で埋める
 * （呼び出し側は写しを残さない）。前の DK があれば先に `clearDataKey` する
 */
export function setDataKey(dk: Uint8Array): void {
  if (dk.length !== DK_BYTES) {
    throw new RangeError(`data key must be ${DK_BYTES} bytes`);
  }
  if (dataKey !== null && dataKey !== dk) clearDataKey();
  dataKey = dk;
}

/** 施錠: registry と事業体の DB のハンドルを閉じ、DK を 0 で埋めて捨てる。auth.sqlite は閉じない */
export function clearDataKey(): void {
  for (const [file, entry] of handles) {
    if (!entry.encrypted) continue;
    entry.client.close();
    handles.delete(file);
  }
  dataKey?.fill(0);
  dataKey = null;
}

export function isUnlocked(): boolean {
  return dataKey !== null;
}

/**
 * 解錠中の DK を fn に渡して結果を返す（server が DK を包み直す・比べるときに使う）。
 * 渡すのは保持しているバッファそのものなので、fn の外へ持ち出さず、書き換えない。施錠中は VaultLockedError
 */
export function withDataKey<T>(fn: (dk: Uint8Array) => T): T {
  if (dataKey === null) throw new VaultLockedError();
  return fn(dataKey);
}

/**
 * 暗号化した SQLite のファイルを、DK から作った鍵で開く（ハンドルは共有しない。呼び出し側が閉じる）。
 * 施錠中は VaultLockedError。鍵が合わなければ最初の読み取り（ここでは schema の読み取り）で
 * SQLITE_NOTADB を投げる（空の DB として扱わない）。ファイルがなければ暗号化した空の DB を作る
 * （`fileMustExist` で止められる）
 */
export function openEncryptedSqlite(
  file: string,
  scope: DbKeyScope,
  options: Database.Options = {},
): Database.Database {
  if (dataKey === null) throw new VaultLockedError();
  const client = new Database(file, options);
  try {
    applyKey(client, scope);
    client.prepare("SELECT count(*) FROM sqlite_schema").get();
    return client;
  } catch (e) {
    client.close();
    throw e;
  }
}

/**
 * 平文の SQLite のファイル（journal_mode が WAL でないもの）を、DK から作った鍵で暗号化し直す
 * （`PRAGMA rekey`。復元で展開したファイルに使う）。施錠中は VaultLockedError
 */
export function encryptSqliteFile(file: string, scope: DbKeyScope): void {
  if (dataKey === null) throw new VaultLockedError();
  const client = new Database(file, { fileMustExist: true });
  try {
    const key = deriveDbKey(dataKey, scope);
    try {
      client.pragma("cipher='sqlcipher'");
      client.pragma(`rekey="x'${key.toString("hex")}'"`);
    } finally {
      key.fill(0);
    }
  } finally {
    client.close();
  }
}

/**
 * 別の DK を一時的に使って fn（同期）を実行し、終わったら元の状態（解錠中なら元の DK、施錠中なら施錠）に戻す。
 * 復元が、バックアップの DK と今の帳簿の DK を使い分けるために使う。開いている registry・事業体の DB は
 * 切り替えの前後で閉じる。DK の写しは終わりに 0 で埋める
 */
export function withDataKeyOverride<T>(dk: Uint8Array, fn: () => T): T {
  const prior = dataKey === null ? null : Buffer.from(dataKey);
  clearDataKey();
  setDataKey(Buffer.from(dk));
  try {
    return fn();
  } finally {
    clearDataKey();
    if (prior !== null) setDataKey(prior);
  }
}

/**
 * 認証の表だけの `auth.sqlite` を作る（暗号化しない）。recovery の包みの 1 行だけを入れ、パスキー・
 * セッションは空（復元の後、次の起動で回復キーで解錠してパスキーを登録する。008 の D9）。
 * 作った後は WAL を残さない 1 ファイルにする。ファイルが既にあれば例外
 */
export function createAuthFile(file: string, recoveryWrap: WrappedKey, now: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const client = new Database(file);
  try {
    migrate(drizzleOf(client, authSchema), { migrationsFolder: MIGRATIONS.auth });
    client
      .prepare(
        "INSERT INTO key_wraps (id, kind, credential_id, salt, iv, tag, wrapped, created_at) VALUES (?, 'recovery', NULL, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        Buffer.from(recoveryWrap.salt),
        Buffer.from(recoveryWrap.iv),
        Buffer.from(recoveryWrap.tag),
        Buffer.from(recoveryWrap.wrapped),
        now,
      );
    client.pragma("journal_mode = DELETE");
  } finally {
    client.close();
  }
}

function applyKey(client: Database.Database, scope: DbKeyScope): void {
  if (dataKey === null) throw new VaultLockedError();
  const key = deriveDbKey(dataKey, scope);
  try {
    client.pragma("cipher='sqlcipher'");
    client.pragma(`key="x'${key.toString("hex")}'"`);
  } finally {
    key.fill(0);
  }
}

type Handle = { client: Database.Database; encrypted: boolean };
const handles = new Map<string, Handle>();

/** scope が null なら暗号化しない（auth.sqlite） */
function openSqlite(
  file: string,
  scope: DbKeyScope | null,
): { client: Database.Database; created: boolean } {
  if (scope !== null && dataKey === null) throw new VaultLockedError();
  const cached = handles.get(file);
  if (cached) return { client: cached.client, created: false };
  mkdirSync(join(file, ".."), { recursive: true });
  const client = new Database(file);
  try {
    if (scope !== null) applyKey(client, scope);
    // 鍵が合わなければここで SQLITE_NOTADB（何も書かずに失敗する）
    client.pragma("journal_mode = WAL");
    client.pragma("foreign_keys = ON");
  } catch (e) {
    client.close();
    throw e;
  }
  handles.set(file, { client, encrypted: scope !== null });
  return { client, created: true };
}

const tenantDbs = new WeakMap<Database.Database, TenantDb>();
const registryDbs = new WeakMap<Database.Database, RegistryDb>();
const authDbs = new WeakMap<Database.Database, AuthDb>();

/** 事業体の DB を開く。初回はマイグレーションを適用し、以降は同じハンドルを返す。施錠中は VaultLockedError */
export function openTenant(entityId: string): TenantDb {
  const { client, created } = openSqlite(tenantFile(entityId), { tenant: entityId });
  const existing = tenantDbs.get(client);
  if (existing && !created) return existing;
  const db = drizzleOf(client, tenantSchema);
  migrate(db, { migrationsFolder: MIGRATIONS.tenant });
  tenantDbs.set(client, db);
  return db;
}

/** registry を開く。施錠中は VaultLockedError */
export function openRegistry(): RegistryDb {
  const { client, created } = openSqlite(registryFile(), "registry");
  const existing = registryDbs.get(client);
  if (existing && !created) return existing;
  const db = drizzleOf(client, registrySchema);
  migrate(db, { migrationsFolder: MIGRATIONS.registry });
  registryDbs.set(client, db);
  return db;
}

/** auth.sqlite を開く。暗号化しないので施錠中でも開ける */
export function openAuth(): AuthDb {
  const { client, created } = openSqlite(authFile(), null);
  const existing = authDbs.get(client);
  if (existing && !created) return existing;
  const db = drizzleOf(client, authSchema);
  migrate(db, { migrationsFolder: MIGRATIONS.auth });
  authDbs.set(client, db);
  return db;
}

/** 開いている DB をすべて閉じる（テストとシャットダウン用）。DK はそのまま */
export function closeAll(): void {
  for (const { client } of handles.values()) client.close();
  handles.clear();
}

/** 対象のハンドルを閉じ、副ファイルと証憑を含めて消す。他の事業体や共通DBには触れない。 */
export function removeTenantData(entityId: string): void {
  withDataKey(() => {
    const file = tenantFile(entityId);
    const entry = handles.get(file);
    if (entry) {
      entry.client.close();
      handles.delete(file);
    }
    rmSync(receiptsDir(entityId), { recursive: true, force: true });
    for (const suffix of ["-wal", "-shm", "-journal", ""])
      rmSync(`${file}${suffix}`, { force: true });
  });
}

/** registry に登録済みの事業体なら正規化した ID を返す。DB ファイルは作らない */
export function findRegisteredEntityId(entityId: string): string | undefined {
  if (!isValidEntityId(entityId)) return undefined;
  const row = openRegistry()
    .select({ id: registrySchema.entities.id })
    .from(registrySchema.entities)
    .where(
      and(
        eq(registrySchema.entities.id, entityId.toLowerCase()),
        eq(registrySchema.entities.status, "active"),
      ),
    )
    .get();
  return row?.id;
}
