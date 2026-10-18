import type { EntitySummary, RegistryRepository } from "@trebuchet/domain";
import { asc, eq } from "drizzle-orm";
import { entities } from "./schema/registry.ts";
import type { RegistryDb } from "./tenant-store.ts";

const summary = {
  id: entities.id,
  name: entities.name,
  kind: entities.kind,
  createdAt: entities.createdAt,
};

/** RegistryRepository の Drizzle（better-sqlite3）による実装 */
export class DrizzleRegistryRepository implements RegistryRepository {
  private readonly db: RegistryDb;

  constructor(db: RegistryDb) {
    this.db = db;
  }

  /** 作成日時の順 */
  listEntities(): EntitySummary[] {
    return this.db
      .select(summary)
      .from(entities)
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
}
