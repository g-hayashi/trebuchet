import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

/**
 * ブラウザの WebAuthn 呼び出し（008 design D4）。server の options は PRF の入力を base64url の文字列で持つが、
 * @simplewebauthn/browser はその変換をしないので、呼ぶ前に bytes へ戻す。結果の PRF の出力（ArrayBuffer）は
 * base64url にして、server へ送る response（`clientExtensionResults.prf.results.first`）に入れる。
 */

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isBytes = (value: unknown): value is ArrayBuffer | ArrayBufferView =>
  ArrayBuffer.isView(value) || Object.prototype.toString.call(value) === "[object ArrayBuffer]";

export function base64UrlToBytes(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function bytesToBase64Url(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const decodeEval = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === "string" ? base64UrlToBytes(item) : item,
    ]),
  );
};

/** options の `extensions.prf.eval` / `evalByCredential` の base64url を bytes にした写しを返す。元は変えない */
export function decodePrfInputs<T extends object>(options: T): T {
  const source = options as unknown as Json;
  const extensions = source.extensions;
  if (!isRecord(extensions) || !isRecord(extensions.prf)) return options;
  const prf: Json = { ...extensions.prf };
  if ("eval" in prf) prf.eval = decodeEval(prf.eval);
  if (isRecord(prf.evalByCredential)) {
    prf.evalByCredential = Object.fromEntries(
      Object.entries(prf.evalByCredential).map(([id, value]) => [id, decodeEval(value)]),
    );
  }
  return { ...source, extensions: { ...extensions, prf } } as unknown as T;
}

/** 認証器が返した `clientExtensionResults.prf.results` の bytes を base64url にした写しを返す */
export function encodePrfOutputs<T extends object>(response: T): T {
  const source = response as unknown as Json;
  const results = source.clientExtensionResults;
  if (!isRecord(results) || !isRecord(results.prf) || !isRecord(results.prf.results)) {
    return response;
  }
  const encoded = Object.fromEntries(
    Object.entries(results.prf.results).map(([key, value]) => [
      key,
      isBytes(value) ? bytesToBase64Url(value) : value,
    ]),
  );
  return {
    ...source,
    clientExtensionResults: { ...results, prf: { ...results.prf, results: encoded } },
  } as unknown as T;
}

/** パスキーを作る。戻り値はそのまま server の `{ response }` に入れる */
export async function createCredential(options: object): Promise<Record<string, unknown>> {
  const optionsJSON = decodePrfInputs(options) as unknown as Parameters<
    typeof startRegistration
  >[0]["optionsJSON"];
  return { ...encodePrfOutputs(await startRegistration({ optionsJSON })) };
}

/** パスキーで署名する（解錠・再認証・登録後の PRF の出力の取得）。戻り値はそのまま server の `{ response }` に入れる */
export async function getAssertion(options: object): Promise<Record<string, unknown>> {
  const optionsJSON = decodePrfInputs(options) as unknown as Parameters<
    typeof startAuthentication
  >[0]["optionsJSON"];
  return { ...encodePrfOutputs(await startAuthentication({ optionsJSON })) };
}
