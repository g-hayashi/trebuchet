import { randomUUIDv7 } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fc } from "@trebuchet/domain/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packArchive, unpackArchive } from "../src/backup/archive.ts";
import { decryptBackup, encryptBackup } from "../src/backup/crypto.ts";
import { currentAppVersion, snapshotDataDir } from "../src/backup/snapshot.ts";
import { Database } from "../src/driver.ts";
import { openRegistry, openTenant } from "../src/tenant-store.ts";
import { type TempDataDir, TMP_ROOT, useTempDataDir } from "../src/testing.ts";
import {
  dumpSchema,
  dumpTables,
  EXCLUDED_REGISTRY_TABLES,
  entitySpecArb,
  seedAuthRows,
  seedEntities,
} from "./backup-fixtures.ts";

let tmp: TempDataDir;
const cleanups: string[] = [];

beforeEach(() => {
  tmp = useTempDataDir("backup-rt");
});
afterEach(() => {
  tmp.cleanup();
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PASS = "correct horse battery staple 日本語";
const header = {
  appVersion: currentAppVersion(),
  macId: randomUUIDv7(),
  createdAt: "2026-10-31T09:00:00.000Z",
};

/** 往復の結果を `.tmp/` の空の場所に展開して返す */
async function roundtrip(dataDir: string = tmp.dir) {
  const snapDir = join(TMP_ROOT, `backup-snapshot-${randomUUIDv7()}`);
  const restoreDir = join(TMP_ROOT, `backup-restore-${randomUUIDv7()}`);
  cleanups.push(snapDir, restoreDir);
  const snap = snapshotDataDir(dataDir, snapDir);
  const archive = packArchive(snap);
  const encrypted = await encryptBackup(archive, PASS, header);
  const decrypted = await decryptBackup(encrypted, PASS, currentAppVersion());
  if (!decrypted.ok) throw new Error(`復号に失敗: ${decrypted.error}`);
  const unpacked = unpackArchive(decrypted.value.archive);
  if (!unpacked.ok) throw new Error("展開に失敗");
  for (const f of unpacked.value.files) {
    const dest = join(restoreDir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.bytes);
  }
  return { snap, archive, unpacked: unpacked.value, restoreDir, snapDir };
}

describe("INV-25: バックアップの往復", () => {
  it("任意の合成の帳簿（事業体 0 件を含む）が、除外する表を除いて一致する", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entitySpecArb(), { maxLength: 3 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        async (specs, marker) => {
          const t = useTempDataDir("backup-rt-run");
          try {
            const seeded = seedEntities(specs);
            seedAuthRows(marker);
            const originalRegistry = openRegistry().$client;
            const expectRegistry = dumpTables(originalRegistry, EXCLUDED_REGISTRY_TABLES);
            const expectRegistrySchema = dumpSchema(originalRegistry);
            const expectTenants = seeded.map((e) => {
              const c = openTenant(e.id).$client;
              return { id: e.id, tables: dumpTables(c), schema: dumpSchema(c) };
            });

            const { unpacked, restoreDir } = await roundtrip(t.dir);
            expect(unpacked.manifest.entities.map((e) => e.id).sort()).toEqual(
              seeded.map((e) => e.id).sort(),
            );

            const reg = new Database(join(restoreDir, "registry.sqlite"), { readonly: true });
            try {
              expect(dumpTables(reg, EXCLUDED_REGISTRY_TABLES)).toEqual(expectRegistry);
              expect(dumpSchema(reg)).toEqual(expectRegistrySchema);
              for (const table of EXCLUDED_REGISTRY_TABLES) {
                const row = reg.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as {
                  n: number;
                };
                expect(row.n, table).toBe(0);
              }
            } finally {
              reg.close();
            }
            for (const e of expectTenants) {
              const db = new Database(join(restoreDir, "tenants", `${e.id}.sqlite`), {
                readonly: true,
              });
              try {
                expect(dumpTables(db)).toEqual(e.tables);
                expect(dumpSchema(db)).toEqual(e.schema);
              } finally {
                db.close();
              }
            }
          } finally {
            t.cleanup();
          }
        },
      ),
      { numRuns: 6 },
    );
  });

  it("写しに、消した端末の行と auth.sqlite の認証の行の内容が残らない", async () => {
    seedEntities([{ name: "事業", kind: "individual", seed: 1, journals: 1, memo: "", note: "" }]);
    const marker = "ZZ-MARKER-0123456789";
    seedAuthRows(marker);
    const { unpacked } = await roundtrip();
    expect(unpacked.files.map((f) => f.path)).not.toContain("auth.sqlite");
    const registryBytes = unpacked.files.find((f) => f.path === "registry.sqlite")?.bytes;
    expect(registryBytes).toBeDefined();
    for (const needle of [
      `pk-${marker}`,
      `pubkey-${marker}`,
      `name-${marker}`,
      `token-${marker}`,
      `agent-${marker}`,
      `detail-${marker}`,
      `/folder-${marker}`,
      `mac-${marker}`,
      `summary-${marker}`,
      `pairing-${marker}`,
    ]) {
      for (const file of unpacked.files) {
        expect(file.bytes.includes(Buffer.from(needle)), `${file.path}: ${needle}`).toBe(false);
      }
    }
  });

  it("事業体 0 件の帳簿も往復し、事業体 0 件で復元できる", async () => {
    openRegistry();
    const { unpacked, restoreDir } = await roundtrip();
    expect(unpacked.manifest.entities).toEqual([]);
    expect(unpacked.files.map((f) => f.path)).toEqual(["registry.sqlite"]);
    expect(existsSync(join(restoreDir, "registry.sqlite"))).toBe(true);
    const reg = new Database(join(restoreDir, "registry.sqlite"), { readonly: true });
    try {
      expect((reg.prepare("SELECT count(*) AS n FROM entities").get() as { n: number }).n).toBe(0);
    } finally {
      reg.close();
    }
  });

  it("registry にあって tenant の DB のない事業体はマニフェストに載せない", async () => {
    const [e] = seedEntities([
      { name: "事業", kind: "individual", seed: 1, journals: 0, memo: "", note: "" },
    ]);
    if (e === undefined) throw new Error("事業体がない");
    const registry = openRegistry().$client;
    registry
      .prepare(
        "INSERT INTO entities (id, name, kind, db_file, created_at) VALUES (?, 'ghost', 'individual', ?, 'x')",
      )
      .run(
        "00000000-0000-4000-8000-000000000000",
        "tenants/00000000-0000-4000-8000-000000000000.sqlite",
      );
    const { unpacked, restoreDir } = await roundtrip();
    expect(unpacked.manifest.entities.map((x) => x.id)).toEqual([e.id]);
    // 写しの registry からも、tenant の DB のない事業体の行を消す（復元後に開けない事業体を残さない）
    const reg = new Database(join(restoreDir, "registry.sqlite"), { readonly: true });
    try {
      const rows = reg.prepare("SELECT id FROM entities").all() as { id: string }[];
      expect(rows.map((r) => r.id)).toEqual([e.id]);
    } finally {
      reg.close();
    }
  });

  it("tenant の DB があって registry にない事業体は、写しのファイルにも入れない", async () => {
    const [keep, orphan] = seedEntities([
      { name: "残す", kind: "individual", seed: 1, journals: 0, memo: "", note: "" },
      { name: "外す", kind: "individual", seed: 2, journals: 0, memo: "", note: "" },
    ]);
    if (keep === undefined || orphan === undefined) throw new Error("事業体がない");
    openRegistry().$client.prepare("DELETE FROM entities WHERE id = ?").run(orphan.id);
    const { unpacked } = await roundtrip();
    expect(unpacked.manifest.entities.map((x) => x.id)).toEqual([keep.id]);
    expect(unpacked.files.map((f) => f.path).sort()).toEqual(
      ["registry.sqlite", `tenants/${keep.id}.sqlite`].sort(),
    );
  });
});
