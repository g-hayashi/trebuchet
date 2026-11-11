import { clearDataKey, hashToken, unwrapDataKey, withDataKey } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { AuthStore } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vault as defaultVault } from "../src/deps.ts";
import { SESSION_COOKIE } from "../src/lib/session.ts";
import { errorOf } from "./helpers.ts";
import {
  authStore,
  MIN,
  markPairingTokenUsed,
  REMOTE_HOST,
  setupPairing,
} from "./pairing-helpers.ts";
import { b64, prfOf } from "./webauthn-fakes.ts";

// T017b: `pairing/register/*`（公開）。ts.net の名前のパスキーを、ペアリングのトークンでだけ登録する。
// 解錠中だけ有効（施錠中は 401 LOCKED）。包みを作り終えてから、同じ auth.sqlite のトランザクションで
// トークンを消費する（INV-53）

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server");
});
afterEach(() => tmp.cleanup());

/** ローカルの初回の設定、リモートの登録、トークンの発行まで済ませる */
async function ready(options: Parameters<typeof setupPairing>[0] = {}) {
  const t = setupPairing(options);
  const cookie = await t.registerFirst("p1");
  await t.enableRemote();
  const token = await t.issueToken(cookie);
  return { t, cookie, token };
}

const tokenValid = (token: string, now: string) =>
  authStore().isPairingTokenValid(hashToken(token), REMOTE_HOST, now);

describe("トークンの検査（401 PAIRING_TOKEN_INVALID）", () => {
  it.each(["options", "verify"] as const)(
    "%s: 存在しない・期限切れ・使用済みのトークンは 401",
    async (step) => {
      const { t, cookie, token: expired } = await ready();
      const used = await t.issueToken(cookie);
      markPairingTokenUsed(hashToken(used), t.clock.now());
      const call = (token: string) =>
        t.call("POST", `/auth/pairing/register/${step}`, {
          host: REMOTE_HOST,
          body: step === "options" ? { token } : { token, response: { id: "p2" } },
        });
      const expectInvalid = async (label: string, token: string) => {
        const res = await call(token);
        expect(res.status, label).toBe(401);
        expect((await errorOf(res)).code, label).toBe("PAIRING_TOKEN_INVALID");
      };
      await expectInvalid("存在しない", "no-such-token");
      await expectInvalid("使用済み", used);
      t.clock.advance(10 * MIN);
      await expectInvalid("期限切れ", expired);
    },
  );

  it("名前を変えると、前の名前で発行したトークンは使えない", async () => {
    const { t, token } = await ready();
    const otherHost = "other.tail9999.ts.net";
    await authStore().setRemoteSettings({ enabled: true, host: otherHost }, t.clock.now());
    const res = await t.call("POST", "/auth/pairing/register/options", {
      host: otherHost,
      body: { token },
    });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("PAIRING_TOKEN_INVALID");
  });

  it("token がない本文は 400 VALIDATION", async () => {
    const { t } = await ready();
    const res = await t.call("POST", "/auth/pairing/register/options", {
      host: REMOTE_HOST,
      body: {},
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});

describe("前提（施錠中・Host）", () => {
  it.each(["options", "verify"] as const)(
    "%s: 施錠中は 401 LOCKED。トークンは消費しない",
    async (step) => {
      const { t, token } = await ready();
      clearDataKey();
      const res = await t.call("POST", `/auth/pairing/register/${step}`, {
        host: REMOTE_HOST,
        body: step === "options" ? { token } : { token, response: { id: "p2" } },
      });
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe("LOCKED");
    },
  );

  it.each(["options", "verify"] as const)(
    "%s: ローカルの Host からは 421 HOST_NOT_ALLOWED",
    async (step) => {
      const { t, token } = await ready();
      const res = await t.call("POST", `/auth/pairing/register/${step}`, {
        body: step === "options" ? { token } : { token, response: { id: "p2" } },
      });
      expect(res.status).toBe(421);
      expect((await errorOf(res)).code).toBe("HOST_NOT_ALLOWED");
      expect(await tokenValid(token, t.clock.now())).toBe(true);
    },
  );
});

describe("登録の成功（201）", () => {
  it("パスキーは ts.net の rpId、包みはパスキーと 1 対 1（INV-53）で同じ DK を開く。cookie は Secure、セッションは ts.net の rpId", async () => {
    const { t, token } = await ready();
    const before = await authStore().listPasskeys();
    const { res } = await t.pair(token, "p2", { name: "iPhone" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.passkey).toMatchObject({ id: "p2", name: "iPhone", rpId: REMOTE_HOST });
    expect(Object.keys(body.passkey).sort()).toEqual([
      "createdAt",
      "id",
      "lastUsedAt",
      "name",
      "rpId",
    ]);
    expect(t.seen.registrations.at(-1)).toEqual({
      origin: `https://${REMOTE_HOST}`,
      rpId: REMOTE_HOST,
    });

    const store = authStore();
    const passkeys = await store.listPasskeys();
    expect(passkeys.map((p) => p.id)).toEqual([...before.map((p) => p.id), "p2"]);
    for (const p of passkeys) expect(await store.getPasskeyWrap(p.id)).toBeDefined();
    const p2 = passkeys.find((p) => p.id === "p2");
    const wrap = await store.getPasskeyWrap("p2");
    const dk =
      wrap && p2 ? unwrapDataKey(wrap, prfOf("p2", b64(p2.prfSalt)), "passkey", "p2") : null;
    expect(dk?.equals(withDataKey((k) => Buffer.from(k)))).toBe(true);

    const setCookie = t.setCookieOf(res) ?? "";
    expect(setCookie).toMatch(/;\s*Secure/i);
    const cookie = t.cookieOf(res) as string;
    const status = await (
      await t.call("GET", "/auth/status", { cookie, host: REMOTE_HOST })
    ).json();
    expect(status).toMatchObject({ signedIn: true, rpId: REMOTE_HOST });
    const session = await store.findSessionByTokenHash(
      hashToken(cookie.slice(SESSION_COOKIE.length + 1)),
    );
    expect(session).toMatchObject({ rpId: REMOTE_HOST, passkeyId: "p2", kind: "normal" });

    expect(await tokenValid(token, t.clock.now())).toBe(false);
  });

  it("pairing_used と register を記録し、トークン・ハッシュ・URL を残さない", async () => {
    const { t, token } = await ready();
    await t.pair(token, "p2");
    const events = await t.events();
    expect(events.filter((e) => e.kind === "pairing_used")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "register")).toHaveLength(2);
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(hashToken(token));
  });

  it("同じトークンの 2 回目は 401", async () => {
    const { t, token } = await ready();
    expect((await t.pair(token, "p2")).res.status).toBe(201);
    const again = await t.pair(token, "p3");
    expect(again.res.status).toBe(401);
    expect((await errorOf(again.res)).code).toBe("PAIRING_TOKEN_INVALID");
    expect((await authStore().listPasskeys()).map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("登録で PRF の出力が返らない認証器は prf_required の後に済む。途中ではトークンを消費しない", async () => {
    const { t, token } = await ready();
    const first = await t.pair(token, "p2", { prf: "enabled", followUp: false });
    expect(first.res.status).toBe(200);
    expect((await first.res.json()).status).toBe("prf_required");
    expect(await tokenValid(token, t.clock.now())).toBe(true);
    expect((await authStore().listPasskeys()).map((p) => p.id)).toEqual(["p1"]);

    const done = await t.pair(token, "p2", { prf: "enabled" });
    expect(done.res.status).toBe(201);
    expect(await tokenValid(token, t.clock.now())).toBe(false);
  });
});

describe("失敗ではトークンを減らさない", () => {
  it("PRF がなければ 400 PRF_UNSUPPORTED。トークンは残り、PRF のある認証器で登録し直せる", async () => {
    const { t, token } = await ready();
    const bad = await t.pair(token, "p2", { prf: "none" });
    expect(bad.res.status).toBe(400);
    expect((await errorOf(bad.res)).code).toBe("PRF_UNSUPPORTED");
    expect(await tokenValid(token, t.clock.now())).toBe(true);
    expect((await authStore().listPasskeys()).map((p) => p.id)).toEqual(["p1"]);
    expect((await t.events()).some((e) => e.kind === "pairing_used")).toBe(false);

    expect((await t.pair(token, "p2")).res.status).toBe(201);
  });

  it("検証の失敗は 400 WEBAUTHN_FAILED。トークンは残る", async () => {
    const { t, token } = await ready();
    const bad = await t.pair(token, "p2", { fail: true });
    expect(bad.res.status).toBe(400);
    expect((await errorOf(bad.res)).code).toBe("WEBAUTHN_FAILED");
    expect(await tokenValid(token, t.clock.now())).toBe(true);
    expect((await t.pair(token, "p2")).res.status).toBe(201);
  });

  it("包みを作れなければ（DK を使えない）パスキーもできず、トークンが残る", async () => {
    const broken = {
      ...defaultVault,
      withDataKey: () => {
        throw new Error("boom");
      },
    };
    const { t, token } = await ready({ vault: broken });
    const bad = await t.pair(token, "p2");
    expect(bad.res.status).toBe(500);
    expect(await tokenValid(token, t.clock.now())).toBe(true);
    expect((await authStore().listPasskeys()).map((p) => p.id)).toEqual(["p1"]);
    expect((await t.events()).some((e) => e.kind === "pairing_used")).toBe(false);
  });

  it("消費の直前に同じトークンが使われたら（同時の使用）401 PAIRING_TOKEN_INVALID。パスキーは増えない", async () => {
    let tokenHash = "";
    const racing = new Proxy(authStore(), {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop === "addPasskeyWithPairingToken") {
          return async (...args: Parameters<AuthStore["addPasskeyWithPairingToken"]>) => {
            markPairingTokenUsed(tokenHash, args[3]);
            return target.addPasskeyWithPairingToken(...args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { t, token } = await ready({ store: () => racing });
    tokenHash = hashToken(token);
    const res = (await t.pair(token, "p2")).res;
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("PAIRING_TOKEN_INVALID");
    expect((await authStore().listPasskeys()).map((p) => p.id)).toEqual(["p1"]);
    expect((await t.events()).some((e) => e.kind === "pairing_used")).toBe(false);
  });
});
