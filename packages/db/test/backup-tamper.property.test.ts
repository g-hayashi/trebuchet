import { randomBytes } from "node:crypto";
import { fc } from "@trebuchet/domain/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptBackup, encryptBackup } from "../src/backup/crypto.ts";
import { recoveryFixture } from "./backup-fixtures.ts";

const VERSION = { registry: 3, tenant: 5 };
const dk = randomBytes(32);
const header = {
  appVersion: VERSION,
  macId: "mac-0001",
  createdAt: "2026-10-31T09:00:00.000Z",
  recoveryWrap: recoveryFixture(dk).wrap,
};

let file: Buffer;
let headerEnd: number;
const archive = Buffer.from("アーカイブの平文 ".repeat(50));

beforeAll(() => {
  file = encryptBackup(archive, dk, header);
  headerEnd = 8 + file.readUInt32BE(4);
});

const attempt = (bytes: Buffer, key: Uint8Array = dk) => decryptBackup(bytes, key, VERSION);

describe("INV-26: 改ざん・切り詰め・誤った鍵は必ず失敗する", () => {
  it("正しいファイルは復号できる（対照）", () => {
    const r = attempt(file);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.archive.equals(archive)).toBe(true);
  });

  it("任意の 1 バイトの変更（ヘッダー・暗号文・タグのどこでも）は失敗し、平文を返さない", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }).map((n) => n % file.length),
        fc.integer({ min: 1, max: 255 }),
        (index, mask) => {
          const mutated = Buffer.from(file);
          mutated[index] = (mutated[index] ?? 0) ^ mask;
          const r = attempt(mutated);
          expect(r.ok).toBe(false);
          if (!r.ok) {
            if (index >= headerEnd) expect(r.error).toBe("INVALID");
            else expect(["INVALID", "VERSION_MISMATCH"]).toContain(r.error);
          }
          expect(JSON.stringify(r)).not.toContain("アーカイブ");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("任意の位置での切り詰め（長さ 0 を含む）は失敗する", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), (n) => {
        const r = attempt(file.subarray(0, n % file.length));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe("INVALID");
      }),
      { numRuns: 200 },
    );
    expect(attempt(Buffer.alloc(0)).ok).toBe(false);
  });

  it("末尾に余分なバイトを足したファイルは失敗する", () => {
    expect(attempt(Buffer.concat([file, Buffer.from([0])])).ok).toBe(false);
  });

  it("異なる鍵（DK）は失敗し、INVALID（原因を区別しない）", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (other) => {
        fc.pre(!Buffer.from(other).equals(dk));
        expect(attempt(file, other)).toEqual({ ok: false, error: "INVALID" });
      }),
      { numRuns: 100 },
    );
  });

  it("鍵の長さが違えば例外ではなく INVALID", () => {
    expect(attempt(file, Buffer.alloc(16))).toEqual({ ok: false, error: "INVALID" });
  });
});
