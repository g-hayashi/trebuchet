import { createHash } from "node:crypto";
import { fc } from "@trebuchet/domain/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { type DeriveKey, decryptBackup, encryptBackup } from "../src/backup/crypto.ts";

/** テスト専用の軽い鍵の導出（本番の経路は Argon2id で固定。引数で差し替えるのはテストだけ） */
const fastDerive: DeriveKey = async (passphrase, kdf) =>
  createHash("sha256").update(passphrase).update(kdf.salt).digest();

const VERSION = { registry: 3, tenant: 5 };
const PASS = "correct horse battery staple";
const header = { appVersion: VERSION, macId: "mac-0001", createdAt: "2026-10-31T09:00:00.000Z" };

let file: Buffer;
let headerEnd: number;
const archive = Buffer.from("アーカイブの平文 ".repeat(50));

beforeAll(async () => {
  file = await encryptBackup(archive, PASS, header, { deriveKey: fastDerive });
  headerEnd = 8 + file.readUInt32BE(4);
});

const attempt = (bytes: Buffer, pass = PASS) =>
  decryptBackup(bytes, pass, VERSION, { deriveKey: fastDerive });

describe("INV-26: 改ざん・切り詰め・誤ったパスフレーズは必ず失敗する", () => {
  it("正しいファイルは復号できる（対照）", async () => {
    const r = await attempt(file);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.archive.equals(archive)).toBe(true);
  });

  it("任意の 1 バイトの変更（ヘッダー・暗号文・タグのどこでも）は失敗し、平文を返さない", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 1_000_000 }).map((n) => n % file.length),
        fc.integer({ min: 1, max: 255 }),
        async (index, mask) => {
          const mutated = Buffer.from(file);
          mutated[index] = (mutated[index] ?? 0) ^ mask;
          const r = await attempt(mutated);
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

  it("任意の位置での切り詰め（長さ 0 を含む）は失敗する", async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 1_000_000 }), async (n) => {
        const r = await attempt(file.subarray(0, n % file.length));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe("INVALID");
      }),
      { numRuns: 200 },
    );
    expect((await attempt(Buffer.alloc(0))).ok).toBe(false);
  });

  it("末尾に余分なバイトを足したファイルは失敗する", async () => {
    const r = await attempt(Buffer.concat([file, Buffer.from([0])]));
    expect(r.ok).toBe(false);
  });

  it("異なるパスフレーズは失敗し、INVALID（原因を区別しない）", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => s.normalize("NFC") !== PASS),
        async (pass) => {
          const r = await attempt(file, pass);
          expect(r).toEqual({ ok: false, error: "INVALID" });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("本番の鍵の導出（Argon2id）でも、誤ったパスフレーズと 1 バイトの変更は失敗する", async () => {
    const real = await encryptBackup(archive, PASS, header);
    expect((await decryptBackup(real, PASS, VERSION)).ok).toBe(true);
    expect(await decryptBackup(real, `${PASS}x`, VERSION)).toEqual({ ok: false, error: "INVALID" });
    const mutated = Buffer.from(real);
    mutated[real.length - 20] = (mutated[real.length - 20] ?? 0) ^ 1;
    expect(await decryptBackup(mutated, PASS, VERSION)).toEqual({ ok: false, error: "INVALID" });
  });
});
