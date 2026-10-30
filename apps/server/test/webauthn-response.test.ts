import { describe, expect, it } from "vitest";
import { challengeOf, readPrf, responseKind } from "../src/lib/webauthn-response.ts";

// 008 の D4: ブラウザの応答（@simplewebauthn/browser の JSON）から、種類・challenge・PRF の出力を読む

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const clientData = (challenge: unknown) => b64(JSON.stringify({ type: "x", challenge }));
const prfOut = Buffer.alloc(32, 7).toString("base64url");

describe("responseKind・challengeOf", () => {
  it("attestationObject があれば登録、authenticatorData と signature があれば認証", () => {
    expect(
      responseKind({ id: "a", response: { clientDataJSON: "x", attestationObject: "y" } }),
    ).toBe("registration");
    expect(
      responseKind({
        id: "a",
        response: { clientDataJSON: "x", authenticatorData: "y", signature: "z" },
      }),
    ).toBe("authentication");
    expect(responseKind({ id: "a", response: { clientDataJSON: "x" } })).toBeNull();
    expect(responseKind({ id: "a" })).toBeNull();
    expect(responseKind(null)).toBeNull();
  });

  it("challenge は clientDataJSON（base64url の JSON）から読む。読めなければ null", () => {
    expect(challengeOf({ response: { clientDataJSON: clientData("abc") } })).toBe("abc");
    expect(challengeOf({ response: { clientDataJSON: clientData(1) } })).toBeNull();
    expect(challengeOf({ response: { clientDataJSON: clientData("") } })).toBeNull();
    expect(challengeOf({ response: { clientDataJSON: "!!" } })).toBeNull();
    expect(challengeOf({ response: {} })).toBeNull();
    expect(challengeOf("x")).toBeNull();
  });
});

describe("readPrf（落とし穴 1・3）", () => {
  it("results.first（base64url の 32 バイト）を読む", () => {
    const r = readPrf({ clientExtensionResults: { prf: { results: { first: prfOut } } } });
    expect(r.enabled).toBe(true);
    expect(r.first?.equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it("enabled だけ（登録で出力が返らない認証器）は first が null", () => {
    expect(readPrf({ clientExtensionResults: { prf: { enabled: true } } })).toEqual({
      enabled: true,
      first: null,
    });
  });

  it("prf がない・enabled が偽・長さ違い・base64url でない値は使えない", () => {
    expect(readPrf({ clientExtensionResults: {} })).toEqual({ enabled: false, first: null });
    expect(readPrf({})).toEqual({ enabled: false, first: null });
    expect(readPrf({ clientExtensionResults: { prf: { enabled: false } } }).enabled).toBe(false);
    const short = Buffer.alloc(16).toString("base64url");
    expect(readPrf({ clientExtensionResults: { prf: { results: { first: short } } } }).first).toBe(
      null,
    );
    expect(readPrf({ clientExtensionResults: { prf: { results: { first: "@@" } } } }).first).toBe(
      null,
    );
  });
});
