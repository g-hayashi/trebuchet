import { randomUUIDv7 } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotDataDir } from "../src/backup/snapshot.ts";
import { Database } from "../src/driver.ts";
import { DrizzleRegistryRepository } from "../src/registry-repository.ts";
import { dataDir, openRegistry, openTenant } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("registry-repository");
});
afterEach(() => tmp.cleanup());

function entity(name: string, createdAt: string, demo = false) {
  return { id: randomUUIDv7(), name, kind: "individual" as const, createdAt, demo };
}

describe("DrizzleRegistryRepository: デモの印と準備中（014 T001）", () => {
  it("is_demo の既定は 0。demo: true で作った行は一覧に demo: true で出る", () => {
    const registry = new DrizzleRegistryRepository(openRegistry());
    const normal = entity("通常", "2026-10-18T00:00:00.000Z");
    const demo = entity("デモ", "2026-10-18T00:00:01.000Z", true);
    registry.insertEntity(normal);
    registry.insertEntity(demo);
    expect(registry.listEntities()).toEqual([normal, demo]);
    expect(registry.getEntity(demo.id)?.demo).toBe(true);
    const raw = openRegistry().$client.prepare("SELECT id, is_demo FROM entities").all();
    expect(raw).toEqual(
      expect.arrayContaining([
        { id: normal.id, is_demo: 0 },
        { id: demo.id, is_demo: 1 },
      ]),
    );
  });

  it("is_demo は 0 と 1 以外を拒む（CHECK）", () => {
    const db = openRegistry();
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO entities (id, name, kind, db_file, created_at, is_demo) VALUES ('x', 'n', 'individual', 'tenants/x.sqlite', '2026-01-01', 2)",
        )
        .run(),
    ).toThrow();
  });

  it("preparing の行は listEntities・getEntity・listArchivedEntities に出ず、listPreparingEntities に出る", () => {
    const registry = new DrizzleRegistryRepository(openRegistry());
    const active = entity("通常", "2026-10-18T00:00:00.000Z");
    const preparing = entity("準備中", "2026-10-18T00:00:01.000Z", true);
    registry.insertEntity(active);
    registry.insertEntity({ ...preparing, status: "preparing" });
    expect(registry.listEntities()).toEqual([active]);
    expect(registry.getEntity(preparing.id)).toBeUndefined();
    expect(registry.listArchivedEntities()).toEqual([]);
    expect(registry.listPreparingEntities()).toEqual([preparing]);
    expect(registry.getManagedEntity(preparing.id)?.status).toBe("preparing");
  });

  it("activateEntity は preparing → active にする。active 以外（preparing 以外）からは変えない", () => {
    const registry = new DrizzleRegistryRepository(openRegistry());
    const preparing = entity("準備中", "2026-10-18T00:00:00.000Z", true);
    const archived = entity("非表示", "2026-10-18T00:00:01.000Z");
    const active = entity("通常", "2026-10-18T00:00:02.000Z");
    registry.insertEntity({ ...preparing, status: "preparing" });
    registry.insertEntity(archived);
    registry.insertEntity(active);
    registry.setEntityStatus(archived.id, "archived");

    registry.activateEntity(preparing.id);
    expect(registry.getManagedEntity(preparing.id)?.status).toBe("active");
    expect(registry.listPreparingEntities()).toEqual([]);
    expect(registry.listEntities().map((e) => e.id)).toEqual([preparing.id, active.id]);

    registry.activateEntity(archived.id);
    expect(registry.getManagedEntity(archived.id)?.status).toBe("archived");
    registry.activateEntity(active.id);
    expect(registry.getManagedEntity(active.id)?.status).toBe("active");
  });
});

describe("バックアップと準備中・デモの印（014 T001）", () => {
  it("preparing の行とそのテナントは含めず、is_demo は registry の写しに残る", () => {
    const registry = new DrizzleRegistryRepository(openRegistry());
    const demo = entity("デモ", "2026-10-18T00:00:00.000Z", true);
    const preparing = entity("準備中", "2026-10-18T00:00:01.000Z", true);
    registry.insertEntity(demo);
    registry.insertEntity({ ...preparing, status: "preparing" });
    openTenant(demo.id);
    openTenant(preparing.id);

    const snap = snapshotDataDir(dataDir(), join(dataDir(), "snapshot"));
    expect(snap.manifest.entities.map((e) => e.id)).toEqual([demo.id]);
    expect(snap.files.map((f) => f.path).sort()).toEqual(
      ["registry.sqlite", `tenants/${demo.id}.sqlite`].sort(),
    );
    const copy = openRegistryCopy(join(dataDir(), "snapshot", "registry.sqlite"));
    expect(copy).toEqual([{ id: demo.id, is_demo: 1, status: "active" }]);
  });
});

function openRegistryCopy(file: string): unknown[] {
  // 写しは平文の SQLite（snapshot.ts の sanitizeRegistryCopy と同じ開き方）
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT id, is_demo, status FROM entities ORDER BY id").all();
  } finally {
    db.close();
  }
}
