import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isArchivePath, packArchive, unpackArchive } from "../src/backup/archive.ts";
import type { Snapshot } from "../src/backup/types.ts";
import { sha256Hex } from "../src/util.ts";

const ID = "0192f3a0-0000-7000-8000-000000000001";

function snapshot(extra: { path: string; bytes: Buffer }[] = []): Snapshot {
  const files = [
    { path: "registry.sqlite", bytes: Buffer.from("registry-bytes") },
    { path: `tenants/${ID}.sqlite`, bytes: Buffer.from("tenant-bytes!") },
    ...extra,
  ];
  return {
    files,
    manifest: {
      files: [],
      entities: [{ id: ID, name: "事業", fiscalYears: [{ year: 2026, journals: 2 }] }],
    },
  };
}

/** マニフェストを書き換えたアーカイブを作る */
function withManifest(
  archive: Buffer,
  edit: (m: { files: { path: string; size: number; sha256: string }[] }) => void,
): Buffer {
  const len = archive.readUInt32BE(0);
  const m = JSON.parse(archive.subarray(4, 4 + len).toString("utf8"));
  edit(m);
  const json = Buffer.from(JSON.stringify(m), "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(json.length);
  return Buffer.concat([lenBuf, json, archive.subarray(4 + len)]);
}

describe("アーカイブ", () => {
  it("往復する。マニフェストには各ファイルの長さと SHA-256 が入る", () => {
    const archive = packArchive(snapshot());
    const r = unpackArchive(archive);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.files.map((f) => [f.path, f.bytes.toString()])).toEqual([
      ["registry.sqlite", "registry-bytes"],
      [`tenants/${ID}.sqlite`, "tenant-bytes!"],
    ]);
    expect(r.value.manifest.files[0]).toEqual({
      path: "registry.sqlite",
      size: 14,
      sha256: createHash("sha256").update("registry-bytes").digest("hex"),
    });
    expect(r.value.manifest.entities).toEqual(snapshot().manifest.entities);
  });

  it("content_sha256 はアーカイブの平文の SHA-256", () => {
    const archive = packArchive(snapshot());
    expect(sha256Hex(archive)).toBe(createHash("sha256").update(archive).digest("hex"));
  });

  it("マニフェストのハッシュが合わないものは拒否する", () => {
    const archive = withManifest(packArchive(snapshot()), (m) => {
      const f = m.files[0];
      if (f) f.sha256 = "0".repeat(64);
    });
    expect(unpackArchive(archive)).toEqual({ ok: false, error: "INVALID" });
  });

  it("長さが合わないもの・内容を 1 バイト変えたもの・切り詰めは拒否する", () => {
    const archive = packArchive(snapshot());
    const sized = withManifest(archive, (m) => {
      const f = m.files[0];
      if (f) f.size += 1;
    });
    expect(unpackArchive(sized).ok).toBe(false);
    const flipped = Buffer.from(archive);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(unpackArchive(flipped).ok).toBe(false);
    expect(unpackArchive(archive.subarray(0, archive.length - 1)).ok).toBe(false);
    expect(unpackArchive(Buffer.alloc(0)).ok).toBe(false);
    expect(unpackArchive(Buffer.concat([archive, Buffer.from([0])])).ok).toBe(false);
  });

  it.each([
    "../evil.sqlite",
    "tenants/../../evil.sqlite",
    "/etc/passwd",
    "tenants/not-a-uuid.sqlite",
    `tenants/${ID}.sqlite/../x`,
    `tenants/${ID}.sqlite.bak`,
    "registry.sqlite/x",
    "other.sqlite",
    "tenants\\x.sqlite",
  ])("パスが %s のものは拒否する（パス・トラバーサルの防止）", (path) => {
    const archive = packArchive(snapshot([{ path, bytes: Buffer.from("x") }]));
    expect(unpackArchive(archive)).toEqual({ ok: false, error: "INVALID" });
  });

  it("isArchivePath は registry.sqlite と tenants/<UUID>.sqlite を大文字小文字によらず許す", () => {
    expect(isArchivePath("registry.sqlite")).toBe(true);
    expect(isArchivePath("REGISTRY.SQLITE")).toBe(true);
    expect(isArchivePath(`tenants/${ID}.sqlite`)).toBe(true);
    expect(isArchivePath(`TENANTS/${ID.toUpperCase()}.sqlite`)).toBe(true);
    expect(isArchivePath(`tenants/${ID}.sqlite.bak`)).toBe(false);
    expect(isArchivePath("tenants/x.sqlite")).toBe(false);
  });

  it("同じパスが 2 度あるもの、registry.sqlite がないものは拒否する", () => {
    const dup = snapshot([{ path: "registry.sqlite", bytes: Buffer.from("again") }]);
    expect(unpackArchive(packArchive(dup)).ok).toBe(false);
    const noRegistry = snapshot();
    noRegistry.files.shift();
    expect(unpackArchive(packArchive(noRegistry)).ok).toBe(false);
  });
});
