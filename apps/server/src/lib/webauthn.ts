import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

/**
 * WebAuthn の options の生成と応答の検証のポート（R1）。
 * 本物は `webauthn-simplewebauthn.ts`（@simplewebauthn/server）。ルートのテストは偽物に差し替える。
 *
 * - 検証の失敗は `null` を返すか、例外を投げる（ルートはどちらも 400 `WEBAUTHN_FAILED` にする）
 * - `expectedChallenge` は、応答に含まれる challenge を渡して真偽を返す関数。
 *   challenge の保持と単回の消費は `lib/challenges.ts` が行う
 */

/** 除外・許可する認証器の指定 */
export type CredentialRef = { id: string; transports?: string[] };

export type VerifiedRegistration = {
  /** credential ID（base64url） */
  id: string;
  /** COSE 公開鍵 */
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
};

type VerifiedAuthentication = { newCounter: number };

type StoredCredential = {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: string[];
};

type VerifyBase = {
  /** ブラウザから届いた応答（@simplewebauthn/browser の JSON） */
  response: Record<string, unknown>;
  expectedChallenge: (challenge: string) => boolean;
  /** `lib/origin.ts` の `expectedOriginFor` */
  expectedOrigin: string;
  /** `lib/origin.ts` の `rpIdFor` */
  expectedRpId: string;
};

export interface WebAuthnVerifier {
  /**
   * 登録の options。residentKey・userVerification は required。
   * `prfSalt`（base64url）を `extensions.prf.eval.first` に入れる（008 の D4。画面が bytes に直す）
   */
  registrationOptions(input: {
    rpId: string;
    excluded: CredentialRef[];
    prfSalt: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(input: VerifyBase): Promise<VerifiedRegistration | null>;
  /** 認証の options。`prfSalts`（資格情報の ID → base64url）を `extensions.prf.evalByCredential` に入れる */
  authenticationOptions(input: {
    rpId: string;
    allowed: CredentialRef[];
    prfSalts?: Record<string, string>;
  }): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(
    input: VerifyBase & { credential: StoredCredential },
  ): Promise<VerifiedAuthentication | null>;
}
