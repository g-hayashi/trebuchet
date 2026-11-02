import { DrizzleAuthStore, openAuth, openRegistry } from "@trebuchet/db";
import { createApp } from "../src/app.ts";
import { SESSION_COOKIE } from "../src/lib/session.ts";
import { makeClock, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";
import {
  authResponse,
  fakeVerifier,
  type Json,
  type PrfMode,
  regResponse,
  type TestRes,
} from "./webauthn-fakes.ts";

// ペアリング（T017・T017b）のテストが共有する準備。ローカルで初回の設定をしてサインインし、
// リモートの名前を登録して、トークンの発行と ts.net の名前での登録を呼ぶ

export const REMOTE_HOST = "mac.tail1234.ts.net";
export const REMOTE_ORIGIN = `https://${REMOTE_HOST}`;
export const MIN = 60 * 1000;
export const authStore = () => new DrizzleAuthStore(openAuth(), openRegistry);

export type CallOpts = { body?: unknown; cookie?: string; host?: string };

export function setupPairing(options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const clock = makeClock("2026-10-20T00:00:00.000Z");
  const { verifier, seen } = fakeVerifier();
  const app = createApp({ clock, webauthn: verifier, ...options });

  const call = (method: string, path: string, o: CallOpts = {}): Promise<TestRes> => {
    const host = o.host ?? TEST_HOST;
    return app.request(`/api${path}`, {
      method,
      headers: {
        Host: host,
        Origin: host === REMOTE_HOST ? REMOTE_ORIGIN : TEST_ORIGIN,
        ...(o.body === undefined ? {} : { "content-type": "application/json" }),
        ...(o.cookie === undefined ? {} : { Cookie: o.cookie }),
      },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    }) as Promise<TestRes>;
  };

  const setCookieOf = (res: Response) =>
    res.headers.getSetCookie().find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  const cookieOf = (res: Response): string | undefined => setCookieOf(res)?.split(";")[0];

  /** ローカルで初回の設定（パスキー p1）をして、サインイン中の cookie を返す（直後は再認証の済んだ状態） */
  async function registerFirst(credId = "p1"): Promise<string> {
    const opts = await (await call("POST", "/auth/register/options")).json();
    const res = await call("POST", "/auth/register/verify", {
      body: { response: regResponse(opts, credId) },
    });
    if (res.status !== 201) throw new Error(`初回の設定に失敗: ${res.status}`);
    return cookieOf(res) as string;
  }

  /** リモートを有効にして名前を登録する */
  const enableRemote = (host: string = REMOTE_HOST) =>
    authStore().setRemoteSettings({ enabled: true, host }, clock.now());

  const issue = (cookie: string) => call("POST", "/auth/pairing", { cookie });

  /** トークンを発行して返す（リモートの設定とサインイン済みの cookie が前提） */
  async function issueToken(cookie: string): Promise<string> {
    const res = await issue(cookie);
    if (res.status !== 201) throw new Error(`発行に失敗: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  }

  const pairOptions = (token: string, o: { host?: string } = {}) =>
    call("POST", "/auth/pairing/register/options", {
      host: o.host ?? REMOTE_HOST,
      body: { token },
    });

  /** options → verify。`prf_required` なら `followUp` の認証を続ける */
  async function pair(
    token: string,
    credId: string,
    o: { prf?: PrfMode; followUp?: PrfMode | false; name?: string; fail?: boolean } = {},
  ): Promise<{ res: TestRes; options: Json }> {
    const optRes = await pairOptions(token);
    if (optRes.status !== 200) return { res: optRes, options: undefined as Json };
    const options = await optRes.json();
    const extra = o.fail ? { fail: true } : {};
    const send = (response: unknown) =>
      call("POST", "/auth/pairing/register/verify", {
        host: REMOTE_HOST,
        body: { token, response, ...(o.name === undefined ? {} : { name: o.name }) },
      });
    let res = await send(regResponse(options, credId, o.prf ?? "output", extra));
    if (res.status === 200 && o.followUp !== false) {
      const body = (await res.clone().json()) as Json;
      if (body?.status === "prf_required") {
        res = await send(authResponse(body.options, credId, o.followUp ?? "output"));
      }
    }
    return { res, options };
  }

  const events = () => authStore().listEvents(500);

  return {
    app,
    clock,
    seen,
    call,
    cookieOf,
    setCookieOf,
    registerFirst,
    enableRemote,
    issue,
    issueToken,
    pairOptions,
    pair,
    events,
  };
}
