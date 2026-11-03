import { createHash, randomUUID } from "node:crypto";
import type { CredentialRef, WebAuthnVerifier } from "../src/lib/webauthn.ts";
import { challengeOf } from "../src/lib/webauthn-response.ts";

// パスキーの登録・認証のルートのテストが共有する偽の認証器と偽の WebAuthnVerifier。
// 検証は偽物に差し替え、PRF の出力はテストが与える（資格情報と salt から決まる値）

export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
/** 偽の認証器の PRF: 資格情報と salt から決まる 32 バイト */
export const prfOf = (credId: string, salt: string) =>
  createHash("sha256").update(`${credId}|${salt}`).digest();
const clientData = (challenge: string) => b64(Buffer.from(JSON.stringify({ challenge })));

// biome-ignore lint/suspicious/noExplicitAny: テストが読む JSON は形を決めない
export type Json = any;
/** `json()` が any を返す Response（先頭のシグネチャが優先される） */
export type TestRes = { json(): Promise<Json> } & Response;

export type PrfMode = "output" | "enabled" | "none" | "wrong";

/** 登録の応答（attestation）。PRF は options の `eval.first` を salt にして計算する */
export function regResponse(options: Json, credId: string, mode: PrfMode = "output", extra = {}) {
  const salt = options?.extensions?.prf?.eval?.first ?? "";
  const prf =
    mode === "none"
      ? {}
      : mode === "enabled"
        ? { prf: { enabled: true } }
        : {
            prf: {
              enabled: true,
              results: { first: b64(prfOf(credId, mode === "wrong" ? "x" : salt)) },
            },
          };
  return {
    id: credId,
    rawId: credId,
    type: "public-key",
    response: { clientDataJSON: clientData(options.challenge), attestationObject: "att" },
    clientExtensionResults: prf,
    ...extra,
  };
}

/** 認証の応答（assertion）。PRF は options の `evalByCredential[credId].first` を salt にする */
export function authResponse(options: Json, credId: string, mode: PrfMode = "output", extra = {}) {
  const salt = options?.extensions?.prf?.evalByCredential?.[credId]?.first ?? "";
  const prf =
    mode === "output" || mode === "wrong"
      ? { prf: { results: { first: b64(prfOf(credId, mode === "wrong" ? "x" : salt)) } } }
      : {};
  return {
    id: credId,
    rawId: credId,
    type: "public-key",
    response: {
      clientDataJSON: clientData(options.challenge),
      authenticatorData: "ad",
      signature: "sig",
    },
    clientExtensionResults: prf,
    ...extra,
  };
}

/** 偽の WebAuthnVerifier。本物と同じく、応答の challenge を expectedChallenge に渡して確かめる */
export function fakeVerifier() {
  const seen = {
    registrations: [] as { origin: string; rpId: string }[],
    allowed: [] as CredentialRef[][],
    excluded: [] as CredentialRef[][],
  };
  const verifier: WebAuthnVerifier = {
    async registrationOptions({ rpId, excluded, prfSalt }) {
      seen.excluded.push(excluded);
      return {
        challenge: `reg-${randomUUID()}`,
        rp: { id: rpId, name: "t" },
        user: { id: "u", name: "owner", displayName: "owner" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        extensions: { prf: { eval: { first: prfSalt } } } as never,
      };
    },
    async verifyRegistration({ response, expectedChallenge, expectedOrigin, expectedRpId }) {
      seen.registrations.push({ origin: expectedOrigin, rpId: expectedRpId });
      if (!expectedChallenge(challengeOf(response) ?? "")) throw new Error("challenge");
      if (response.fail === true) return null;
      return {
        id: String(response.id),
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ["internal"],
      };
    },
    async authenticationOptions({ rpId, allowed, prfSalts }) {
      seen.allowed.push(allowed);
      const evalByCredential = Object.fromEntries(
        Object.entries(prfSalts ?? {}).map(([id, first]) => [id, { first }]),
      );
      return {
        challenge: `auth-${randomUUID()}`,
        rpId,
        allowCredentials: allowed.map((c) => ({ id: c.id, type: "public-key" as const })),
        ...(prfSalts ? { extensions: { prf: { evalByCredential } } as never } : {}),
      };
    },
    async verifyAuthentication({ response, expectedChallenge, credential }) {
      if (!expectedChallenge(challengeOf(response) ?? "")) throw new Error("challenge");
      if (response.fail === true) return null;
      return { newCounter: credential.counter + 1 };
    },
  };
  return { verifier, seen };
}
