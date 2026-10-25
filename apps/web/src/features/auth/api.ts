import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { queryOptions } from "@tanstack/react-query";
import type { RegisterVerifyInput } from "@trebuchet/schema";
import { ApiError, api, unwrap } from "@/lib/api";

// 認証の API（contracts/http-api.md の「認証」）。サーバーの判定に従い、画面は結果を表示するだけ

const auth = api.api.auth;

/** クエリのキー。AuthGate が認証の状態を持ち、設定の画面が残りを読む */
export const authKeys = {
  status: ["auth", "status"] as const,
  passkeys: ["auth", "passkeys"] as const,
  sessions: ["auth", "sessions"] as const,
  events: ["auth", "events"] as const,
};

export const authStatusQuery = () =>
  queryOptions({
    queryKey: authKeys.status,
    queryFn: async () => unwrap(await auth.status.$get()),
  });

export const passkeysQuery = () =>
  queryOptions({
    queryKey: authKeys.passkeys,
    queryFn: async () => (await unwrap(await auth.passkeys.$get())).passkeys,
  });

export const sessionsQuery = () =>
  queryOptions({
    queryKey: authKeys.sessions,
    queryFn: async () => (await unwrap(await auth.sessions.$get())).sessions,
  });

export const eventsQuery = () =>
  queryOptions({
    queryKey: authKeys.events,
    queryFn: async () => (await unwrap(await auth.events.$get({ query: {} }))).events,
  });

/** ブラウザの WebAuthn の操作の失敗（取り消し、対応していない端末など）を、画面に出せるエラーにする */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new ApiError(
      400,
      "WEBAUTHN_FAILED",
      e instanceof Error ? e.message : "パスキーの操作に失敗しました",
    );
  }
}

/**
 * パスキーの登録の流れ。options を取り、ブラウザで作り、verify に渡す。
 * 名前が空なら送らない（サーバーの既定の名前になる）
 */
async function registerWith<R>(
  getOptions: () => Promise<Response>,
  verify: (input: RegisterVerifyInput) => Promise<R>,
  name?: string,
): Promise<R> {
  const optionsJSON = await unwrap(await getOptions());
  const response = await ceremony(() => startRegistration({ optionsJSON }));
  const trimmed = name?.trim();
  return verify({ response: { ...response }, ...(trimmed ? { name: trimmed } : {}) });
}

export const registerFirstPasskey = () =>
  registerWith(
    () => auth.register.options.$post(),
    async (json) => (await unwrap(await auth.register.verify.$post({ json }))).recoveryCode,
  );

export const registerRecoveryPasskey = () =>
  registerWith(
    () => auth.recovery.register.options.$post(),
    async (json) =>
      (await unwrap(await auth.recovery.register.verify.$post({ json }))).recoveryCode,
  );

export const addPasskey = (name?: string) =>
  registerWith(
    () => auth.passkeys.options.$post(),
    async (json) => (await unwrap(await auth.passkeys.verify.$post({ json }))).passkey,
    name,
  );

export async function signIn(): Promise<void> {
  // JSON を経由した型（省略可の項目が undefined を含む）を、ライブラリの型に合わせる
  const optionsJSON = (await unwrap(
    await auth["sign-in"].options.$post(),
  )) as unknown as PublicKeyCredentialRequestOptionsJSON;
  const response = await ceremony(() => startAuthentication({ optionsJSON }));
  await unwrap(await auth["sign-in"].verify.$post({ json: { response: { ...response } } }));
}

export const verifyRecoveryCode = async (code: string) => {
  await unwrap(await auth.recovery.verify.$post({ json: { code } }));
};

export const regenerateRecoveryCode = async () =>
  (await unwrap(await auth.recovery.regenerate.$post())).recoveryCode;

export const acknowledgeRecoveryCode = async () => {
  await unwrap(await auth.recovery.acknowledge.$post());
};

export const signOut = async () => {
  await unwrap(await auth["sign-out"].$post());
};

export const renamePasskey = async (id: string, name: string) => {
  await unwrap(await auth.passkeys[":id"].$patch({ param: { id }, json: { name } }));
};

export const deletePasskey = async (id: string) => {
  await unwrap(await auth.passkeys[":id"].$delete({ param: { id } }));
};

export const revokeSession = async (id: string) => {
  await unwrap(await auth.sessions[":id"].$delete({ param: { id } }));
};
