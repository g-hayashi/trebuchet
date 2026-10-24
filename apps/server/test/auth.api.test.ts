import { randomUUID } from "node:crypto";
import { DrizzleAuthStore, hashToken, openRegistry } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { SESSION_COOKIE } from "../src/lib/session.ts";
import type { CredentialRef, WebAuthnVerifier } from "../src/lib/webauthn.ts";
import { createTestSession, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";

// T008: 認証のルート（登録・サインイン・回復・パスキー・セッション・記録）。
// WebAuthn の検証は偽物に差し替える（本物の認証器の応答は作らない）

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
const store = () => new DrizzleAuthStore(openRegistry());

function makeClock() {
  let ms = Date.parse("2026-10-20T00:00:00.000Z");
  return {
    now: () => new Date(ms).toISOString(),
    advance: (d: number) => {
      ms += d;
    },
  };
}

/**
 * 偽の WebAuthnVerifier。応答は `{ challenge, credId, fail? }`。
 * 本物と同じく、応答の challenge を expectedChallenge に渡して確かめる
 */
function fakeVerifier() {
  const seen = {
    registrations: [] as { origin: string; rpId: string }[],
    allowed: [] as CredentialRef[][],
    excluded: [] as CredentialRef[][],
  };
  const verifier: WebAuthnVerifier = {
    async registrationOptions({ rpId, excluded }) {
      seen.excluded.push(excluded);
      return {
        challenge: `reg-${randomUUID()}`,
        rp: { id: rpId, name: "t" },
        user: { id: "u", name: "owner", displayName: "owner" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      };
    },
    async verifyRegistration({ response, expectedChallenge, expectedOrigin, expectedRpId }) {
      seen.registrations.push({ origin: expectedOrigin, rpId: expectedRpId });
      if (!expectedChallenge(String(response.challenge))) throw new Error("challenge");
      if (response.fail === true) return null;
      return {
        id: String(response.credId),
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ["internal"],
      };
    },
    async authenticationOptions({ rpId, allowed }) {
      seen.allowed.push(allowed);
      return {
        challenge: `auth-${randomUUID()}`,
        rpId,
        allowCredentials: allowed.map((c) => ({ id: c.id, type: "public-key" as const })),
      };
    },
    async verifyAuthentication({ response, expectedChallenge, credential }) {
      if (!expectedChallenge(String(response.challenge))) throw new Error("challenge");
      if (response.fail === true) return null;
      return { newCounter: credential.counter + 1 };
    },
  };
  return { verifier, seen };
}

// biome-ignore lint/suspicious/noExplicitAny: テストが読む JSON は形を決めない
type Json = any;
/** `json()` が any を返す Response（先頭のシグネチャが優先される） */
type TestRes = { json(): Promise<Json> } & Response;

type CallOpts = {
  body?: unknown;
  cookie?: string;
  host?: string;
  headers?: Record<string, string>;
};

function setup() {
  const clock = makeClock();
  const { verifier, seen } = fakeVerifier();
  const app = createApp({
    clock,
    webauthn: verifier,
    getRemoteSettings: async () => ({ enabled: true, host: REMOTE_HOST }),
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

  /** 初回の登録（options → verify） */
  async function registerFirst(credId = "p1", name?: string) {
    const opt = await call("POST", "/auth/register/options");
    const { challenge } = await opt.json();
    const res = await call("POST", "/auth/register/verify", {
      body: { response: { challenge, credId }, ...(name === undefined ? {} : { name }) },
    });
    const body = await res.json();
    return { res, cookie: cookieOf(res) as string, recoveryCode: body.recoveryCode as string };
  }

  async function signIn(credId: string, extra: Record<string, unknown> = {}) {
    const opt = await call("POST", "/auth/sign-in/options");
    const { challenge } = await opt.json();
    const res = await call("POST", "/auth/sign-in/verify", {
      // 本物の応答と同じく、使った認証器の ID は response.id
      body: { response: { challenge, id: credId, ...extra } },
    });
    return { res, cookie: cookieOf(res) as string };
  }

  /** サインイン済みでパスキーを足す */
  async function addPasskey(cookie: string, credId: string, extra: Record<string, unknown> = {}) {
    const opt = await call("POST", "/auth/passkeys/options", { cookie });
    const { challenge } = await opt.json();
    return call("POST", "/auth/passkeys/verify", {
      cookie,
      body: { response: { challenge, credId, ...extra } },
    });
  }

  const recover = (code: string) => call("POST", "/auth/recovery/verify", { body: { code } });

  /** 回復用の一時セッションでパスキーを登録する */
  async function recoveryRegister(
    cookie: string,
    credId: string,
    extra: Record<string, unknown> = {},
  ) {
    const opt = await call("POST", "/auth/recovery/register/options", { cookie });
    const { challenge } = await opt.json();
    return call("POST", "/auth/recovery/register/verify", {
      cookie,
      body: { response: { challenge, credId, ...extra } },
    });
  }

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
    call,
    cookieOf,
    registerFirst,
    signIn,
    addPasskey,
    recover,
    recoveryRegister,
    status,
    events,
    count,
  };
}

const CODE_FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}-[0-9A-HJKMNP-TV-Z]{2}$/;
const code = (res: { json(): Promise<unknown> }) =>
  res.json().then((b) => (b as { error: { code: string } }).error.code);

describe("初回の登録（FR-001・002）", () => {
  it("201 と cookie と回復コードの形。RP ID と origin は lib/origin.ts で決まる", async () => {
    const t = setup();
    const { res, recoveryCode } = await t.registerFirst("p1", "MacBook");
    expect(res.status).toBe(201);
    expect(recoveryCode).toMatch(CODE_FORMAT);
    const setCookie = res.headers.getSetCookie().find((s) => s.startsWith(`${SESSION_COOKIE}=`));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(t.seen.registrations).toEqual([{ origin: TEST_ORIGIN, rpId: "localhost" }]);

    const passkeys = await store().listPasskeys();
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0]).toMatchObject({ id: "p1", name: "MacBook", rpId: "localhost" });
    expect(await t.count("register")).toBe(1);
  });

  it("名前を省略したときは既定の名前が付く", async () => {
    const t = setup();
    await t.registerFirst("p1");
    expect((await store().listPasskeys())[0]?.name).not.toBe("");
  });

  it("作ったセッションは作ったパスキーの passkey_id を持ち、回復コードはハッシュだけを保存する", async () => {
    const t = setup();
    const { cookie, recoveryCode } = await t.registerFirst("p1");
    const token = cookie.split("=")[1] ?? "";
    const session = await store().findSessionByTokenHash(hashToken(token));
    expect(session).toMatchObject({ kind: "normal", passkeyId: "p1", rpId: "localhost" });
    const active = await store().getActiveRecoveryCode();
    expect(active?.codeHash).toBe(hashToken(recoveryCode.replaceAll("-", "")));
    expect(active?.codeHash).not.toContain(recoveryCode);
  });

  it("2 回目の options・verify は 409 ALREADY_REGISTERED", async () => {
    const t = setup();
    await t.registerFirst();
    const opt = await t.call("POST", "/auth/register/options");
    expect(opt.status).toBe(409);
    expect(await code(opt)).toBe("ALREADY_REGISTERED");
    const ver = await t.call("POST", "/auth/register/verify", {
      body: { response: { challenge: "x", credId: "p2" } },
    });
    expect(ver.status).toBe(409);
  });

  it("ts.net の Host からの登録は 421 HOST_NOT_ALLOWED（options も verify も）", async () => {
    const t = setup();
    const opt = await t.call("POST", "/auth/register/options", { host: REMOTE_HOST });
    expect(opt.status).toBe(421);
    expect(await code(opt)).toBe("HOST_NOT_ALLOWED");
    const ver = await t.call("POST", "/auth/register/verify", {
      host: REMOTE_HOST,
      body: { response: { challenge: "x", credId: "p1" } },
    });
    expect(ver.status).toBe(421);
    expect(await store().listPasskeys()).toHaveLength(0);
  });

  it("検証の失敗は 400 WEBAUTHN_FAILED。パスキーも記録も増えない", async () => {
    const t = setup();
    const { challenge } = await (await t.call("POST", "/auth/register/options")).json();
    const res = await t.call("POST", "/auth/register/verify", {
      body: { response: { challenge, credId: "p1", fail: true } },
    });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("WEBAUTHN_FAILED");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await store().listPasskeys()).toHaveLength(0);
  });

  it("知らない challenge・使い済みの challenge・5 分過ぎた challenge は 400 WEBAUTHN_FAILED", async () => {
    const t = setup();
    const unknown = await t.call("POST", "/auth/register/verify", {
      body: { response: { challenge: "nope", credId: "p1" } },
    });
    expect(unknown.status).toBe(400);
    expect(await code(unknown)).toBe("WEBAUTHN_FAILED");

    const { challenge } = await (await t.call("POST", "/auth/register/options")).json();
    const failed = await t.call("POST", "/auth/register/verify", {
      body: { response: { challenge, credId: "p1", fail: true } },
    });
    expect(failed.status).toBe(400);
    // 失敗でも challenge は破棄されている（同じ challenge の再利用は成功しない）
    const reuse = await t.call("POST", "/auth/register/verify", {
      body: { response: { challenge, credId: "p1" } },
    });
    expect(reuse.status).toBe(400);

    const second = await (await t.call("POST", "/auth/register/options")).json();
    t.clock.advance(5 * 60 * 1000);
    const expired = await t.call("POST", "/auth/register/verify", {
      body: { response: { challenge: second.challenge, credId: "p1" } },
    });
    expect(expired.status).toBe(400);
    expect(await code(expired)).toBe("WEBAUTHN_FAILED");
  });

  it("challenge は 101 件目で最古のものが捨てられ、その検証が 400 WEBAUTHN_FAILED", async () => {
    const t = setup();
    const challenges: string[] = [];
    for (let i = 0; i < 101; i++) {
      const res = await t.call("POST", "/auth/register/options");
      challenges.push((await res.json()).challenge);
    }
    const first = await t.call("POST", "/auth/register/verify", {
      body: { response: { challenge: challenges[0], credId: "p1" } },
    });
    expect(first.status).toBe(400);
    expect(await code(first)).toBe("WEBAUTHN_FAILED");
    const last = await t.call("POST", "/auth/register/verify", {
      body: { response: { challenge: challenges[100], credId: "p1" } },
    });
    expect(last.status).toBe(201);
  });

  it("サインイン用の challenge を登録に使えない", async () => {
    const t = setup();
    const { challenge } = await (await t.call("POST", "/auth/sign-in/options")).json();
    const res = await t.call("POST", "/auth/register/verify", {
      body: { response: { challenge, credId: "p1" } },
    });
    expect(res.status).toBe(400);
  });

  it("入力の形が違えば 400 VALIDATION", async () => {
    const t = setup();
    const res = await t.call("POST", "/auth/register/verify", { body: { name: "x" } });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("VALIDATION");
  });
});

describe("status（FR-001・007）", () => {
  it("未登録 → 登録後（サインイン中）の値", async () => {
    const t = setup();
    expect(await t.status()).toEqual({
      registered: false,
      signedIn: false,
      rpId: "localhost",
      remote: { enabled: true, host: REMOTE_HOST },
      recoveryAcknowledged: null,
    });
    const { cookie } = await t.registerFirst();
    expect(await t.status()).toMatchObject({
      registered: true,
      signedIn: false,
      recoveryAcknowledged: null,
    });
    expect(await t.status(cookie)).toMatchObject({
      registered: true,
      signedIn: true,
      recoveryAcknowledged: false,
    });
  });

  it("ts.net の Host では rpId がその名前。別の RP ID のセッションは未サインイン", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst();
    const remote = await t.status(cookie, REMOTE_HOST);
    expect(remote).toMatchObject({ rpId: REMOTE_HOST, signedIn: false });
  });

  it("127.0.0.1:8787 でも 200 で rpId は localhost", async () => {
    const t = setup();
    const res = await t.call("GET", "/auth/status", { host: "127.0.0.1:8787" });
    expect(res.status).toBe(200);
    expect((await res.json()).rpId).toBe("localhost");
  });

  it("acknowledge で false → true、コードの発行（作り直し・回復用の登録）で false に戻る", async () => {
    const t = setup();
    const { cookie, recoveryCode } = await t.registerFirst();
    expect((await t.status(cookie)).recoveryAcknowledged).toBe(false);

    const ack = await t.call("POST", "/auth/recovery/acknowledge", { cookie });
    expect(ack.status).toBe(204);
    expect((await t.status(cookie)).recoveryAcknowledged).toBe(true);

    const regen = await t.call("POST", "/auth/recovery/regenerate", { cookie });
    expect(regen.status).toBe(201);
    expect((await t.status(cookie)).recoveryAcknowledged).toBe(false);

    await t.call("POST", "/auth/recovery/acknowledge", { cookie });
    expect((await t.status(cookie)).recoveryAcknowledged).toBe(true);
    const { recoveryCode: current } = await regen.json();
    expect(current).not.toBe(recoveryCode);
    const rec = await t.recover(current);
    const recCookie = t.cookieOf(rec) as string;
    const done = await t.recoveryRegister(recCookie, "p2");
    expect(done.status).toBe(201);
    const normal = t.cookieOf(done) as string;
    expect((await t.status(normal)).recoveryAcknowledged).toBe(false);
  });
});

describe("サインイン（FR-003）", () => {
  it("成功: 200 と cookie。counter と last_used_at を更新し sign_in を記録する", async () => {
    const t = setup();
    await t.registerFirst("p1");
    t.clock.advance(60_000);
    const { res, cookie } = await t.signIn("p1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cookie).toBeDefined();
    const passkey = await store().getPasskey("p1");
    expect(passkey?.counter).toBe(1);
    expect(passkey?.lastUsedAt).toBe(t.clock.now());
    expect(await t.count("sign_in")).toBe(1);
    expect((await t.status(cookie)).signedIn).toBe(true);
  });

  it("options はこの RP ID のパスキーだけを allowCredentials に入れる", async () => {
    const t = setup();
    await t.registerFirst("p1");
    await store().addPasskey({
      id: "t1",
      publicKey: new Uint8Array([9]),
      counter: 0,
      rpId: REMOTE_HOST,
      transports: null,
      name: "remote",
      createdAt: t.clock.now(),
    });
    await t.call("POST", "/auth/sign-in/options");
    expect(t.seen.allowed.at(-1)?.map((c) => c.id)).toEqual(["p1"]);
  });

  it("検証の失敗・知らない credential・別の RP ID のパスキーは 400 WEBAUTHN_FAILED と sign_in_failed", async () => {
    const t = setup();
    await t.registerFirst("p1");
    await store().addPasskey({
      id: "t1",
      publicKey: new Uint8Array([9]),
      counter: 0,
      rpId: REMOTE_HOST,
      transports: null,
      name: "remote",
      createdAt: t.clock.now(),
    });
    const before = await t.count("sign_in_failed");
    for (const [credId, extra] of [
      ["p1", { fail: true }],
      ["unknown", {}],
      ["t1", {}],
    ] as const) {
      const { res } = await t.signIn(credId, extra);
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("WEBAUTHN_FAILED");
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(await t.count("sign_in_failed")).toBe(before + 3);
    expect(await t.count("sign_in")).toBe(0);
    expect((await store().getPasskey("p1"))?.counter).toBe(0);
  });
});

describe("回復コード（FR-006、R7）", () => {
  it("誤りが 5 回で 429 RECOVERY_LOCKED。6 回目は正しくても 429 で recovery_failed が増えない。15 分で解ける", async () => {
    const t = setup();
    const { recoveryCode } = await t.registerFirst();
    for (let i = 0; i < 5; i++) {
      const res = await t.recover("AAAA-AAAA-AAAA");
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("RECOVERY_INVALID");
      t.clock.advance(1000);
    }
    expect(await t.count("recovery_failed")).toBe(5);

    const locked = await t.recover(recoveryCode);
    expect(locked.status).toBe(429);
    const body = await locked.json();
    expect(body.error.code).toBe("RECOVERY_LOCKED");
    expect(body.error.details.retryAfter).toBe(15 * 60 - 1);
    expect(locked.headers.getSetCookie()).toEqual([]);
    expect(await t.count("recovery_failed")).toBe(5);
    expect(await t.count("recovery_used")).toBe(0);

    t.clock.advance(15 * 60 * 1000 - 2000);
    expect((await t.recover(recoveryCode)).status).toBe(429);
    t.clock.advance(1000);
    const ok = await t.recover(recoveryCode);
    expect(ok.status).toBe(200);
    expect(await t.count("recovery_used")).toBe(1);
  });

  it("成功すると連続の失敗が切れる", async () => {
    const t = setup();
    const { recoveryCode } = await t.registerFirst();
    for (let i = 0; i < 4; i++) await t.recover("AAAA");
    expect((await t.recover(recoveryCode)).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await t.recover("AAAA")).status).toBe(400);
    }
  });

  it("verify に成功しても回復コードは有効なまま（2 回続けて成功する）。入力の揺れも受ける", async () => {
    const t = setup();
    const { recoveryCode } = await t.registerFirst();
    const first = await t.recover(recoveryCode);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(t.cookieOf(first)).toBeDefined();
    const second = await t.recover(recoveryCode.toLowerCase().replaceAll("-", " "));
    expect(second.status).toBe(200);
    expect((await store().getActiveRecoveryCode())?.codeHash).toBe(
      hashToken(recoveryCode.replaceAll("-", "")),
    );
  });

  it("回復用の一時セッションは通常の API に使えない", async () => {
    const t = setup();
    const { recoveryCode } = await t.registerFirst();
    const cookie = t.cookieOf(await t.recover(recoveryCode)) as string;
    expect((await t.call("GET", "/auth/passkeys", { cookie })).status).toBe(401);
    expect((await t.call("POST", "/auth/recovery/regenerate", { cookie })).status).toBe(401);
    expect((await t.status(cookie)).signedIn).toBe(false);
  });

  it("回復用の登録の検証が失敗しても、回復コードと一時セッションが残り、再度の登録が成功する", async () => {
    const t = setup();
    const { recoveryCode } = await t.registerFirst();
    const cookie = t.cookieOf(await t.recover(recoveryCode)) as string;

    const failed = await t.recoveryRegister(cookie, "p2", { fail: true });
    expect(failed.status).toBe(400);
    expect(await code(failed)).toBe("WEBAUTHN_FAILED");
    expect((await store().getActiveRecoveryCode())?.codeHash).toBe(
      hashToken(recoveryCode.replaceAll("-", "")),
    );
    expect(await store().listPasskeys()).toHaveLength(1);

    const retried = await t.recoveryRegister(cookie, "p2");
    expect(retried.status).toBe(201);
  });

  it("回復用の登録の成功で、古いコードが RECOVERY_INVALID になり新しいコードが出る。通常のセッションに替わる", async () => {
    const t = setup();
    const { recoveryCode: oldCode } = await t.registerFirst();
    const recCookie = t.cookieOf(await t.recover(oldCode)) as string;

    const done = await t.recoveryRegister(recCookie, "p2");
    expect(done.status).toBe(201);
    const { recoveryCode: newCode } = await done.json();
    expect(newCode).toMatch(CODE_FORMAT);
    expect(newCode).not.toBe(oldCode);
    const normal = t.cookieOf(done) as string;
    expect(normal).toBeDefined();
    expect(normal).not.toBe(recCookie);

    const oldTry = await t.recover(oldCode);
    expect(oldTry.status).toBe(400);
    expect(await code(oldTry)).toBe("RECOVERY_INVALID");
    expect((await t.recover(newCode)).status).toBe(200);

    // 回復用の一時セッションは失効し、通常のセッションで入れる
    expect(
      (await t.call("POST", "/auth/recovery/register/options", { cookie: recCookie })).status,
    ).toBe(401);
    const list = await t.call("GET", "/auth/passkeys", { cookie: normal });
    expect(list.status).toBe(200);
    expect((await list.json()).passkeys.map((p: { id: string }) => p.id).sort()).toEqual([
      "p1",
      "p2",
    ]);
    const session = await store().findSessionByTokenHash(hashToken(normal.split("=")[1] ?? ""));
    expect(session).toMatchObject({ kind: "normal", passkeyId: "p2" });
    expect(await t.count("recovery_regenerated")).toBe(1);
  });

  it("すでにあるパスキーの ID の登録は 400 WEBAUTHN_FAILED", async () => {
    const t = setup();
    const { recoveryCode } = await t.registerFirst("p1");
    const cookie = t.cookieOf(await t.recover(recoveryCode)) as string;
    const res = await t.recoveryRegister(cookie, "p1");
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("WEBAUTHN_FAILED");
  });

  it("回復用の一時セッションは 10 分で切れる", async () => {
    const t = setup();
    const { recoveryCode } = await t.registerFirst();
    const cookie = t.cookieOf(await t.recover(recoveryCode)) as string;
    t.clock.advance(10 * 60 * 1000 - 1);
    expect((await t.call("POST", "/auth/recovery/register/options", { cookie })).status).toBe(200);
    t.clock.advance(1);
    expect((await t.call("POST", "/auth/recovery/register/options", { cookie })).status).toBe(401);
  });

  it("別のセッションで作った challenge は使えない", async () => {
    const t = setup();
    const { recoveryCode } = await t.registerFirst();
    const a = t.cookieOf(await t.recover(recoveryCode)) as string;
    const b = t.cookieOf(await t.recover(recoveryCode)) as string;
    const { challenge } = await (
      await t.call("POST", "/auth/recovery/register/options", { cookie: a })
    ).json();
    const res = await t.call("POST", "/auth/recovery/register/verify", {
      cookie: b,
      body: { response: { challenge, credId: "p2" } },
    });
    expect(res.status).toBe(400);
  });
});

describe("公開の手続きの前提（T007 の表を本物のルートで）", () => {
  it("recovery/register/* は cookie なし・通常のセッションで 401 UNAUTHENTICATED", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst();
    for (const path of ["/auth/recovery/register/options", "/auth/recovery/register/verify"]) {
      for (const c of [undefined, cookie]) {
        const res = await t.call("POST", path, {
          ...(c ? { cookie: c } : {}),
          body: { response: { challenge: "x", credId: "z" } },
        });
        expect(res.status, path).toBe(401);
        expect(await code(res)).toBe("UNAUTHENTICATED");
      }
    }
  });

  it("要サインインのルートは未サインインで 401（recovery/regenerate を含む）", async () => {
    const t = setup();
    await t.registerFirst();
    const cases: [string, string][] = [
      ["POST", "/auth/sign-out"],
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

describe("要サインインの操作（FR-004・005・007・013）", () => {
  it("sign-out は 204 でセッションを失効し cookie を消す。sign_out を記録する", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst();
    const res = await t.call("POST", "/auth/sign-out", { cookie });
    expect(res.status).toBe(204);
    expect(t.cookieOf(res)).toBeUndefined();
    expect(res.headers.getSetCookie().some((s) => s.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect((await t.call("GET", "/auth/passkeys", { cookie })).status).toBe(401);
    expect(await t.count("sign_out")).toBe(1);
  });

  it("パスキーの一覧・追加（今の接続先の RP ID）・名前の変更", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1", "A");
    const added = await t.addPasskey(cookie, "p2");
    expect(added.status).toBe(201);
    const { passkey } = await added.json();
    expect(passkey).toMatchObject({ id: "p2", rpId: "localhost", lastUsedAt: null });
    expect(Object.keys(passkey).sort()).toEqual(["createdAt", "id", "lastUsedAt", "name", "rpId"]);
    // 既存の認証器を除外する指定が渡る
    expect(t.seen.excluded.at(-1)?.map((c) => c.id)).toEqual(["p1"]);

    const renamed = await t.call("PATCH", "/auth/passkeys/p2", {
      cookie,
      body: { name: "iPhone" },
    });
    expect(renamed.status).toBe(200);
    const list = await (await t.call("GET", "/auth/passkeys", { cookie })).json();
    expect(list.passkeys.find((p: { id: string }) => p.id === "p2").name).toBe("iPhone");
    expect(await t.count("passkey_renamed")).toBe(1);
    expect(await t.count("register")).toBe(2);

    const empty = await t.call("PATCH", "/auth/passkeys/p2", { cookie, body: { name: "" } });
    expect(empty.status).toBe(400);
  });

  it("パスキーの追加の検証の失敗は 400 WEBAUTHN_FAILED", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    const res = await t.addPasskey(cookie, "p2", { fail: true });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("WEBAUTHN_FAILED");
    expect(await store().listPasskeys()).toHaveLength(1);
  });

  it("localhost の最後のパスキーの削除は 409 LAST_PASSKEY。2 つあれば 204", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    const last = await t.call("DELETE", "/auth/passkeys/p1", { cookie });
    expect(last.status).toBe(409);
    expect(await code(last)).toBe("LAST_PASSKEY");
    expect(await store().listPasskeys()).toHaveLength(1);

    await t.addPasskey(cookie, "p2");
    expect((await t.call("DELETE", "/auth/passkeys/p2", { cookie })).status).toBe(204);
    expect(await t.count("passkey_deleted")).toBe(1);
  });

  it("ts.net のパスキーは最後の 1 つでも 204。そのパスキーのセッションは 401 になる", async () => {
    const t = setup();
    await t.registerFirst("p1");
    await store().addPasskey({
      id: "t1",
      publicKey: new Uint8Array([9]),
      counter: 0,
      rpId: REMOTE_HOST,
      transports: null,
      name: "remote",
      createdAt: t.clock.now(),
    });
    const s = await createTestSession({
      rpId: REMOTE_HOST,
      passkeyId: "t1",
      now: t.clock.now(),
    });
    const res = await t.call("DELETE", "/auth/passkeys/t1", {
      cookie: s.cookie,
      host: REMOTE_HOST,
    });
    expect(res.status).toBe(204);
    expect((await store().listPasskeys()).map((p) => p.id)).toEqual(["p1"]);
    const after = await t.call("GET", "/auth/passkeys", { cookie: s.cookie, host: REMOTE_HOST });
    expect(after.status).toBe(401);
  });

  it("パスキーの削除で、そのパスキーで作ったセッションだけが 401 になり session_revoked を記録する", async () => {
    const t = setup();
    const a = await t.registerFirst("p1"); // セッション A（p1）
    await t.addPasskey(a.cookie, "p2");
    const b = await t.signIn("p2"); // セッション B（p2）

    const sessions = await (await t.call("GET", "/auth/sessions", { cookie: a.cookie })).json();
    const aId = sessions.sessions.find((s: { current: boolean }) => s.current).id;

    const del = await t.call("DELETE", "/auth/passkeys/p1", { cookie: b.cookie });
    expect(del.status).toBe(204);
    expect((await t.call("GET", "/auth/passkeys", { cookie: a.cookie })).status).toBe(401);
    expect((await t.call("GET", "/auth/passkeys", { cookie: b.cookie })).status).toBe(200);

    const revoked = (await t.events()).filter((e) => e.kind === "session_revoked");
    expect(revoked.map((e) => e.sessionId)).toEqual([aId]);
    expect(await t.count("passkey_deleted")).toBe(1);
  });

  it("存在しないパスキーの削除は 204（何も変えない）、名前の変更は 400 VALIDATION", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    expect((await t.call("DELETE", "/auth/passkeys/zzz", { cookie })).status).toBe(204);
    expect(await store().listPasskeys()).toHaveLength(1);
    expect(await t.count("passkey_deleted")).toBe(0);
    const res = await t.call("PATCH", "/auth/passkeys/zzz", { cookie, body: { name: "x" } });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("VALIDATION");
  });

  it("recovery/regenerate: サインイン済みで古いコードが無効になり新しいコードが出る", async () => {
    const t = setup();
    const { cookie, recoveryCode: oldCode } = await t.registerFirst();
    const res = await t.call("POST", "/auth/recovery/regenerate", { cookie });
    expect(res.status).toBe(201);
    const { recoveryCode } = await res.json();
    expect(recoveryCode).toMatch(CODE_FORMAT);
    expect(recoveryCode).not.toBe(oldCode);

    const old = await t.recover(oldCode);
    expect(old.status).toBe(400);
    expect(await code(old)).toBe("RECOVERY_INVALID");
    expect((await t.recover(recoveryCode)).status).toBe(200);
    expect(await t.count("recovery_regenerated")).toBe(1);
  });

  it("セッションの一覧（current つき）・失効。失効したセッションは 401。回復用のセッションは載らない", async () => {
    const t = setup();
    const a = await t.registerFirst("p1");
    const b = await t.signIn("p1");
    await t.recover(a.recoveryCode);

    const listA = await (await t.call("GET", "/auth/sessions", { cookie: a.cookie })).json();
    expect(listA.sessions).toHaveLength(2);
    expect(listA.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(Object.keys(listA.sessions[0]).sort()).toEqual([
      "createdAt",
      "current",
      "id",
      "lastSeenAt",
      "rpId",
      "userAgent",
    ]);
    const bId = listA.sessions.find((s: { current: boolean }) => !s.current).id;
    const listB = await (await t.call("GET", "/auth/sessions", { cookie: b.cookie })).json();
    expect(listB.sessions.find((s: { current: boolean }) => s.current).id).toBe(bId);

    const del = await t.call("DELETE", `/auth/sessions/${bId}`, { cookie: a.cookie });
    expect(del.status).toBe(204);
    expect((await t.call("GET", "/auth/sessions", { cookie: b.cookie })).status).toBe(401);
    expect((await t.call("GET", "/auth/sessions", { cookie: a.cookie })).status).toBe(200);
    expect(await t.count("session_revoked")).toBe(1);
    // 存在しない ID・失効済みは 204（何も記録しない）
    expect((await t.call("DELETE", `/auth/sessions/${bId}`, { cookie: a.cookie })).status).toBe(
      204,
    );
    expect((await t.call("DELETE", "/auth/sessions/none", { cookie: a.cookie })).status).toBe(204);
    expect(await t.count("session_revoked")).toBe(1);
  });

  it("自分のセッションを失効すると、そのあと 401", async () => {
    const t = setup();
    const a = await t.registerFirst();
    const list = await (await t.call("GET", "/auth/sessions", { cookie: a.cookie })).json();
    const res = await t.call("DELETE", `/auth/sessions/${list.sessions[0].id}`, {
      cookie: a.cookie,
    });
    expect(res.status).toBe(204);
    expect((await t.call("GET", "/auth/sessions", { cookie: a.cookie })).status).toBe(401);
  });
});

describe("auth_events（FR-008）", () => {
  it("要求ごとに増え、新しい順に ?limit= で取れる。更新・削除できない", async () => {
    const t = setup();
    const { cookie } = await t.registerFirst("p1");
    t.clock.advance(1000);
    await t.signIn("p1");
    t.clock.advance(1000);
    await t.signIn("p1", { fail: true });

    const all = await (await t.call("GET", "/auth/events", { cookie })).json();
    expect(all.events.map((e: { kind: string }) => e.kind)).toEqual([
      "sign_in_failed",
      "sign_in",
      "register",
    ]);
    const two = await (await t.call("GET", "/auth/events?limit=2", { cookie })).json();
    expect(two.events).toHaveLength(2);
    expect((await t.call("GET", "/auth/events?limit=0", { cookie })).status).toBe(400);
    expect((await t.call("GET", "/auth/events?limit=abc", { cookie })).status).toBe(400);

    const db = openRegistry();
    expect(() => db.$client.prepare("UPDATE auth_events SET kind = 'sign_in'").run()).toThrow();
    expect(() => db.$client.prepare("DELETE FROM auth_events").run()).toThrow();
  });

  it("rpId と passkeyId を残す", async () => {
    const t = setup();
    await t.registerFirst("p1");
    const [reg] = await t.events();
    expect(reg).toMatchObject({ kind: "register", rpId: "localhost", passkeyId: "p1" });
  });
});

describe("秘密を出さない", () => {
  it("レスポンス・auth_events・ログに回復コードの平文もセッションのトークンも含まれない", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
    ];
    const t = setup();
    const a = await t.registerFirst("p1");
    const secrets = [
      a.recoveryCode,
      a.recoveryCode.replaceAll("-", ""),
      a.cookie.split("=")[1] ?? "",
    ];
    const bodies: string[] = [];
    const collect = async (res: Response) => {
      bodies.push(await res.clone().text());
      return res;
    };
    const b = await t.signIn("p1");
    secrets.push(b.cookie.split("=")[1] ?? "");
    for (let i = 0; i < 2; i++) await t.recover("WRONG-WRONG");
    const rec = await collect(await t.recover(a.recoveryCode));
    secrets.push((t.cookieOf(rec) as string).split("=")[1] ?? "");
    await collect(await t.call("GET", "/auth/status", { cookie: a.cookie }));
    await collect(await t.call("GET", "/auth/sessions", { cookie: a.cookie }));
    await collect(await t.call("GET", "/auth/passkeys", { cookie: a.cookie }));
    await collect(await t.call("GET", "/auth/events", { cookie: a.cookie }));
    const regen = await t.call("POST", "/auth/recovery/regenerate", { cookie: a.cookie });
    const { recoveryCode: next } = await regen.json();

    const events = JSON.stringify(await t.events());
    const logs = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(10);
      for (const text of [...bodies, events, logs]) expect(text).not.toContain(secret);
    }
    expect(events).not.toContain(next);
    expect(events).not.toContain(next.replaceAll("-", ""));
    expect(logs).not.toContain(next);
  });
});
