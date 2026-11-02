import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  clearDataKey,
  DrizzleAuthStore,
  hashToken,
  isUnlocked,
  openAuth,
  openRegistry,
  parseRecoveryKey,
  registryFile,
  unwrapDataKey,
  withDataKey,
} from "@trebuchet/db";
import { TEST_DATA_KEY, type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { SESSION_COOKIE } from "../src/lib/session.ts";
import { simpleWebAuthnVerifier } from "../src/lib/webauthn-simplewebauthn.ts";
import { createTestSession, makeClock, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";
import {
  authResponse,
  b64,
  fakeVerifier,
  type Json,
  type PrfMode,
  prfOf,
  regResponse,
  type TestRes,
} from "./webauthn-fakes.ts";

// 008 の T002: 認証のルート（初回の設定・サインイン・回復の PRF と包み、再認証、施錠）。
// WebAuthn の検証は偽物に差し替え、PRF の出力はテストが与える（資格情報と salt から決まる値）

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server");
});
afterEach(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
});

const REMOTE_HOST = "mac.tail1234.ts.net";
const REMOTE_ORIGIN = `https://${REMOTE_HOST}`;
const store = () => new DrizzleAuthStore(openAuth(), openRegistry);
const MIN = 60 * 1000;

type CallOpts = {
  body?: unknown;
  cookie?: string;
  host?: string;
  headers?: Record<string, string>;
};

function setup() {
  const clock = makeClock("2026-10-20T00:00:00.000Z");
  const { verifier, seen } = fakeVerifier();
  const delays: number[] = [];
  const app = createApp({
    clock,
    webauthn: verifier,
    getRemoteSettings: async () => ({ enabled: true, host: REMOTE_HOST }),
    recoveryDelay: async (ms) => {
      delays.push(ms);
    },
  });

  const call = (method: string, path: string, o: CallOpts = {}): Promise<TestRes> => {
    const host = o.host ?? TEST_HOST;
    const headers: Record<string, string> = {
      Host: host,
      Origin: host === REMOTE_HOST ? REMOTE_ORIGIN : TEST_ORIGIN,
      ...(o.body === undefined ? {} : { "content-type": "application/json" }),
      ...(o.cookie === undefined ? {} : { Cookie: o.cookie }),
      ...o.headers,
    };
    return app.request(`/api${path}`, {
      method,
      headers,
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    }) as Promise<TestRes>;
  };

  const cookieOf = (res: Response): string | undefined => {
    const line = res.headers.getSetCookie().find((s) => s.startsWith(`${SESSION_COOKIE}=`));
    const pair = line?.split(";")[0];
    return pair === `${SESSION_COOKIE}=` ? undefined : pair;
  };

  /** 登録の options → verify。`prf_required` なら続けて認証を 1 回行う（`followUp` が偽なら行わない） */
  async function register(
    path: string,
    credId: string,
    o: { cookie?: string; name?: string; prf?: PrfMode; followUp?: PrfMode | false } = {},
  ) {
    const cookie = o.cookie === undefined ? {} : { cookie: o.cookie };
    const options = await (await call("POST", `${path}/options`, cookie)).json();
    let res = await call("POST", `${path}/verify`, {
      ...cookie,
      body: {
        response: regResponse(options, credId, o.prf ?? "output"),
        ...(o.name === undefined ? {} : { name: o.name }),
      },
    });
    let prfRequired: Json;
    if (res.status === 200) {
      prfRequired = await res.clone().json();
      if (prfRequired?.status === "prf_required" && o.followUp !== false) {
        res = await call("POST", `${path}/verify`, {
          ...cookie,
          body: { response: authResponse(prfRequired.options, credId, o.followUp ?? "output") },
        });
      }
    }
    return { res, options, prfRequired };
  }

  /** 初回の設定 */
  async function registerFirst(
    credId = "p1",
    o: { name?: string; prf?: PrfMode; followUp?: PrfMode | false } = {},
  ) {
    const { res, options } = await register("/auth/register", credId, o);
    const body: Json = res.status === 201 ? await res.clone().json() : {};
    return {
      res,
      options,
      cookie: cookieOf(res) as string,
      recoveryCode: body.recoveryCode as string,
    };
  }

  async function signIn(credId: string, mode: PrfMode = "output", extra = {}) {
    const options = await (await call("POST", "/auth/sign-in/options")).json();
    const res = await call("POST", "/auth/sign-in/verify", {
      body: { response: authResponse(options, credId, mode, extra) },
    });
    return { res, options, cookie: cookieOf(res) as string };
  }

  async function reauth(cookie: string, credId: string, extra = {}) {
    const options = await (await call("POST", "/auth/reauth/options", { cookie })).json();
    return call("POST", "/auth/reauth/verify", {
      cookie,
      body: { response: authResponse(options, credId, "none", extra) },
    });
  }

  const addPasskey = (
    cookie: string,
    credId: string,
    o: { prf?: PrfMode; followUp?: PrfMode | false } = {},
  ) => register("/auth/passkeys", credId, { cookie, ...o }).then((r) => r.res);

  const recover = (code: string) => call("POST", "/auth/recovery/verify", { body: { code } });

  const recoveryRegister = (
    cookie: string,
    credId: string,
    o: { prf?: PrfMode; followUp?: PrfMode | false } = {},
  ) => register("/auth/recovery/register", credId, { cookie, ...o }).then((r) => r.res);

  const signOut = (cookie: string) => call("POST", "/auth/sign-out", { cookie });

  const status = async (cookie?: string, host?: string) =>
    (
      await call("GET", "/auth/status", {
        ...(cookie ? { cookie } : {}),
        ...(host ? { host } : {}),
      })
    ).json();

  const events = () => store().listEvents(500);
  const count = async (kind: string) => (await events()).filter((e) => e.kind === kind).length;

  return {
    app,
    clock,
    seen,
    delays,
    call,
    cookieOf,
    register,
    registerFirst,
    signIn,
    reauth,
    addPasskey,
    recover,
    recoveryRegister,
    signOut,
    status,
    events,
    count,
  };
}

const KEY_FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/;
const code = (res: { json(): Promise<unknown> }) =>
  res.json().then((b) => (b as { error: { code: string } }).error.code);
const currentDk = () => withDataKey((dk) => Buffer.from(dk));

/** 回復キーで recovery の包みを開いた DK（開けなければ null） */
async function dkByRecovery(text: string) {
  const wrap = await store().getRecoveryWrap();
  const secret = parseRecoveryKey(text);
  return wrap && secret ? unwrapDataKey(wrap, secret, "recovery", null) : null;
}

/** パスキーの包みを、そのパスキーの PRF で開いた DK */
async function dkByPasskey(credId: string) {
  const passkey = await store().getPasskey(credId);
  const wrap = await store().getPasskeyWrap(credId);
  if (!passkey || !wrap) return null;
  return unwrapDataKey(wrap, prfOf(credId, b64(passkey.prfSalt)), "passkey", credId);
}

describe("初回の設定（D4.1）", () => {
  it("201 と cookie と回復キー。DK を作って解錠し、パスキーと回復キーの包みが同じ DK を開く（INV-52・53）", async () => {
    const t = setup();
    const { res, recoveryCode, options } = await t.registerFirst("p1", { name: "MacBook" });
    expect(res.status).toBe(201);
    expect(recoveryCode).toMatch(KEY_FORMAT);
    const setCookie = res.headers.getSetCookie().find((s) => s.startsWith(`${SESSION_COOKIE}=`));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(t.seen.registrations).toEqual([{ origin: TEST_ORIGIN, rpId: "localhost" }]);

    const passkeys = await store().listPasskeys();
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0]).toMatchObject({ id: "p1", name: "MacBook", rpId: "localhost" });
    // options の PRF の入力（base64url の 32 バイト）が、資格情報ごとの prf_salt として残る
    const salt = options.extensions.prf.eval.first as string;
    expect(Buffer.from(salt, "base64url")).toHaveLength(32);
    expect(b64(passkeys[0]?.prfSalt ?? new Uint8Array())).toBe(salt);

    expect(isUnlocked()).toBe(true);
    const dk = currentDk();
    expect(dk.equals(Buffer.from(TEST_DATA_KEY))).toBe(false);
    expect((await dkByRecovery(recoveryCode))?.equals(dk)).toBe(true);
    expect((await dkByPasskey("p1"))?.equals(dk)).toBe(true);
    expect(await t.count("register")).toBe(1);
    expect(await t.status(t.cookieOf(res))).toMatchObject({ registered: true, signedIn: true });
  });

  it("作ったセッションはパスキーの passkey_id を持つ。回復キーのハッシュ・平文は保存しない", async () => {
    const t = setup();
    const { cookie, recoveryCode } = await t.registerFirst("p1");
    const token = cookie.split("=")[1] ?? "";
    const session = await store().findSessionByTokenHash(hashToken(token));
    expect(session).toMatchObject({ kind: "normal", passkeyId: "p1", rpId: "localhost" });
    const dump = JSON.stringify(
      openAuth().$client.prepare("SELECT * FROM key_wraps").all(),
      (_k, v) => (v?.type === "Buffer" ? Buffer.from(v.data).toString("hex") : v),
    );
    const secretHex = parseRecoveryKey(recoveryCode)?.toString("hex") ?? "";
    expect(dump).not.toContain(secretHex);
    expect(dump).not.toContain(hashToken(recoveryCode.replaceAll("-", "")));
    expect(dump).not.toContain(currentDk().toString("hex"));
  });

  it("登録で PRF の出力が返らない認証器は 200 prf_required。続けての認証の出力で設定が済む", async () => {
    const t = setup();
    const { res, options, prfRequired } = await t.register("/auth/register", "p1", {
      prf: "enabled",
    });
    expect(prfRequired.status).toBe("prf_required");
    expect(prfRequired.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual(["p1"]);
    // 続けての認証には、登録と同じ salt を渡す
    expect(prfRequired.options.extensions.prf.evalByCredential.p1.first).toBe(
      options.extensions.prf.eval.first,
    );
    expect(res.status).toBe(201);
    const { recoveryCode } = await res.json();
    expect((await dkByRecovery(recoveryCode))?.equals(currentDk())).toBe(true);
    expect((await dkByPasskey("p1"))?.equals(currentDk())).toBe(true);
    expect((await store().getPasskey("p1"))?.counter).toBe(1);
  });

  it("prf_required の途中では、パスキーも包みも作らない", async () => {
    const t = setup();
    const { res } = await t.register("/auth/register", "p1", { prf: "enabled", followUp: false });
    expect(res.status).toBe(200);
    expect(await store().listPasskeys()).toEqual([]);
    expect(await store().getRecoveryWrap()).toBeUndefined();
    expect((await t.status()).registered).toBe(false);
  });

  it("PRF を使えない認証器は 400 PRF_UNSUPPORTED（登録でも、続けての認証でも）。何も作らない", async () => {
    const t = setup();
    const none = await t.register("/auth/register", "p1", { prf: "none" });
    expect(none.res.status).toBe(400);
    expect(await code(none.res)).toBe("PRF_UNSUPPORTED");
    const later = await t.register("/auth/register", "p1", { prf: "enabled", followUp: "none" });
    expect(later.res.status).toBe(400);
    expect(await code(later.res)).toBe("PRF_UNSUPPORTED");
    expect(await store().listPasskeys()).toEqual([]);
    expect(await store().getRecoveryWrap()).toBeUndefined();
    expect(currentDk().equals(Buffer.from(TEST_DATA_KEY))).toBe(true);
  });

  it("prf_required の続きを別の資格情報で送ると 400 WEBAUTHN_FAILED", async () => {
    const t = setup();
    const { prfRequired } = await t.register("/auth/register", "p1", {
      prf: "enabled",
      followUp: false,
    });
    const res = await t.call("POST", "/auth/register/verify", {
      body: { response: authResponse(prfRequired.options, "other") },
    });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("WEBAUTHN_FAILED");
  });

  it("前の DK の registry・事業体の DB は discarded-<時刻>/ に移し、新しい DK で空から作る", async () => {
    const t = setup();
    openRegistry().$client.exec("CREATE TABLE marker (x)");
    const { res } = await t.registerFirst("p1");
    expect(res.status).toBe(201);
    const discarded = readdirSync(tmp.dir).filter((n) => n.startsWith("discarded-"));
    expect(discarded).toHaveLength(1);
    expect(existsSync(join(tmp.dir, discarded[0] ?? "", "registry.sqlite"))).toBe(true);
    expect(existsSync(registryFile())).toBe(true);
    const tables = openRegistry()
      .$client.prepare("SELECT name FROM sqlite_master WHERE name = 'marker'")
      .all();
    expect(tables).toEqual([]);
  });

  it("2 回目の options・verify は 409 ALREADY_REGISTERED", async () => {
    const t = setup();
    await t.registerFirst();
    const opt = await t.call("POST", "/auth/register/options");
    expect(opt.status).toBe(409);
    expect(await code(opt)).toBe("ALREADY_REGISTERED");
    const ver = await t.call("POST", "/auth/register/verify", {
      body: { response: regResponse({ challenge: "x" }, "p2") },
    });
    expect(ver.status).toBe(409);
  });

  it("ts.net の Host からの設定は 421 HOST_NOT_ALLOWED（options も verify も）", async () => {
    const t = setup();
    const opt = await t.call("POST", "/auth/register/options", { host: REMOTE_HOST });
    expect(opt.status).toBe(421);
    expect(await code(opt)).toBe("HOST_NOT_ALLOWED");
    const ver = await t.call("POST", "/auth/register/verify", {
      host: REMOTE_HOST,
      body: { response: regResponse({ challenge: "x" }, "p1") },
    });
    expect(ver.status).toBe(421);
    expect(await store().listPasskeys()).toHaveLength(0);
  });

  it("検証の失敗は 400 WEBAUTHN_FAILED。パスキーも記録も増えず、DK を替えない", async () => {
    const t = setup();
    const options = await (await t.call("POST", "/auth/register/options")).json();
    const failed = await t.call("POST", "/auth/register/verify", {
      body: { response: regResponse(options, "p1", "output", { fail: true }) },
    });
    expect(failed.status).toBe(400);
    expect(await code(failed)).toBe("WEBAUTHN_FAILED");
    expect(failed.headers.getSetCookie()).toEqual([]);
    expect(await store().listPasskeys()).toHaveLength(0);
    expect(currentDk().equals(Buffer.from(TEST_DATA_KEY))).toBe(true);
  });

  it("知らない challenge・使い済みの challenge・5 分過ぎた challenge は 400 WEBAUTHN_FAILED", async () => {
    const t = setup();
    const unknown = await t.call("POST", "/auth/register/verify", {
      body: { response: regResponse({ challenge: "nope" }, "p1") },
    });
    expect(unknown.status).toBe(400);
    expect(await code(unknown)).toBe("WEBAUTHN_FAILED");

    const options = await (await t.call("POST", "/auth/register/options")).json();
    const failed = await t.call("POST", "/auth/register/verify", {
      body: { response: regResponse(options, "p1", "output", { fail: true }) },
    });
    expect(failed.status).toBe(400);
    const reuse = await t.call("POST", "/auth/register/verify", {
      body: { response: regResponse(options, "p1") },
    });
    expect(reuse.status).toBe(400);

    const second = await (await t.call("POST", "/auth/register/options")).json();
    t.clock.advance(5 * MIN);
    const expired = await t.call("POST", "/auth/register/verify", {
      body: { response: regResponse(second, "p1") },
    });
    expect(expired.status).toBe(400);
    expect(await code(expired)).toBe("WEBAUTHN_FAILED");
  });

  it("challenge は 101 件目で最古のものが捨てられる", async () => {
    const t = setup();
    const all: Json[] = [];
    for (let i = 0; i < 101; i++) {
      all.push(await (await t.call("POST", "/auth/register/options")).json());
    }
    const first = await t.call("POST", "/auth/register/verify", {
      body: { response: regResponse(all[0], "p1") },
    });
    expect(first.status).toBe(400);
    const last = await t.call("POST", "/auth/register/verify", {
      body: { response: regResponse(all[100], "p1") },
    });
    expect(last.status).toBe(201);
  });

  it("サインイン用の challenge を登録に使えない。入力の形が違えば 400 VALIDATION", async () => {
    const t = setup();
    const options = await (await t.call("POST", "/auth/sign-in/options")).json();
    const res = await t.call("POST", "/auth/register/verify", {
      body: { response: regResponse(options, "p1") },
    });
    expect(res.status).toBe(400);
    const bad = await t.call("POST", "/auth/register/verify", { body: { name: "x" } });
    expect(bad.status).toBe(400);
    expect(await code(bad)).toBe("VALIDATION");
  });
});

describe("status", () => {
  it("未設定 → 設定後（サインイン中）→ 施錠後", async () => {
    const t = setup();
    expect(await t.status()).toEqual({
      registered: false,
      signedIn: false,
      rpId: "localhost",
      remote: { enabled: true, host: REMOTE_HOST },
      recoveryAcknowledged: null,
    });
    const { cookie } = await t.registerFirst();
    expect(await t.status()).toMatchObject({ registered: true, signedIn: false });
    expect(await t.status(cookie)).toMatchObject({
      registered: true,
      signedIn: true,
      recoveryAcknowledged: false,
    });
    await t.signOut(cookie);
    expect(await t.status(cookie)).toMatchObject({
      registered: true,
      signedIn: false,
      recoveryAcknowledged: null,
    });
  });

  it("ts.net の Host では rpId がその名前。別の RP ID のセッションは未サインイン。127.0.0.1:8787 は localhost", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst();
    expect(await t.status(cookie, REMOTE_HOST)).toMatchObject({
      rpId: REMOTE_HOST,
      signedIn: false,
    });
    const res = await t.call("GET", "/auth/status", { host: "127.0.0.1:8787" });
    expect(res.status).toBe(200);
    expect((await res.json()).rpId).toBe("localhost");
  });

  it("acknowledge で false → true、回復キーの発行（再発行・回復の登録）で false に戻る", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst();
    expect((await t.call("POST", "/auth/recovery/acknowledge", { cookie })).status).toBe(204);
    expect((await t.status(cookie)).recoveryAcknowledged).toBe(true);
    const regen = await t.call("POST", "/auth/recovery/regenerate", { cookie });
    expect(regen.status).toBe(201);
    expect((await t.status(cookie)).recoveryAcknowledged).toBe(false);

    await t.call("POST", "/auth/recovery/acknowledge", { cookie });
    const { recoveryCode } = await regen.json();
    const rec = t.cookieOf(await t.recover(recoveryCode)) as string;
    const done = await t.recoveryRegister(rec, "p2");
    expect(done.status).toBe(201);
    expect((await t.status(t.cookieOf(done))).recoveryAcknowledged).toBe(false);
  });
});

describe("サインイン（解錠。D4.2）", () => {
  it("施錠中にパスキーで解錠: 200 と cookie。PRF の入力は資格情報ごとの salt。counter と sign_in を記録する", async () => {
    const t = setup();
    const first = await t.registerFirst("p1");
    await t.addPasskey(first.cookie, "p2");
    const dk = currentDk();
    await t.signOut(first.cookie);
    expect(isUnlocked()).toBe(false);

    t.clock.advance(MIN);
    const { res, cookie, options } = await t.signIn("p2");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    for (const id of ["p1", "p2"]) {
      const passkey = await store().getPasskey(id);
      expect(options.extensions.prf.evalByCredential[id].first).toBe(
        b64(passkey?.prfSalt ?? new Uint8Array()),
      );
    }
    expect(currentDk().equals(dk)).toBe(true);
    expect((await store().getPasskey("p2"))?.counter).toBe(1);
    expect((await store().getPasskey("p2"))?.lastUsedAt).toBe(t.clock.now());
    expect(await t.count("sign_in")).toBe(1);
    expect((await t.status(cookie)).signedIn).toBe(true);
    // 解錠したので帳簿の API が使える
    expect((await t.call("GET", "/entities", { cookie })).status).toBe(200);
  });

  it("誤った PRF の出力（署名は正しい）は 400 WEBAUTHN_FAILED。施錠のまま、DK を作らない", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    await t.signOut(cookie);
    const { res } = await t.signIn("p1", "wrong");
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("WEBAUTHN_FAILED");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(isUnlocked()).toBe(false);
    expect(await t.count("sign_in_failed")).toBe(1);
    expect((await store().getPasskey("p1"))?.counter).toBe(0);
  });

  it("PRF の出力がない応答は 400 PRF_UNSUPPORTED で、施錠のまま", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    await t.signOut(cookie);
    const { res } = await t.signIn("p1", "none");
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("PRF_UNSUPPORTED");
    expect(isUnlocked()).toBe(false);
  });

  it("包みの行を改ざんすると開けず 400。解錠中なら今の DK を保つ", async () => {
    const t = setup();
    await t.registerFirst("p1");
    const dk = currentDk();
    openAuth()
      .$client.prepare("UPDATE key_wraps SET tag = zeroblob(16) WHERE kind = 'passkey'")
      .run();
    const { res } = await t.signIn("p1");
    expect(res.status).toBe(400);
    expect(currentDk().equals(dk)).toBe(true);
  });

  it("検証の失敗・知らない credential・別の RP ID のパスキーは 400 WEBAUTHN_FAILED と sign_in_failed", async () => {
    const t = setup();
    await t.registerFirst("p1");
    await store().addPasskey(
      {
        id: "t1",
        publicKey: new Uint8Array([9]),
        counter: 0,
        rpId: REMOTE_HOST,
        transports: null,
        name: "remote",
        prfSalt: new Uint8Array(32),
        createdAt: t.clock.now(),
      },
      (await store().getPasskeyWrap("p1")) as never,
    );
    const before = await t.count("sign_in_failed");
    for (const [credId, extra] of [
      ["p1", { fail: true }],
      ["unknown", {}],
      ["t1", {}],
    ] as const) {
      const { res } = await t.signIn(credId, "output", extra);
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("WEBAUTHN_FAILED");
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(await t.count("sign_in_failed")).toBe(before + 3);
    expect(t.seen.allowed.at(-1)?.map((c) => c.id)).toEqual(["p1"]);
  });
});

describe("回復キー（D4.3・D5）", () => {
  it("誤りは 400 RECOVERY_INVALID で、毎回 1 秒待たせる。何回誤ってもロックしない", async () => {
    const t = setup();
    const { cookie, recoveryCode } = await t.registerFirst();
    await t.signOut(cookie);
    for (const wrong of ["AAAA-AAAA", "0000-0000-0000-0000-0000-0000-0000-0000", ""]) {
      const res = await t.recover(wrong);
      expect(res.status).toBe(400);
      if (wrong !== "") expect(await code(res)).toBe("RECOVERY_INVALID");
    }
    for (let i = 0; i < 10; i++) await t.recover("AAAA-AAAA");
    expect(t.delays).toEqual(Array(12).fill(1000));
    expect(await t.count("recovery_failed")).toBe(12);
    expect(isUnlocked()).toBe(false);

    const ok = await t.recover(recoveryCode.toLowerCase().replaceAll("-", " "));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(t.delays).toHaveLength(12);
    expect(isUnlocked()).toBe(true);
    expect(await t.count("recovery_used")).toBe(1);
  });

  it("回復の一時セッションは通常の API に使えない（status も未サインイン）", async () => {
    const t = setup();
    const { cookie, recoveryCode } = await t.registerFirst();
    await t.signOut(cookie);
    const rec = t.cookieOf(await t.recover(recoveryCode)) as string;
    expect((await t.call("GET", "/auth/passkeys", { cookie: rec })).status).toBe(401);
    expect((await t.call("GET", "/entities", { cookie: rec })).status).toBe(401);
    expect((await t.status(rec)).signedIn).toBe(false);
  });

  it("回復の登録: 新しいパスキーと新しい回復キー。古いキーは RECOVERY_INVALID、全権のセッションに替わる", async () => {
    const t = setup();
    const { cookie, recoveryCode: oldKey } = await t.registerFirst("p1");
    const dk = currentDk();
    await t.signOut(cookie);
    const rec = t.cookieOf(await t.recover(oldKey)) as string;

    const done = await t.recoveryRegister(rec, "p2");
    expect(done.status).toBe(201);
    const { recoveryCode: newKey } = await done.json();
    expect(newKey).toMatch(KEY_FORMAT);
    expect(newKey).not.toBe(oldKey);
    const normal = t.cookieOf(done) as string;
    expect(normal).not.toBe(rec);
    expect((await dkByRecovery(newKey))?.equals(dk)).toBe(true);
    expect((await dkByPasskey("p2"))?.equals(dk)).toBe(true);
    expect(await dkByRecovery(oldKey)).toBeNull();

    expect((await t.call("POST", "/auth/recovery/register/options", { cookie: rec })).status).toBe(
      401,
    );
    const list = await t.call("GET", "/auth/passkeys", { cookie: normal });
    expect(list.status).toBe(200);
    expect((await list.json()).passkeys.map((p: { id: string }) => p.id).sort()).toEqual([
      "p1",
      "p2",
    ]);
    const session = await store().findSessionByTokenHash(hashToken(normal.split("=")[1] ?? ""));
    expect(session).toMatchObject({ kind: "normal", passkeyId: "p2" });
    expect(await t.count("recovery_regenerated")).toBe(1);

    await t.signOut(normal);
    expect(await code(await t.recover(oldKey))).toBe("RECOVERY_INVALID");
    expect((await t.signIn("p2")).res.status).toBe(200);
  });

  it("回復の登録の prf_required の流れ", async () => {
    const t = setup();
    const { cookie, recoveryCode } = await t.registerFirst("p1");
    await t.signOut(cookie);
    const rec = t.cookieOf(await t.recover(recoveryCode)) as string;
    const done = await t.recoveryRegister(rec, "p2", { prf: "enabled" });
    expect(done.status).toBe(201);
    expect((await dkByPasskey("p2"))?.equals(currentDk())).toBe(true);
  });

  it("回復の登録の失敗（検証・PRF なし・既存の ID）では、回復キーも一時セッションも変えず、やり直せる", async () => {
    const t2 = setup();
    const first = await t2.registerFirst("p1");
    await t2.signOut(first.cookie);
    const rec2 = t2.cookieOf(await t2.recover(first.recoveryCode)) as string;
    const before = await store().getRecoveryWrap();
    const bad = await t2.recoveryRegister(rec2, "p2", { prf: "none" });
    expect(await code(bad)).toBe("PRF_UNSUPPORTED");
    const dup = await t2.recoveryRegister(rec2, "p1");
    expect(dup.status).toBe(400);
    expect(await code(dup)).toBe("WEBAUTHN_FAILED");
    const options = await (
      await t2.call("POST", "/auth/recovery/register/options", { cookie: rec2 })
    ).json();
    const verifyFail = await t2.call("POST", "/auth/recovery/register/verify", {
      cookie: rec2,
      body: { response: regResponse(options, "p2", "output", { fail: true }) },
    });
    expect(await code(verifyFail)).toBe("WEBAUTHN_FAILED");
    expect((await store().getRecoveryWrap())?.id).toBe(before?.id);
    expect(await store().listPasskeys()).toHaveLength(1);
    expect((await t2.recoveryRegister(rec2, "p2")).status).toBe(201);
  });

  it("回復の一時セッションは 10 分で切れる。切れたら（ほかにセッションがなければ）施錠する", async () => {
    const t = setup();
    const { cookie, recoveryCode } = await t.registerFirst();
    await t.signOut(cookie);
    const rec = t.cookieOf(await t.recover(recoveryCode)) as string;
    t.clock.advance(10 * MIN - 1);
    expect((await t.call("POST", "/auth/recovery/register/options", { cookie: rec })).status).toBe(
      200,
    );
    t.clock.advance(1);
    expect((await t.call("POST", "/auth/recovery/register/options", { cookie: rec })).status).toBe(
      401,
    );
  });

  it("別の一時セッションで作った challenge は使えない", async () => {
    const t = setup();
    const { cookie, recoveryCode } = await t.registerFirst();
    await t.signOut(cookie);
    const a = t.cookieOf(await t.recover(recoveryCode)) as string;
    const b = t.cookieOf(await t.recover(recoveryCode)) as string;
    const options = await (
      await t.call("POST", "/auth/recovery/register/options", { cookie: a })
    ).json();
    const res = await t.call("POST", "/auth/recovery/register/verify", {
      cookie: b,
      body: { response: regResponse(options, "p2") },
    });
    expect(res.status).toBe(400);
  });
});

describe("再認証（D4.4。5 分）", () => {
  it("パスキーで入った直後は 5 分間そのまま使える。過ぎると追加・削除・再発行が 403 REAUTH_REQUIRED", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    expect((await t.call("POST", "/auth/passkeys/options", { cookie })).status).toBe(200);
    t.clock.advance(5 * MIN);
    const cases: [string, string, unknown?][] = [
      ["POST", "/auth/passkeys/options"],
      ["POST", "/auth/passkeys/verify", { response: regResponse({ challenge: "x" }, "p2") }],
      ["DELETE", "/auth/passkeys/p1"],
      ["POST", "/auth/recovery/regenerate"],
    ];
    for (const [method, path, body] of cases) {
      const res = await t.call(method, path, { cookie, ...(body ? { body } : {}) });
      expect(res.status, path).toBe(403);
      expect(await code(res)).toBe("REAUTH_REQUIRED");
    }
    // 名前の変更・一覧は再認証を求めない
    expect((await t.call("GET", "/auth/passkeys", { cookie })).status).toBe(200);
  });

  it("reauth の options・verify で 5 分間また使える。失敗・別のセッションの challenge は 400", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    t.clock.advance(5 * MIN);
    const failed = await t.reauth(cookie, "p1", { fail: true });
    expect(failed.status).toBe(400);
    expect(await code(failed)).toBe("WEBAUTHN_FAILED");

    const other = await createTestSession({ now: t.clock.now() });
    const options = await (
      await t.call("POST", "/auth/reauth/options", { cookie: other.cookie })
    ).json();
    const cross = await t.call("POST", "/auth/reauth/verify", {
      cookie,
      body: { response: authResponse(options, "p1", "none") },
    });
    expect(cross.status).toBe(400);

    expect((await t.reauth(cookie, "p1")).status).toBe(204);
    expect((await t.call("POST", "/auth/passkeys/options", { cookie })).status).toBe(200);
    t.clock.advance(5 * MIN - 1);
    expect((await t.call("POST", "/auth/recovery/regenerate", { cookie })).status).toBe(201);
    t.clock.advance(1);
    expect((await t.call("POST", "/auth/recovery/regenerate", { cookie })).status).toBe(403);
  });

  it("パスキーを通らずに作ったセッションは、再認証の前は 403", async () => {
    const t = setup();
    await t.registerFirst("p1");
    const s = await createTestSession({ now: t.clock.now() });
    const res = await t.call("POST", "/auth/passkeys/options", { cookie: s.cookie });
    expect(res.status).toBe(403);
    expect((await t.reauth(s.cookie, "p1")).status).toBe(204);
    expect((await t.call("POST", "/auth/passkeys/options", { cookie: s.cookie })).status).toBe(200);
  });
});

describe("パスキーの追加・削除（D4.4、INV-53）", () => {
  it("追加: 201 と表示用の値。包みを作り、そのパスキーで解錠できる", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1", { name: "A" });
    const added = await t.addPasskey(cookie, "p2");
    expect(added.status).toBe(201);
    const { passkey } = await added.json();
    expect(passkey).toMatchObject({ id: "p2", rpId: "localhost", lastUsedAt: null });
    expect(Object.keys(passkey).sort()).toEqual(["createdAt", "id", "lastUsedAt", "name", "rpId"]);
    expect(t.seen.excluded.at(-1)?.map((c) => c.id)).toEqual(["p1"]);
    expect((await dkByPasskey("p2"))?.equals(currentDk())).toBe(true);

    const renamed = await t.call("PATCH", "/auth/passkeys/p2", {
      cookie,
      body: { name: "iPhone" },
    });
    expect(renamed.status).toBe(200);
    expect(await t.count("passkey_renamed")).toBe(1);
    expect(await t.count("register")).toBe(2);
    expect(
      (await t.call("PATCH", "/auth/passkeys/p2", { cookie, body: { name: "" } })).status,
    ).toBe(400);
  });

  it("追加の prf_required の流れ。PRF なし・検証の失敗は 400 で、何も増えない", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    expect((await t.addPasskey(cookie, "p2", { prf: "enabled" })).status).toBe(201);
    const none = await t.addPasskey(cookie, "p3", { prf: "none" });
    expect(await code(none)).toBe("PRF_UNSUPPORTED");
    const options = await (await t.call("POST", "/auth/passkeys/options", { cookie })).json();
    const failed = await t.call("POST", "/auth/passkeys/verify", {
      cookie,
      body: { response: regResponse(options, "p4", "output", { fail: true }) },
    });
    expect(await code(failed)).toBe("WEBAUTHN_FAILED");
    const dup = await t.addPasskey(cookie, "p1");
    expect(await code(dup)).toBe("WEBAUTHN_FAILED");
    expect((await store().listPasskeys()).map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  it("削除: 最後の 1 本は 409 LAST_PASSKEY。2 本なら 204 で、その包みも消える", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    const last = await t.call("DELETE", "/auth/passkeys/p1", { cookie });
    expect(last.status).toBe(409);
    expect(await code(last)).toBe("LAST_PASSKEY");

    await t.addPasskey(cookie, "p2");
    expect(await store().getPasskeyWrap("p2")).toBeDefined();
    expect((await t.call("DELETE", "/auth/passkeys/p2", { cookie })).status).toBe(204);
    expect(await store().getPasskeyWrap("p2")).toBeUndefined();
    expect(await store().getPasskeyWrap("p1")).toBeDefined();
    expect(await t.count("passkey_deleted")).toBe(1);
    // 存在しない ID は 204（何も変えない）
    expect((await t.call("DELETE", "/auth/passkeys/zzz", { cookie })).status).toBe(204);
    expect(await t.count("passkey_deleted")).toBe(1);
  });

  it("削除したパスキーのセッションは 401。最後のセッションが消えたら施錠する", async () => {
    const t = setup();
    const a = await t.registerFirst("p1");
    await t.addPasskey(a.cookie, "p2");
    const b = await t.signIn("p2");
    const del = await t.call("DELETE", "/auth/passkeys/p1", { cookie: b.cookie });
    expect(del.status).toBe(204);
    expect((await t.call("GET", "/auth/passkeys", { cookie: a.cookie })).status).toBe(401);
    expect(isUnlocked()).toBe(true);
    const revoked = (await t.events()).filter((e) => e.kind === "session_revoked");
    expect(revoked).toHaveLength(1);

    await t.call("POST", "/auth/reauth/options", { cookie: b.cookie });
    expect((await t.reauth(b.cookie, "p2")).status).toBe(204);
    await t.addPasskey(b.cookie, "p3");
    const own = await t.call("DELETE", "/auth/passkeys/p2", { cookie: b.cookie });
    expect(own.status).toBe(204);
    expect(isUnlocked()).toBe(false);
  });

  it("回復キーの再発行: 古いキーは開けず、新しいキーで同じ DK", async () => {
    const t = setup();
    const { cookie, recoveryCode: oldKey } = await t.registerFirst();
    const res = await t.call("POST", "/auth/recovery/regenerate", { cookie });
    expect(res.status).toBe(201);
    const { recoveryCode } = await res.json();
    expect(recoveryCode).toMatch(KEY_FORMAT);
    expect(await dkByRecovery(oldKey)).toBeNull();
    expect((await dkByRecovery(recoveryCode))?.equals(currentDk())).toBe(true);
    expect(await t.count("recovery_regenerated")).toBe(1);
    expect(
      (
        openAuth()
          .$client.prepare("SELECT count(*) AS n FROM key_wraps WHERE kind = 'recovery'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });
});

describe("施錠とセッション（D3・D4.5）", () => {
  it("sign-out は 204 で、全セッションを消して施錠する。cookie を消し sign_out を記録する", async () => {
    const t = setup();
    const a = await t.registerFirst("p1");
    const b = await t.signIn("p1");
    const res = await t.signOut(a.cookie);
    expect(res.status).toBe(204);
    expect(t.cookieOf(res)).toBeUndefined();
    expect(res.headers.getSetCookie().some((s) => s.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(isUnlocked()).toBe(false);
    expect(
      (openAuth().$client.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n,
    ).toBe(0);
    for (const cookie of [a.cookie, b.cookie]) {
      const after = await t.call("GET", "/auth/passkeys", { cookie });
      expect(after.status).toBe(401);
      expect(await code(after)).toBe("UNAUTHENTICATED");
    }
    expect(await t.count("sign_out")).toBe(1);
  });

  it("セッションの一覧（current つき）と失効。最後のセッションを失効すると施錠する", async () => {
    const t = setup();
    const a = await t.registerFirst("p1");
    const b = await t.signIn("p1");
    const listA = await (await t.call("GET", "/auth/sessions", { cookie: a.cookie })).json();
    expect(listA.sessions).toHaveLength(2);
    const bId = listA.sessions.find((s: { current: boolean }) => !s.current).id;
    expect((await t.call("DELETE", `/auth/sessions/${bId}`, { cookie: a.cookie })).status).toBe(
      204,
    );
    expect((await t.call("GET", "/auth/sessions", { cookie: b.cookie })).status).toBe(401);
    expect(isUnlocked()).toBe(true);
    expect((await t.call("DELETE", "/auth/sessions/none", { cookie: a.cookie })).status).toBe(204);

    const aId = listA.sessions.find((s: { current: boolean }) => s.current).id;
    expect((await t.call("DELETE", `/auth/sessions/${aId}`, { cookie: a.cookie })).status).toBe(
      204,
    );
    expect(isUnlocked()).toBe(false);
  });

  it("新しいセッションを入れてから期限切れを掃除する（期限切れのセッションしかない解錠中でも、入った直後に施錠しない）", async () => {
    const t = setup();
    const a = await t.registerFirst("p1");
    t.clock.advance(31 * MIN);
    const b = await t.signIn("p1");
    expect(b.res.status).toBe(200);
    expect(isUnlocked()).toBe(true);
    expect((await t.call("GET", "/auth/passkeys", { cookie: b.cookie })).status).toBe(200);
    expect((await t.call("GET", "/auth/passkeys", { cookie: a.cookie })).status).toBe(401);
  });
});

describe("公開の手続きの前提", () => {
  it("recovery/register/* は cookie なし・通常のセッションで 401 UNAUTHENTICATED", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst();
    for (const path of ["/auth/recovery/register/options", "/auth/recovery/register/verify"]) {
      for (const c of [undefined, cookie]) {
        const res = await t.call("POST", path, {
          ...(c ? { cookie: c } : {}),
          body: { response: regResponse({ challenge: "x" }, "z") },
        });
        expect(res.status, path).toBe(401);
        expect(await code(res)).toBe("UNAUTHENTICATED");
      }
    }
  });

  it("要サインインのルートは未サインインで 401", async () => {
    const t = setup();
    await t.registerFirst();
    const cases: [string, string][] = [
      ["POST", "/auth/sign-out"],
      ["POST", "/auth/reauth/options"],
      ["POST", "/auth/reauth/verify"],
      ["GET", "/auth/passkeys"],
      ["POST", "/auth/passkeys/options"],
      ["POST", "/auth/passkeys/verify"],
      ["PATCH", "/auth/passkeys/p1"],
      ["DELETE", "/auth/passkeys/p1"],
      ["POST", "/auth/recovery/regenerate"],
      ["POST", "/auth/recovery/acknowledge"],
      ["GET", "/auth/sessions"],
      ["DELETE", "/auth/sessions/x"],
      ["GET", "/auth/events"],
    ];
    for (const [method, path] of cases) {
      const res = await t.call(method, path, method === "GET" ? {} : { body: {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("auth_events", () => {
  it("要求ごとに増え、新しい順に ?limit= で取れる。更新・削除できない", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    t.clock.advance(1000);
    await t.signIn("p1");
    t.clock.advance(1000);
    await t.signIn("p1", "output", { fail: true });
    const all = await (await t.call("GET", "/auth/events", { cookie })).json();
    expect(all.events.map((e: { kind: string }) => e.kind)).toEqual([
      "sign_in_failed",
      "sign_in",
      "register",
    ]);
    expect(all.events[2]).toMatchObject({ rpId: "localhost", passkeyId: "p1" });
    expect(
      (await (await t.call("GET", "/auth/events?limit=2", { cookie })).json()).events,
    ).toHaveLength(2);
    expect((await t.call("GET", "/auth/events?limit=0", { cookie })).status).toBe(400);
    const db = openAuth();
    expect(() => db.$client.prepare("UPDATE auth_events SET kind = 'sign_in'").run()).toThrow();
    expect(() => db.$client.prepare("DELETE FROM auth_events").run()).toThrow();
  });
});

describe("秘密を出さない（INV-51）", () => {
  it("応答・auth_events・ログに、回復キー・DK・PRF の出力・セッションのトークンが出ない", async () => {
    const spies = (["log", "error", "warn", "info"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const t = setup();
    const bodies: string[] = [];
    const collect = async (res: Response) => {
      bodies.push(await res.clone().text());
      return res;
    };
    const a = await t.registerFirst("p1");
    const passkey = await store().getPasskey("p1");
    const secrets = [
      currentDk().toString("hex"),
      currentDk().toString("base64url"),
      b64(prfOf("p1", b64(passkey?.prfSalt ?? new Uint8Array()))),
      a.recoveryCode.replaceAll("-", ""),
      a.cookie.split("=")[1] ?? "",
    ];
    const b = await t.signIn("p1");
    await collect(b.res);
    secrets.push(b.cookie.split("=")[1] ?? "");
    for (let i = 0; i < 2; i++) await collect(await t.recover("WRONG-WRONG"));
    const rec = await collect(await t.recover(a.recoveryCode));
    secrets.push((t.cookieOf(rec) as string).split("=")[1] ?? "");
    for (const path of ["/auth/status", "/auth/sessions", "/auth/passkeys", "/auth/events"]) {
      await collect(await t.call("GET", path, { cookie: b.cookie }));
    }
    await t.signOut(b.cookie);
    clearDataKey();

    const events = JSON.stringify(await t.events());
    const logs = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(10);
      for (const text of [...bodies, events, logs]) expect(text).not.toContain(secret);
    }
    expect(events).not.toContain(a.recoveryCode);
  });
});

describe("本物の WebAuthn の options（@simplewebauthn/server）", () => {
  it("登録は residentKey・userVerification が required で、PRF の eval.first に salt を入れる", async () => {
    const salt = b64(Buffer.alloc(32, 1));
    const options = await simpleWebAuthnVerifier.registrationOptions({
      rpId: "localhost",
      excluded: [],
      prfSalt: salt,
    });
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    expect((options.extensions as Json).prf.eval.first).toBe(salt);
  });

  it("認証は資格情報ごとの salt を evalByCredential に入れる。salt がなければ extensions を付けない", async () => {
    const salt = b64(Buffer.alloc(32, 2));
    const options = await simpleWebAuthnVerifier.authenticationOptions({
      rpId: "localhost",
      allowed: [{ id: "cred" }],
      prfSalts: { cred: salt },
    });
    expect((options.extensions as Json).prf.evalByCredential).toEqual({ cred: { first: salt } });
    const plain = await simpleWebAuthnVerifier.authenticationOptions({
      rpId: "localhost",
      allowed: [],
    });
    expect(plain.extensions).toBeUndefined();
  });
});
