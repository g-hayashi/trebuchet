import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { RegisterVerifyInput } from "@trebuchet/schema";
import { ApiError, api, unwrap } from "@/lib/api";
import { createCredential, getAssertion } from "./webauthn-client";

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

/** 登録で PRF の出力が返らなかったときの応答（design D4.1）。続けて認証を 1 回行い、同じ verify に送る */
type PrfRequired = { status: "prf_required"; options: object };
const isPrfRequired = (body: unknown): body is PrfRequired =>
  typeof body === "object" &&
  body !== null &&
  (body as { status?: unknown }).status === "prf_required";

/**
 * パスキーの登録の流れ。options を取り、ブラウザで作り、verify に渡す。
 * PRF の出力が返らなければ（`prf_required`）、返された options で認証して、同じ verify にもう一度送る。
 * 名前が空なら送らない（server の既定の名前になる）
 */
async function registerWith<R extends object>(
  getOptions: () => Promise<Response>,
  verify: (input: RegisterVerifyInput) => Promise<R>,
  name?: string,
): Promise<Exclude<R, PrfRequired>> {
  const optionsJSON = await unwrap(await getOptions());
  const trimmed = name?.trim();
  const withName = (response: Record<string, unknown>): RegisterVerifyInput => ({
    response,
    ...(trimmed ? { name: trimmed } : {}),
  });

  const first = await verify(withName(await ceremony(() => createCredential(optionsJSON))));
  if (!isPrfRequired(first)) return first as Exclude<R, PrfRequired>;
  const second = await verify(withName(await ceremony(() => getAssertion(first.options))));
  if (isPrfRequired(second)) {
    throw new ApiError(400, "PRF_UNSUPPORTED", "このパスキーは鍵の保護（PRF）に対応していません");
  }
  return second as Exclude<R, PrfRequired>;
}

/** 初回の設定。新しい回復キーを返す（この応答の 1 回だけ） */
export const registerFirstPasskey = async () =>
  (
    await registerWith(
      () => auth.register.options.$post(),
      async (json) => unwrap(await auth.register.verify.$post({ json })),
    )
  ).recoveryCode;

/** 回復キーで解錠した後の、新しいパスキーの登録。新しい回復キーを返す */
export const registerRecoveryPasskey = async () =>
  (
    await registerWith(
      () => auth.recovery.register.options.$post(),
      async (json) => unwrap(await auth.recovery.register.verify.$post({ json })),
    )
  ).recoveryCode;

/**
 * パスキーの追加・削除と回復キーの再発行は、直近 5 分以内の再認証が要る（403 REAUTH_REQUIRED）。
 * 要るときはパスキーで確認してから、同じ操作をやり直す
 */
export async function withReauth<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "REAUTH_REQUIRED")) throw e;
    await reauthenticate();
    return run();
  }
}

export async function reauthenticate(): Promise<void> {
  const options = await unwrap(await auth.reauth.options.$post());
  const response = await ceremony(() => getAssertion(options));
  await unwrap(await auth.reauth.verify.$post({ json: { response } }));
}

export const addPasskey = (name?: string) =>
  withReauth(
    async () =>
      (
        await registerWith(
          () => auth.passkeys.options.$post(),
          async (json) => unwrap(await auth.passkeys.verify.$post({ json })),
          name,
        )
      ).passkey,
  );

/** パスキーで解錠する。PRF の出力で包みを開けた場合だけ成功する */
export async function unlockWithPasskey(): Promise<void> {
  const options = await unwrap(await auth["sign-in"].options.$post());
  const response = await ceremony(() => getAssertion(options));
  await unwrap(await auth["sign-in"].verify.$post({ json: { response } }));
}

/** 回復キーで解錠する（回復用の一時セッション。できるのは新しいパスキーの登録だけ） */
export const verifyRecoveryKey = async (code: string) => {
  await unwrap(await auth.recovery.verify.$post({ json: { code } }));
};

export const regenerateRecoveryKey = () =>
  withReauth(async () => (await unwrap(await auth.recovery.regenerate.$post())).recoveryCode);

export const acknowledgeRecoveryKey = async () => {
  await unwrap(await auth.recovery.acknowledge.$post());
};

/** 施錠する（server は全セッションを消して施錠する） */
export const lockVault = async () => {
  await unwrap(await auth["sign-out"].$post());
};

/** 帳簿のデータを画面に残さない（認証の query は残す）。施錠・失効のときに呼ぶ */
export function clearLedgerData(queryClient: QueryClient) {
  queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[0] !== "auth" });
}

export const renamePasskey = async (id: string, name: string) => {
  await unwrap(await auth.passkeys[":id"].$patch({ param: { id }, json: { name } }));
};

export const deletePasskey = (id: string) =>
  withReauth(async () => {
    await unwrap(await auth.passkeys[":id"].$delete({ param: { id } }));
  });

export const revokeSession = async (id: string) => {
  await unwrap(await auth.sessions[":id"].$delete({ param: { id } }));
};
