import type {
  EntityLifecycleStore,
  EntityStatus,
  EntitySummary,
  ManagedEntity,
  RegistryRepository,
} from "@trebuchet/domain";
import { and, asc, eq, notInArray } from "drizzle-orm";
import { entities } from "./schema/registry.ts";
import { type RegistryDb, removeTenantData, tenantRelPath } from "./tenant-store.ts";

const summary = {
  id: entities.id,
  name: entities.name,
  kind: entities.kind,
  createdAt: entities.createdAt,
  isDemo: entities.isDemo,
};

type SummaryRow = { id: string; name: string; kind: EntitySummary["kind"]; createdAt: string };

function toSummary(row: SummaryRow & { isDemo: number }): EntitySummary {
  const { isDemo, ...rest } = row;
  return { ...rest, demo: isDemo === 1 };
}

function toManaged(row: SummaryRow & { isDemo: number; status: EntityStatus }): ManagedEntity {
  return { ...toSummary(row), status: row.status };
}

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
      .all()
      .map(toSummary);
  }

  /** DB ファイルは data ディレクトリからの相対パスで記録する（data ディレクトリを移動できるように） */
  insertEntity(entity: EntitySummary & { status?: "active" | "preparing" | undefined }): void {
    const id = entity.id.toLowerCase();
    this.db
      .insert(entities)
      .values({
        id,
        name: entity.name,
        kind: entity.kind,
        createdAt: entity.createdAt,
        isDemo: entity.demo ? 1 : 0,
        status: entity.status ?? "active",
        dbFile: tenantRelPath(id),
      })
      .run();
  }

  /** `preparing` の行だけを `active` にする */
  activateEntity(id: string): void {
    this.db
      .update(entities)
      .set({ status: "active" })
      .where(and(eq(entities.id, id.toLowerCase()), eq(entities.status, "preparing")))
      .run();
  }

  /** 投入中のまま残った行。作成日時の順 */
  listPreparingEntities(): EntitySummary[] {
    return this.db
      .select(summary)
      .from(entities)
      .where(eq(entities.status, "preparing"))
      .orderBy(asc(entities.createdAt), asc(entities.id))
      .all()
      .map(toSummary);
  }

  renameEntity(id: string, name: string): void {
    this.db.update(entities).set({ name }).where(eq(entities.id, id.toLowerCase())).run();
  }

  listArchivedEntities(): ManagedEntity[] {
    return this.db
      .select({ ...summary, status: entities.status })
      .from(entities)
      .where(notInArray(entities.status, ["active", "preparing"]))
      .orderBy(asc(entities.createdAt), asc(entities.id))
      .all()
      .map(toManaged);
  }

  getManagedEntity(id: string): ManagedEntity | undefined {
    const row = this.db
      .select({ ...summary, status: entities.status })
      .from(entities)
      .where(eq(entities.id, id.toLowerCase()))
      .get();
    return row === undefined ? undefined : toManaged(row);
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
