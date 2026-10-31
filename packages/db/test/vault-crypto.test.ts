import { randomBytes } from "node:crypto";
import { fc } from "@trebuchet/domain/testing";
import { describe, expect, it } from "vitest";
import {
  DK_BYTES,
  deriveKek,
  unwrapDataKey,
  type WrapKind,
  wrapDataKey,
} from "../src/vault-crypto.ts";

// 008 の D1: DK の包み（AES-256-GCM、KEK = HKDF-SHA256(ikm, salt, "trebuchet/dk-wrap/v1")）。INV-52

const flipBit = (buf: Uint8Array, bit: number): Buffer => {
  const copy = Buffer.from(buf);
  const i = Math.floor(bit / 8) % copy.length;
  copy[i] = (copy[i] ?? 0) ^ (1 << (bit % 8));
  return copy;
};

const eq = (a: Uint8Array | null, b: Uint8Array) => a !== null && Buffer.from(a).equals(b);

describe("包む・開く（D1）", () => {
  it("正しい ikm で開くと同じ DK。包んだ値は DK そのものではない", () => {
    const dk = randomBytes(DK_BYTES);
    const ikm = randomBytes(32);
    const wrap = wrapDataKey(dk, ikm, "passkey", "cred-1");
    expect(eq(unwrapDataKey(wrap, ikm, "passkey", "cred-1"), dk)).toBe(true);
    expect(Buffer.from(wrap.wrapped).equals(dk)).toBe(false);
    expect([wrap.salt.length, wrap.iv.length, wrap.tag.length, wrap.wrapped.length]).toEqual([
      32, 12, 16, 32,
    ]);
  });

  it("別の ikm では開けない（null）", () => {
    const wrap = wrapDataKey(randomBytes(32), randomBytes(32), "passkey", "cred-1");
    expect(unwrapDataKey(wrap, randomBytes(32), "passkey", "cred-1")).toBeNull();
  });

  it("AAD が kind と credential_id に結びつく（行を別の資格情報・種類に移すと開けない）", () => {
    const rk = randomBytes(20);
    const recovery = wrapDataKey(randomBytes(32), rk, "recovery", null);
    expect(unwrapDataKey(recovery, rk, "recovery", null)).not.toBeNull();
    const pk = randomBytes(32);
    const passkey = wrapDataKey(randomBytes(32), pk, "passkey", "cred-a");
    expect(unwrapDataKey(passkey, pk, "passkey", "cred-b")).toBeNull();
    expect(unwrapDataKey(passkey, pk, "recovery", null)).toBeNull();
  });

  it("形の誤った入力では包まない（例外）、開くときは null", () => {
    expect(() => wrapDataKey(randomBytes(16), randomBytes(32), "passkey", "c")).toThrow();
    expect(() => wrapDataKey(randomBytes(32), randomBytes(8), "passkey", "c")).toThrow();
    expect(() => wrapDataKey(randomBytes(32), randomBytes(32), "passkey", null)).toThrow();
    expect(() => wrapDataKey(randomBytes(32), randomBytes(20), "recovery", "c")).toThrow();
    expect(() => wrapDataKey(randomBytes(32), randomBytes(32), "recovery", null)).toThrow();
    const wrap = wrapDataKey(randomBytes(32), randomBytes(32), "passkey", "c");
    expect(unwrapDataKey(wrap, randomBytes(20), "passkey", "c")).toBeNull();
    expect(unwrapDataKey({ ...wrap, iv: randomBytes(8) }, randomBytes(32), "passkey", "c")).toBe(
      null,
    );
  });

  it("包むたびに salt と iv が変わる", () => {
    const dk = randomBytes(32);
    const ikm = randomBytes(32);
    const a = wrapDataKey(dk, ikm, "passkey", "c");
    const b = wrapDataKey(dk, ikm, "passkey", "c");
    expect(Buffer.from(a.salt).equals(b.salt)).toBe(false);
    expect(Buffer.from(a.iv).equals(b.iv)).toBe(false);
  });

  it("KEK は ikm と salt の両方に依存する（32 バイト）", () => {
    const ikm = randomBytes(32);
    const salt = randomBytes(32);
    expect(deriveKek(ikm, salt)).toHaveLength(32);
    expect(deriveKek(ikm, salt).equals(deriveKek(ikm, salt))).toBe(true);
    expect(deriveKek(ikm, salt).equals(deriveKek(ikm, randomBytes(32)))).toBe(false);
    expect(deriveKek(ikm, salt).equals(deriveKek(randomBytes(32), salt))).toBe(false);
  });
});

const bytes = (n: number) =>
  fc.uint8Array({ minLength: n, maxLength: n }).map((a) => Buffer.from(a));
const credentialId = fc.base64String({ minLength: 4, maxLength: 64 }).filter((s) => s.length > 0);

describe("INV-52 どの包みを開いても同じ DK。AAD の差し替え・誤った ikm では開けない", () => {
  it("passkey（複数）と recovery の包みを、それぞれの ikm で開くと元の DK", () => {
    fc.assert(
      fc.property(
        bytes(32),
        fc.uniqueArray(fc.tuple(credentialId, bytes(32)), {
          minLength: 1,
          maxLength: 4,
          selector: ([id]) => id,
        }),
        bytes(20),
        (dk, passkeys, rk) => {
          const wraps = passkeys.map(([id, prf]) => ({
            id,
            prf,
            wrap: wrapDataKey(dk, prf, "passkey", id),
          }));
          const recovery = wrapDataKey(dk, rk, "recovery", null);
          for (const { id, prf, wrap } of wraps) {
            expect(eq(unwrapDataKey(wrap, prf, "passkey", id), dk)).toBe(true);
          }
          expect(eq(unwrapDataKey(recovery, rk, "recovery", null), dk)).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("別の資格情報の ID・別の種類（AAD の差し替え）、1 ビット違う ikm、改ざんした行では開けない", () => {
    const fields = ["salt", "iv", "tag", "wrapped"] as const;
    fc.assert(
      fc.property(
        bytes(32),
        credentialId,
        credentialId,
        bytes(32),
        fc.nat(),
        fc.constantFrom(...fields),
        (dk, id, otherId, prf, bit, field) => {
          fc.pre(id !== otherId);
          const wrap = wrapDataKey(dk, prf, "passkey", id);
          expect(unwrapDataKey(wrap, prf, "passkey", otherId)).toBeNull();
          expect(unwrapDataKey(wrap, flipBit(prf, bit), "passkey", id)).toBeNull();
          expect(
            unwrapDataKey({ ...wrap, [field]: flipBit(wrap[field], bit) }, prf, "passkey", id),
          ).toBeNull();
          // passkey の行を recovery として開く（ikm の長さを合わせても）
          expect(unwrapDataKey(wrap, prf.subarray(0, 20), "recovery", null)).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("recovery の包みは、別の回復キー・passkey の種類では開けない", () => {
    fc.assert(
      fc.property(bytes(32), bytes(20), fc.nat(), credentialId, (dk, rk, bit, id) => {
        const wrap = wrapDataKey(dk, rk, "recovery", null);
        expect(unwrapDataKey(wrap, flipBit(rk, bit), "recovery", null)).toBeNull();
        const kinds: [WrapKind, string | null][] = [["passkey", id]];
        for (const [kind, cred] of kinds) {
          expect(unwrapDataKey(wrap, Buffer.concat([rk, rk]).subarray(0, 32), kind, cred)).toBe(
            null,
          );
        }
      }),
      { numRuns: 60 },
    );
  });
});
