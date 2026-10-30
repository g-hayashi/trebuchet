import {
  type AuthenticationExtensionsClientInputs,
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { WebAuthnVerifier } from "./webauthn.ts";

const RP_NAME = "Trebuchet";
const USER_NAME = "owner";

/**
 * PRF の入力は base64url の文字列のまま options に入れる（ライブラリの型は BufferSource）。
 * 画面が bytes に直してから WebAuthn を呼ぶ（008 の D4、落とし穴 1）
 */
const prfExtensions = (prf: Record<string, unknown>) =>
  ({ prf }) as unknown as AuthenticationExtensionsClientInputs;

/**
 * @simplewebauthn/server による本物の実装（R1）。
 * attestation は none、userVerification は required（Touch ID）、residentKey は required（008 の D4）
 */
export const simpleWebAuthnVerifier: WebAuthnVerifier = {
  registrationOptions({ rpId, excluded, prfSalt }) {
    return generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId,
      userName: USER_NAME,
      attestationType: "none",
      excludeCredentials: excluded,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: prfExtensions({ eval: { first: prfSalt } }),
    });
  },

  async verifyRegistration({ response, expectedChallenge, expectedOrigin, expectedRpId }) {
    const result = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: expectedRpId,
      requireUserVerification: true,
    });
    if (!result.verified) return null;
    const { credential } = result.registrationInfo;
    return {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? null,
    };
  },

  authenticationOptions({ rpId, allowed, prfSalts }) {
    const evalByCredential = Object.fromEntries(
      Object.entries(prfSalts ?? {}).map(([id, salt]) => [id, { first: salt }]),
    );
    return generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: allowed,
      userVerification: "required",
      ...(Object.keys(evalByCredential).length > 0
        ? { extensions: prfExtensions({ evalByCredential }) }
        : {}),
    });
  },

  async verifyAuthentication({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRpId,
    credential,
  }) {
    const result = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: expectedRpId,
      // DB から読んだ鍵は ArrayBufferLike の可能性があるので、ライブラリの型に合わせて複製する
      credential: { ...credential, publicKey: new Uint8Array(credential.publicKey) },
      requireUserVerification: true,
    });
    if (!result.verified) return null;
    return { newCounter: result.authenticationInfo.newCounter };
  },
};
