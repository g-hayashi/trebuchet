import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptBackup, encryptBackup, readBackupHeader } from "../src/backup/crypto.ts";
import { recoveryFixture } from "./backup-fixtures.ts";

const NOW = { registry: 3, tenant: 5 };
const dk = randomBytes(32);
const recovery = recoveryFixture(dk);
const base = { macId: "mac-0001", createdAt: "2026-10-31T09:00:00.000Z" };
const archive = Buffer.from("archive");

const make = (appVersion: { registry: number; tenant: number }) =>
  encryptBackup(archive, dk, { ...base, appVersion, recoveryWrap: recovery.wrap });
const open = (bytes: Buffer, key: Uint8Array = dk, version = NOW) =>
  decryptBackup(bytes, key, version);

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
  beforeAll(() => {
    same = make(NOW);
  });

  it("一致していれば成功し、ヘッダーに鍵の導出（HKDF の salt）・recovery の包み・cipher の値が入る", () => {
    const r = open(same);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const { header } = r.value;
      expect(header.format).toBe(1);
      expect(header.appVersion).toEqual(NOW);
      expect(header.key.alg).toBe("hkdf-sha256");
      expect(Buffer.from(header.key.salt, "base64")).toHaveLength(16);
      expect(header.cipher.alg).toBe("aes-256-gcm");
      expect(Buffer.from(header.cipher.nonce, "base64")).toHaveLength(12);
      expect(header.macId).toBe("mac-0001");
      const wrap = header.recovery;
      expect(Buffer.from(wrap.salt, "base64")).toHaveLength(32);
      expect(Buffer.from(wrap.iv, "base64")).toHaveLength(12);
      expect(Buffer.from(wrap.tag, "base64")).toHaveLength(16);
      expect(Buffer.from(wrap.wrapped, "base64")).toEqual(Buffer.from(recovery.wrap.wrapped));
    }
  });

  it("ヘッダーに DK・パスフレーズ・鍵の値が出ない", () => {
    const text = same.toString("latin1");
    expect(text).not.toContain(dk.toString("base64"));
    expect(text).not.toContain(dk.toString("hex"));
    expect(text).not.toContain(recovery.text);
  });

  it.each([
    ["registry が多い", { registry: 4, tenant: 5 }],
    ["registry が少ない", { registry: 2, tenant: 5 }],
    ["tenant が多い", { registry: 3, tenant: 6 }],
    ["tenant が少ない", { registry: 3, tenant: 4 }],
  ])("%s ファイルは VERSION_MISMATCH", (_name, v) => {
    expect(open(make(v))).toEqual({ ok: false, error: "VERSION_MISMATCH" });
  });

  it("版が違っていて誤った鍵なら INVALID（版の違いを教えない）", () => {
    const file = make({ registry: 4, tenant: 5 });
    expect(open(file, randomBytes(32))).toEqual({ ok: false, error: "INVALID" });
  });

  it("format が 2 のファイルは、復号の前に VERSION_MISMATCH（誤った鍵でも）", () => {
    const file = rewriteHeader(same, (h) => {
      h.format = 2;
    });
    expect(open(file)).toEqual({ ok: false, error: "VERSION_MISMATCH" });
    expect(open(file, randomBytes(32))).toEqual({ ok: false, error: "VERSION_MISMATCH" });
    expect(readBackupHeader(file)).toEqual({ ok: false, error: "VERSION_MISMATCH" });
  });

  it("鍵・包みの形が違うヘッダーは、鍵を導出せずに INVALID", () => {
    const edits: ((h: Record<string, unknown>) => void)[] = [
      (h) => {
        (h.key as Record<string, unknown>).alg = "argon2id";
      },
      (h) => {
        (h.key as Record<string, unknown>).salt = Buffer.alloc(8).toString("base64");
      },
      (h) => {
        (h.recovery as Record<string, unknown>).salt = Buffer.alloc(16).toString("base64");
      },
      (h) => {
        (h.recovery as Record<string, unknown>).wrapped = Buffer.alloc(31).toString("base64");
      },
      (h) => {
        delete h.recovery;
      },
      (h) => {
        h.kdf = h.key;
        delete h.key;
      },
    ];
    for (const edit of edits) {
      const file = rewriteHeader(same, edit);
      expect(open(file)).toEqual({ ok: false, error: "INVALID" });
      expect(readBackupHeader(file)).toEqual({ ok: false, error: "INVALID" });
    }
  });

  it("readBackupHeader は認証せずにヘッダーと recovery の包みを返す", () => {
    const r = readBackupHeader(same);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.header.macId).toBe("mac-0001");
      expect(Buffer.from(r.value.recoveryWrap.wrapped)).toEqual(Buffer.from(recovery.wrap.wrapped));
      expect(Buffer.from(r.value.recoveryWrap.salt)).toEqual(Buffer.from(recovery.wrap.salt));
    }
  });
});
