import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fc } from "@trebuchet/domain/testing";
import { describe, expect, it } from "vitest";
import { decryptBackup, encryptBackup, readBackupRelease } from "../src/backup/crypto.ts";
import { currentRelease } from "../src/backup/snapshot.ts";
import { recoveryFixture } from "./backup-fixtures.ts";

// リリースの版（ルートの package.json の version）をヘッダーの任意の項目 release に書く。
// 版の受け入れの判定はマイグレーションの数のまま（ADR 0016）。release は拒否の文言に使うだけ

const VERSION = { registry: 3, tenant: 5 };
const dk = randomBytes(32);
const recovery = recoveryFixture(dk);
const archive = Buffer.from("archive");
const base = {
  macId: "mac-0001",
  createdAt: "2026-11-17T09:00:00.000Z",
  appVersion: VERSION,
  recoveryWrap: recovery.wrap,
};

const ROOT_PACKAGE = fileURLToPath(new URL("../../../package.json", import.meta.url));

/** ヘッダーの JSON を書き換えた（長さも直した）ファイル。暗号文とタグはそのまま */
function rewriteHeader(file: Buffer, edit: (h: Record<string, unknown>) => void): Buffer {
  const len = file.readUInt32BE(4);
  const h = JSON.parse(file.subarray(8, 8 + len).toString("utf8"));
  edit(h);
  const json = Buffer.from(JSON.stringify(h), "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(json.length);
  return Buffer.concat([file.subarray(0, 4), lenBuf, json, file.subarray(8 + len)]);
}

function headerOf(file: Buffer): Record<string, unknown> {
  const len = file.readUInt32BE(4);
  return JSON.parse(file.subarray(8, 8 + len).toString("utf8"));
}

describe("アプリのリリースの版", () => {
  it("currentRelease はルートの package.json の version（x.y.z）", () => {
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE, "utf8")) as { version?: unknown };
    expect(currentRelease()).toBe(pkg.version);
    expect(currentRelease()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe(".tbk のヘッダーの release", () => {
  it("既定で今のリリースの版を書き、復号したヘッダーに返す", () => {
    const file = encryptBackup(archive, dk, base);
    expect(headerOf(file).release).toBe(currentRelease());
    const r = decryptBackup(file, dk, VERSION);
    expect(r.ok && r.value.header.release).toBe(currentRelease());
  });

  it("release のないファイル（以前のバックアップ）も読め、ヘッダーの release は undefined", () => {
    const file = encryptBackup(archive, dk, { ...base, release: null });
    expect("release" in headerOf(file)).toBe(false);
    const r = decryptBackup(file, dk, VERSION);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.header.release).toBeUndefined();
      expect(r.value.archive).toEqual(archive);
    }
    expect(readBackupRelease(file)).toBeUndefined();
  });

  it("release は AAD に含まれ、書き換えると INVALID（改ざんの検知）", () => {
    const file = encryptBackup(archive, dk, { ...base, release: "0.1.0" });
    const forged = rewriteHeader(file, (h) => {
      h.release = "9.9.9";
    });
    expect(decryptBackup(forged, dk, VERSION)).toEqual({ ok: false, error: "INVALID" });
    const removed = rewriteHeader(file, (h) => {
      delete h.release;
    });
    expect(decryptBackup(removed, dk, VERSION)).toEqual({ ok: false, error: "INVALID" });
  });

  it.each([
    ["数値", 1],
    ["空", ""],
    ["版の形でない", "../../etc"],
    ["長すぎる", `1.0.0-${"a".repeat(64)}`],
  ])("release の形が違う（%s）ヘッダーは INVALID", (_name, value) => {
    const file = encryptBackup(archive, dk, base);
    const bad = rewriteHeader(file, (h) => {
      h.release = value;
    });
    expect(decryptBackup(bad, dk, VERSION)).toEqual({ ok: false, error: "INVALID" });
    expect(readBackupRelease(bad)).toBeUndefined();
  });

  it("readBackupRelease は復号せずにヘッダーの release を読む（新しい形式の版のファイルでも）", () => {
    const file = encryptBackup(archive, dk, { ...base, release: "1.2.3" });
    expect(readBackupRelease(file)).toBe("1.2.3");
    const format2 = rewriteHeader(file, (h) => {
      h.format = 2;
    });
    expect(readBackupRelease(format2)).toBe("1.2.3");
  });

  it("readBackupRelease は壊れた入力で例外を出さず undefined（性質）", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect(readBackupRelease(bytes)).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });

  it("新しい版のファイルの拒否でも、ヘッダーの release は読める", () => {
    const file = encryptBackup(archive, dk, {
      ...base,
      appVersion: { registry: VERSION.registry + 1, tenant: VERSION.tenant },
      release: "0.2.0",
    });
    expect(decryptBackup(file, dk, VERSION)).toEqual({ ok: false, error: "VERSION_MISMATCH" });
    expect(readBackupRelease(file)).toBe("0.2.0");
  });
});
