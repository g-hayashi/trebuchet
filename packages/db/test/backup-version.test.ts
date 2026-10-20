import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { type DeriveKey, decryptBackup, encryptBackup } from "../src/backup/crypto.ts";

const fastDerive: DeriveKey = async (passphrase, kdf) =>
  createHash("sha256").update(passphrase).update(kdf.salt).digest();

const NOW = { registry: 3, tenant: 5 };
const PASS = "correct horse battery staple";
const base = { macId: "mac-0001", createdAt: "2026-10-31T09:00:00.000Z" };
const archive = Buffer.from("archive");

const make = (appVersion: { registry: number; tenant: number }) =>
  encryptBackup(archive, PASS, { ...base, appVersion }, { deriveKey: fastDerive });
const open = (bytes: Buffer, pass: string, version = NOW) =>
  decryptBackup(bytes, pass, version, { deriveKey: fastDerive });

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

describe("版の完全一致", () => {
  let same: Buffer;
  beforeAll(async () => {
    same = await make(NOW);
  });

  it("一致していれば成功し、ヘッダーに kdf と cipher の値が入る", async () => {
    const r = await open(same, PASS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.header.format).toBe(1);
      expect(r.value.header.appVersion).toEqual(NOW);
      expect(r.value.header.kdf).toMatchObject({
        alg: "argon2id",
        memory: 65536,
        passes: 3,
        parallelism: 1,
      });
      expect(Buffer.from(r.value.header.kdf.salt, "base64")).toHaveLength(16);
      expect(r.value.header.cipher.alg).toBe("aes-256-gcm");
      expect(Buffer.from(r.value.header.cipher.nonce, "base64")).toHaveLength(12);
      expect(r.value.header.macId).toBe("mac-0001");
    }
  });

  it.each([
    ["registry が多い", { registry: 4, tenant: 5 }],
    ["registry が少ない", { registry: 2, tenant: 5 }],
    ["tenant が多い", { registry: 3, tenant: 6 }],
    ["tenant が少ない", { registry: 3, tenant: 4 }],
  ])("%s ファイルは VERSION_MISMATCH", async (_name, v) => {
    const file = await make(v);
    expect(await open(file, PASS)).toEqual({ ok: false, error: "VERSION_MISMATCH" });
  });

  it("版が違っていて誤ったパスフレーズなら INVALID（版の違いを教えない）", async () => {
    const file = await make({ registry: 4, tenant: 5 });
    expect(await open(file, "wrong passphrase")).toEqual({ ok: false, error: "INVALID" });
  });

  it("format が 2 のファイルは、復号の前に VERSION_MISMATCH（誤ったパスフレーズでも）", async () => {
    const file = rewriteHeader(same, (h) => {
      h.format = 2;
    });
    expect(await open(file, PASS)).toEqual({ ok: false, error: "VERSION_MISMATCH" });
    expect(await open(file, "wrong passphrase")).toEqual({ ok: false, error: "VERSION_MISMATCH" });
  });

  it("kdf の値が上限を超えるヘッダーは、鍵を導出せずに INVALID", async () => {
    let called = 0;
    const counting: DeriveKey = async (p, k) => {
      called++;
      return fastDerive(p, k);
    };
    for (const edit of [
      (k: Record<string, unknown>) => {
        k.memory = 4_194_304;
      },
      (k: Record<string, unknown>) => {
        k.passes = 1000;
      },
      (k: Record<string, unknown>) => {
        k.parallelism = 64;
      },
      (k: Record<string, unknown>) => {
        k.memory = 0;
      },
      (k: Record<string, unknown>) => {
        k.alg = "argon2d";
      },
    ]) {
      const file = rewriteHeader(same, (h) => edit(h.kdf as Record<string, unknown>));
      expect(await decryptBackup(file, PASS, NOW, { deriveKey: counting })).toEqual({
        ok: false,
        error: "INVALID",
      });
    }
    expect(called).toBe(0);
  });
});
