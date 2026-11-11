/**
 * ブラウザが送る WebAuthn の応答（@simplewebauthn/browser の JSON）の読み取り（008 の D4。
 * 写す元: invest-copilot `webauthnResponse.ts`）。署名の検証は `webauthn.ts` のポートが行う。
 * PRF の出力（`clientExtensionResults.prf.results.first`、base64url の 32 バイト）は署名の対象外なので、
 * 正しさは包みが開けたかでだけ判定する（落とし穴 3）
 */

import { isRecord } from "./util.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PRF_BYTES = 32;

/** 登録（attestation）か認証（assertion）か。どちらの形でもなければ null */
export function responseKind(value: unknown): "registration" | "authentication" | null {
  if (!isRecord(value) || !isRecord(value.response)) return null;
  const inner = value.response;
  if (typeof inner.attestationObject === "string") return "registration";
  if (typeof inner.authenticatorData === "string" && typeof inner.signature === "string") {
    return "authentication";
  }
  return null;
}

/** clientDataJSON（base64url の JSON）の challenge。読めなければ null */
export function challengeOf(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.response)) return null;
  const encoded = value.response.clientDataJSON;
  if (typeof encoded !== "string" || !BASE64URL.test(encoded)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const challenge = isRecord(parsed) ? parsed.challenge : undefined;
    return typeof challenge === "string" && challenge !== "" ? challenge : null;
  } catch {
    return null;
  }
}

/**
 * PRF の結果。`enabled` は認証器が PRF を使えるか（出力が返れば真）。
 * `first` は 32 バイトの出力（登録で返らない認証器では null。D4 の `prf_required`）
 */
export function readPrf(value: unknown): { enabled: boolean; first: Buffer | null } {
  const prf =
    isRecord(value) && isRecord(value.clientExtensionResults)
      ? value.clientExtensionResults.prf
      : undefined;
  if (!isRecord(prf)) return { enabled: false, first: null };
  const encoded = isRecord(prf.results) ? prf.results.first : undefined;
  const decoded =
    typeof encoded === "string" && BASE64URL.test(encoded)
      ? Buffer.from(encoded, "base64url")
      : null;
  const first = decoded !== null && decoded.length === PRF_BYTES ? decoded : null;
  return { enabled: prf.enabled === true || first !== null, first };
}
