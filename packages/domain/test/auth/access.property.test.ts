import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PUBLIC_ROUTES, requiresAuth } from "../../src/auth/access.ts";

/** data-model §3 の公開の 11 組 */
const PUBLIC: [string, string][] = [
  ["GET", "/api/health"],
  ["GET", "/api/auth/status"],
  ["POST", "/api/auth/register/options"],
  ["POST", "/api/auth/register/verify"],
  ["POST", "/api/auth/sign-in/options"],
  ["POST", "/api/auth/sign-in/verify"],
  ["POST", "/api/auth/recovery/verify"],
  ["POST", "/api/auth/recovery/register/options"],
  ["POST", "/api/auth/recovery/register/verify"],
  ["POST", "/api/auth/pairing/register/options"],
  ["POST", "/api/auth/pairing/register/verify"],
];
const isPublic = (m: string, p: string) => PUBLIC.some(([pm, pp]) => pm === m && pp === p);

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const methodArb = fc.constantFrom(...METHODS);
const publicArb = fc.constantFrom(...PUBLIC);

describe("requiresAuth（INV-29 の判定）", () => {
  it("公開は 11 組だけ", () => {
    expect(PUBLIC_ROUTES).toHaveLength(11);
    expect(new Set(PUBLIC_ROUTES.map(([m, p]) => `${m} ${p}`))).toEqual(
      new Set(PUBLIC.map(([m, p]) => `${m} ${p}`)),
    );
  });

  it("公開の 11 組は false", () => {
    for (const [m, p] of PUBLIC) expect(requiresAuth(m, p)).toBe(false);
  });

  it("名簿に載らない代表例は true", () => {
    for (const [m, p] of [
      ["POST", "/api/auth/recovery/regenerate"],
      ["POST", "/api/auth/recovery/acknowledge"],
      ["POST", "/api/auth/sign-out"],
      ["POST", "/api/auth/pairing"],
      ["GET", "/api/entities"],
      ["GET", "/api/auth/passkeys"],
    ] as const) {
      expect(requiresAuth(m, p)).toBe(true);
    }
  });

  it("公開のパスに別のメソッドを付けたものは true", () => {
    fc.assert(
      fc.property(publicArb, methodArb, ([m, p], other) => {
        fc.pre(other !== m);
        expect(requiresAuth(other, p)).toBe(true);
      }),
    );
  });

  it("公開のパスの前方一致・末尾の違い・大文字小文字の違いは true", () => {
    const tail = fc.oneof(
      fc.constantFrom("/", "//", "?x=1", "#a", "/x", ".json", " ", "%2F"),
      fc.string({ minLength: 1, maxLength: 8 }),
    );
    fc.assert(
      fc.property(publicArb, tail, ([m, p], t) => {
        fc.pre(!isPublic(m, p + t));
        expect(requiresAuth(m, p + t)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(publicArb, ([m, p]) => {
        fc.pre(p.toUpperCase() !== p);
        expect(requiresAuth(m, p.toUpperCase())).toBe(true);
        expect(requiresAuth(m, p.slice(0, -1))).toBe(true);
      }),
    );
  });

  it("任意のメソッドとパスで、公開の 11 組のときだけ false", () => {
    const pathArb = fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.constantFrom(...PUBLIC.map(([, p]) => p)),
      fc.constantFrom("/api/auth/", "/api/auth", "/api", "/api/auth/recovery", "/api/health/x"),
    );
    fc.assert(
      fc.property(fc.oneof(methodArb, fc.string({ maxLength: 8 })), pathArb, (m, p) => {
        expect(requiresAuth(m, p)).toBe(!isPublic(m, p));
      }),
    );
  });
});
