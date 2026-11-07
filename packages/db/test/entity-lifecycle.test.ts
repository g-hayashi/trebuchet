import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { snapshotDataDir } from "../src/backup/snapshot.ts";
import { DrizzleRegistryRepository } from "../src/registry-repository.ts";
import { closeAll, dataDir, openRegistry } from "../src/tenant-store.ts";
import { createTestEntity, type TempDataDir, useTempDataDir } from "../src/testing.ts";

/** registry の 0003_entity_lifecycle の journal の `when`。これ以降の移行を取り消して再適用させる */
const ENTITY_LIFECYCLE_MIGRATION_WHEN = 1793806363440;

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("entity-lifecycle-db");
});
afterEach(() => tmp.cleanup());

it("旧registryに状態を追加しても組織を保持しactiveにする", () => {
  const db = openRegistry();
  db.$client.exec(`DROP TABLE entities;
    CREATE TABLE entities (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, db_file TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL) STRICT;
    INSERT INTO entities VALUES ('00000000-0000-7000-8000-000000000001', '合成事業', 'individual', 'tenants/synthetic.sqlite', '2026-01-01');
    DELETE FROM __drizzle_migrations WHERE created_at >= ${ENTITY_LIFECYCLE_MIGRATION_WHEN};`);
  closeAll();
  const repo = new DrizzleRegistryRepository(openRegistry());
  expect(repo.listEntities()).toMatchObject([{ name: "合成事業" }]);
  expect(repo.getManagedEntity("00000000-0000-7000-8000-000000000001")?.status).toBe("active");
});

it("バックアップに非表示の組織を保持し、削除処理中の組織を含めない", () => {
  const a = createTestEntity();
  const b = createTestEntity();
  const repo = new DrizzleRegistryRepository(openRegistry());
  repo.setEntityStatus(a.id, "archived");
  repo.setEntityStatus(b.id, "deleting");
  const snapshot = snapshotDataDir(dataDir(), join(dataDir(), "snapshot"));
  expect(snapshot.manifest.entities.map((e) => e.id)).toEqual([a.id]);
});
