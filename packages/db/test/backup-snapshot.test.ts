import { randomUUIDv7 } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentAppVersion,
  removeStaleSnapshots,
  snapshotDataDir,
} from "../src/backup/snapshot.ts";
import { closeAll } from "../src/tenant-store.ts";
import { type TempDataDir, TMP_ROOT, useTempDataDir } from "../src/testing.ts";
import { seedEntities } from "./backup-fixtures.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("backup-snapshot");
});
afterEach(() => tmp.cleanup());

describe("snapshotDataDir", () => {
  it("registry と事業体の DB の写しとマニフェストを返し、写しは tmpDir の下にだけ作る", () => {
    const [e] = seedEntities([
      { name: "事業", kind: "individual", seed: 3, journals: 2, memo: "", note: "" },
    ]);
    const snapDir = join(TMP_ROOT, `backup-snapshot-${randomUUIDv7()}`);
    try {
      const snap = snapshotDataDir(tmp.dir, snapDir);
      expect(snap.files.map((f) => f.path).sort()).toEqual(
        ["registry.sqlite", `tenants/${e?.id}.sqlite`].sort(),
      );
      for (const f of snap.files) {
        expect(f.bytes.subarray(0, 15).toString()).toBe("SQLite format 3");
        expect(existsSync(join(snapDir, f.path))).toBe(true);
      }
      expect(snap.manifest.entities).toEqual([
        { id: e?.id, name: "事業", fiscalYears: [{ year: 2026, journals: 2 }] },
      ]);
    } finally {
      rmSync(snapDir, { recursive: true, force: true });
    }
    expect(existsSync(snapDir)).toBe(false);
  });

  it("途中で失敗すると例外を投げ、呼び出し側の finally で tmpDir が消える", () => {
    const [e] = seedEntities([
      { name: "事業", kind: "individual", seed: 3, journals: 1, memo: "", note: "" },
    ]);
    // 事業体の DB を壊す（SQLite のファイルではない中身）
    closeAll();
    writeFileSync(join(tmp.dir, "tenants", `${e?.id}.sqlite`), "this is not sqlite".repeat(500));
    rmSync(join(tmp.dir, "tenants", `${e?.id}.sqlite-wal`), { force: true });
    rmSync(join(tmp.dir, "tenants", `${e?.id}.sqlite-shm`), { force: true });
    const snapDir = join(TMP_ROOT, `backup-snapshot-${randomUUIDv7()}`);
    try {
      expect(() => snapshotDataDir(tmp.dir, snapDir)).toThrow();
    } finally {
      rmSync(snapDir, { recursive: true, force: true });
    }
    expect(existsSync(snapDir)).toBe(false);
  });

  it("registry がなければ失敗する", () => {
    const snapDir = join(TMP_ROOT, `backup-snapshot-${randomUUIDv7()}`);
    try {
      expect(() => snapshotDataDir(tmp.dir, snapDir)).toThrow();
    } finally {
      rmSync(snapDir, { recursive: true, force: true });
    }
  });
});

describe("currentAppVersion", () => {
  it("registry と tenant のマイグレーションの適用数（1 以上の整数）", () => {
    const v = currentAppVersion();
    expect(Number.isInteger(v.registry) && v.registry >= 1).toBe(true);
    expect(Number.isInteger(v.tenant) && v.tenant >= 5).toBe(true);
  });
});

describe("removeStaleSnapshots", () => {
  it("backup-snapshot-* のフォルダだけを消す", () => {
    const root = join(TMP_ROOT, `backup-stale-${randomUUIDv7()}`);
    try {
      mkdirSync(join(root, "backup-snapshot-aaa", "tenants"), { recursive: true });
      writeFileSync(join(root, "backup-snapshot-aaa", "registry.sqlite"), "x");
      mkdirSync(join(root, "backup-snapshot-bbb"), { recursive: true });
      mkdirSync(join(root, "other-dir"), { recursive: true });
      writeFileSync(join(root, "backup-snapshot-file"), "x");
      expect(removeStaleSnapshots(root)).toBe(2);
      expect(existsSync(join(root, "backup-snapshot-aaa"))).toBe(false);
      expect(existsSync(join(root, "backup-snapshot-bbb"))).toBe(false);
      expect(existsSync(join(root, "other-dir"))).toBe(true);
      expect(existsSync(join(root, "backup-snapshot-file"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("フォルダがなければ 0", () => {
    expect(removeStaleSnapshots(join(TMP_ROOT, `nope-${randomUUIDv7()}`))).toBe(0);
  });
});
