import type {
  EntityLifecycleStore,
  EntityStatus,
  EntitySummary,
  ManagedEntity,
  RegistryRepository,
} from "@trebuchet/domain";
import { asc, eq, ne } from "drizzle-orm";
import { entities } from "./schema/registry.ts";
import { type RegistryDb, removeTenantData } from "./tenant-store.ts";

const summary = {
  id: entities.id,
  name: entities.name,
  kind: entities.kind,
  createdAt: entities.createdAt,
};

/** RegistryRepository の Drizzle（better-sqlite3）による実装 */
export class DrizzleRegistryRepository implements RegistryRepository, EntityLifecycleStore {
  private readonly db: RegistryDb;

  constructor(db: RegistryDb) {
    this.db = db;
  }

  /** 作成日時の順 */
  listEntities(): EntitySummary[] {
    return this.db
      .select(summary)
      .from(entities)
      .where(eq(entities.status, "active"))
      .orderBy(asc(entities.createdAt), asc(entities.id))
      .all();
  }

  getEntity(id: string): EntitySummary | undefined {
    return this.db.select(summary).from(entities).where(eq(entities.id, id.toLowerCase())).get();
  }

  /** DB ファイルは data ディレクトリからの相対パスで記録する（data ディレクトリを移動できるように） */
  insertEntity(entity: EntitySummary): void {
    const id = entity.id.toLowerCase();
    this.db
      .insert(entities)
      .values({ ...entity, id, dbFile: `tenants/${id}.sqlite` })
      .run();
  }

  renameEntity(id: string, name: string): void {
    this.db.update(entities).set({ name }).where(eq(entities.id, id.toLowerCase())).run();
  }

  listArchivedEntities(): ManagedEntity[] {
    return this.db
      .select({ ...summary, status: entities.status })
      .from(entities)
      .where(ne(entities.status, "active"))
      .orderBy(asc(entities.createdAt), asc(entities.id))
      .all();
  }

  getManagedEntity(id: string): ManagedEntity | undefined {
    return this.db
      .select({ ...summary, status: entities.status })
      .from(entities)
      .where(eq(entities.id, id.toLowerCase()))
      .get();
  }

  setEntityStatus(id: string, status: EntityStatus): void {
    this.db.update(entities).set({ status }).where(eq(entities.id, id.toLowerCase())).run();
  }

  purgeEntityData(id: string): void {
    // ファイルを先に消す。途中で失敗したら deleting の行を残して再試行する。
    removeTenantData(id);
    this.db.delete(entities).where(eq(entities.id, id.toLowerCase())).run();
  }
}
