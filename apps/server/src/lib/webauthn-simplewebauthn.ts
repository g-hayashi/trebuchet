import {
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
 * @simplewebauthn/server による本物の実装（R1）。
 * attestation は none、userVerification は required（Touch ID）、residentKey は preferred
 */
export const simpleWebAuthnVerifier: WebAuthnVerifier = {
  registrationOptions({ rpId, excluded }) {
    return generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId,
      userName: USER_NAME,
      attestationType: "none",
      excludeCredentials: excluded,
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
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

  authenticationOptions({ rpId, allowed }) {
    return generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: allowed,
      userVerification: "required",
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
