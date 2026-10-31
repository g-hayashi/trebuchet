import { hkdfSync, randomUUIDv7 } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fc } from "@trebuchet/domain/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registrySchema } from "../src/index.ts";
import {
  authFile,
  clearDataKey,
  closeAll,
  DB_KEY_INFO_REGISTRY,
  deriveDbKey,
  openAuth,
  openEncryptedSqlite,
  openRegistry,
  openTenant,
  registryFile,
  setDataKey,
  tenantDbKeyInfo,
  tenantFile,
  VaultLockedError,
  withDataKey,
} from "../src/tenant-store.ts";
import { TEST_DATA_KEY, type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("vault-store");
});
afterEach(() => tmp.cleanup());

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const dk = (byte: number) => Buffer.alloc(32, byte);

/** データ場所の全ファイル（-wal・-shm を含む） */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(path));
    else out.push(path);
  }
  return out;
}

describe("DB の鍵の導出（D1）", () => {
  it("HKDF-SHA256(DK, salt=空, info) の 32 バイト。info は registry と事業体（小文字）で別", () => {
    const key = dk(7);
    const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(DB_KEY_INFO_REGISTRY).toBe("trebuchet/db/registry/v1");
    expect(tenantDbKeyInfo(id.toUpperCase())).toBe(`trebuchet/db/tenant:${id}/v1`);
    const expected = Buffer.from(
      hkdfSync("sha256", key, Buffer.alloc(0), "trebuchet/db/registry/v1", 32),
    );
    expect(deriveDbKey(key, "registry").equals(expected)).toBe(true);
    expect(deriveDbKey(key, { tenant: id })).toHaveLength(32);
    expect(
      deriveDbKey(key, { tenant: id }).equals(deriveDbKey(key, { tenant: id.toUpperCase() })),
    ).toBe(true);
  });

  it("性質: 同じ DK と対象なら同じ鍵、DK か対象が違えば違う鍵（registry と事業体、事業体どうし）", () => {
    const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
    fc.assert(
      fc.property(bytes32, bytes32, fc.uuid(), fc.uuid(), (a, b, idA, idB) => {
        const ka = Buffer.from(a);
        const kb = Buffer.from(b);
        expect(deriveDbKey(ka, "registry").equals(deriveDbKey(Buffer.from(a), "registry"))).toBe(
          true,
        );
        expect(deriveDbKey(ka, "registry").equals(deriveDbKey(ka, { tenant: idA }))).toBe(false);
        if (idA.toLowerCase() !== idB.toLowerCase()) {
          expect(deriveDbKey(ka, { tenant: idA }).equals(deriveDbKey(ka, { tenant: idB }))).toBe(
            false,
          );
        }
        if (!ka.equals(kb)) {
          expect(deriveDbKey(ka, "registry").equals(deriveDbKey(kb, "registry"))).toBe(false);
          expect(deriveDbKey(ka, { tenant: idA }).equals(deriveDbKey(kb, { tenant: idA }))).toBe(
            false,
          );
        }
      }),
    );
  });

  it("DK は 32 バイトだけを受け付ける", () => {
    expect(() => setDataKey(Buffer.alloc(16))).toThrow();
    expect(() => setDataKey(Buffer.alloc(33))).toThrow();
  });
});

describe("施錠中（DK なし。INV-51）", () => {
  it("openRegistry・openTenant は VaultLockedError を投げ、ファイルを作らない", () => {
    clearDataKey();
    const id = randomUUIDv7();
    expect(() => openRegistry()).toThrow(VaultLockedError);
    expect(() => openTenant(id)).toThrow(VaultLockedError);
    expect(existsSync(registryFile())).toBe(false);
    expect(existsSync(tenantFile(id))).toBe(false);
  });

  it("openAuth は施錠中でも開ける（暗号化しない）", () => {
    clearDataKey();
    const db = openAuth();
    expect(db.$client.prepare("SELECT count(*) AS n FROM passkeys").get()).toEqual({ n: 0 });
    db.$client.close();
    expect(readFileSync(authFile()).subarray(0, 16).equals(SQLITE_HEADER)).toBe(true);
  });

  it("clearDataKey は registry と事業体のハンドルを閉じ、auth は閉じず、渡した DK を 0 で埋める", () => {
    clearDataKey();
    const key = dk(9);
    setDataKey(key);
    const registry = openRegistry();
    const tenant = openTenant(randomUUIDv7());
    const auth = openAuth();
    clearDataKey();
    expect(registry.$client.open).toBe(false);
    expect(tenant.$client.open).toBe(false);
    expect(auth.$client.open).toBe(true);
    expect(key.every((b) => b === 0)).toBe(true);
    expect(() => openRegistry()).toThrow(VaultLockedError);
  });

  it("解錠し直せば同じ DK で前の内容が読める", () => {
    openRegistry()
      .insert(registrySchema.entities)
      .values({
        id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        name: "事業",
        kind: "individual",
        dbFile: "x.sqlite",
        createdAt: "2026-10-30T00:00:00.000Z",
      })
      .run();
    clearDataKey();
    setDataKey(Buffer.from(TEST_DATA_KEY));
    expect(openRegistry().select().from(registrySchema.entities).all()).toHaveLength(1);
  });

  it("withDataKey は解錠中の DK を渡して結果を返し、施錠中は VaultLockedError（fn を呼ばない）", () => {
    expect(withDataKey((k) => Buffer.from(k).equals(Buffer.from(TEST_DATA_KEY)))).toBe(true);
    clearDataKey();
    let called = false;
    expect(() =>
      withDataKey(() => {
        called = true;
      }),
    ).toThrow(VaultLockedError);
    expect(called).toBe(false);
  });
});

describe("誤った鍵", () => {
  it("SQLITE_NOTADB で失敗し、空の DB として扱わず、ファイルを書き換えない", () => {
    const id = randomUUIDv7();
    openRegistry();
    openTenant(id);
    closeAll();
    clearDataKey();
    const before = {
      registry: readFileSync(registryFile()),
      tenant: readFileSync(tenantFile(id)),
    };
    setDataKey(dk(1));
    expect(() => openRegistry()).toThrow(expect.objectContaining({ code: "SQLITE_NOTADB" }));
    expect(() => openTenant(id)).toThrow(expect.objectContaining({ code: "SQLITE_NOTADB" }));
    expect(readFileSync(registryFile()).equals(before.registry)).toBe(true);
    expect(readFileSync(tenantFile(id)).equals(before.tenant)).toBe(true);
    // 正しい鍵に戻せば開ける（失敗したハンドルを残していない）
    clearDataKey();
    setDataKey(Buffer.from(TEST_DATA_KEY));
    expect(openRegistry().$client.open).toBe(true);
  });

  it("別の事業体の鍵・registry の鍵では開けない（ファイルごとに鍵が違う）", () => {
    const a = randomUUIDv7();
    openTenant(a);
    closeAll();
    expect(statSync(tenantFile(a)).size).toBeGreaterThan(0);
    expect(() => openEncryptedSqlite(tenantFile(a), { tenant: randomUUIDv7() })).toThrow(
      expect.objectContaining({ code: "SQLITE_NOTADB" }),
    );
    expect(() => openEncryptedSqlite(tenantFile(a), "registry")).toThrow(
      expect.objectContaining({ code: "SQLITE_NOTADB" }),
    );
    const ok = openEncryptedSqlite(tenantFile(a), { tenant: a.toUpperCase() });
    expect(ok.prepare("SELECT count(*) AS n FROM tax_rates").get()).toEqual({ n: 4 });
    ok.close();
  });

  it("openEncryptedSqlite も施錠中は VaultLockedError", () => {
    clearDataKey();
    expect(() => openEncryptedSqlite(registryFile(), "registry")).toThrow(VaultLockedError);
  });
});

describe("平文が残らない（INV-51）", () => {
  it("registry と事業体の DB・WAL に書いた値がファイルに平文で現れない", () => {
    const marker = `PLAINTEXT-MARKER-${randomUUIDv7()}`;
    const id = randomUUIDv7();
    openRegistry()
      .insert(registrySchema.entities)
      .values({
        id,
        name: marker,
        kind: "individual",
        dbFile: `${id}.sqlite`,
        createdAt: "2026-10-30T00:00:00.000Z",
      })
      .run();
    openTenant(id)
      .$client.prepare(
        "INSERT INTO audit_log (id, occurred_at, target_type, target_id, action, reason, before_json, after_json) VALUES (?, ?, 'journal', 'x', 'create', NULL, NULL, ?)",
      )
      .run(randomUUIDv7(), "2026-10-30T00:00:00.000Z", JSON.stringify({ memo: marker }));
    const check = () => {
      for (const file of allFiles(tmp.dir)) {
        if (file === authFile()) continue;
        const bytes = readFileSync(file);
        expect(bytes.includes(Buffer.from(marker)), file).toBe(false);
        if (file.endsWith(".sqlite"))
          expect(bytes.subarray(0, 16).equals(SQLITE_HEADER), file).toBe(false);
      }
    };
    check(); // WAL に残っている間
    closeAll();
    check(); // チェックポイントの後
  });
});
