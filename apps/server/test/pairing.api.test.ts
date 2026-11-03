import { hashToken } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSession, errorOf } from "./helpers.ts";
import { authStore, MIN, REMOTE_HOST, setupPairing } from "./pairing-helpers.ts";
import { authResponse } from "./webauthn-fakes.ts";

// T017: `POST /auth/pairing`（ペアリングのトークンの発行。FR-012・008）。
// 全権セッション＋直近 5 分の再認証、ローカルの Host、リモートが有効で名前が登録済み

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server");
});
afterEach(() => tmp.cleanup());

describe("POST /auth/pairing", () => {
  it("201 { token, url, expiresAt }。url は https://<名前>/pair?token=…、期限は 10 分、DB にはハッシュだけ", async () => {
    const t = setupPairing();
    const cookie = await t.registerFirst();
    await t.enableRemote();
    const res = await t.issue(cookie);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "token", "url"]);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.url).toBe(`https://${REMOTE_HOST}/pair?token=${body.token}`);
    expect(body.expiresAt).toBe(new Date(Date.parse(t.clock.now()) + 10 * MIN).toISOString());

    const store = authStore();
    const now = t.clock.now();
    expect(await store.isPairingTokenValid(hashToken(body.token), REMOTE_HOST, now)).toBe(true);
    // 平文のトークンは保存していない（ハッシュで探したときだけ見つかる）
    expect(await store.isPairingTokenValid(body.token, REMOTE_HOST, now)).toBe(false);
    // 10 分きっかりで切れる
    t.clock.advance(10 * MIN - 1);
    expect(await store.isPairingTokenValid(hashToken(body.token), REMOTE_HOST, t.clock.now())).toBe(
      true,
    );
    t.clock.advance(1);
    expect(await store.isPairingTokenValid(hashToken(body.token), REMOTE_HOST, t.clock.now())).toBe(
      false,
    );
  });

  it("発行のたびに別のトークン。auth_events に pairing_issued を残し、detail にトークン・ハッシュ・URL を入れない", async () => {
    const t = setupPairing();
    const cookie = await t.registerFirst();
    await t.enableRemote();
    const a = await t.issueToken(cookie);
    const b = await t.issueToken(cookie);
    expect(a).not.toBe(b);
    const issued = (await t.events()).filter((e) => e.kind === "pairing_issued");
    expect(issued).toHaveLength(2);
    expect(issued[0]?.sessionId).not.toBeNull();
    const dump = JSON.stringify(await t.events());
    for (const token of [a, b]) {
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(hashToken(token));
    }
    expect(dump).not.toContain("/pair?");
  });

  it("再認証から 5 分過ぎると 403 REAUTH_REQUIRED。パスキーでの再認証の後は通る", async () => {
    const t = setupPairing();
    const cookie = await t.registerFirst("p1");
    await t.enableRemote();
    t.clock.advance(5 * MIN);
    const res = await t.issue(cookie);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("REAUTH_REQUIRED");
    expect((await t.events()).some((e) => e.kind === "pairing_issued")).toBe(false);

    const options = await (await t.call("POST", "/auth/reauth/options", { cookie })).json();
    const re = await t.call("POST", "/auth/reauth/verify", {
      cookie,
      body: { response: authResponse(options, "p1", "none") },
    });
    expect(re.status).toBe(204);
    expect((await t.issue(cookie)).status).toBe(201);
  });

  it("ts.net の Host から（ts.net のセッションでも）は 421 HOST_NOT_ALLOWED", async () => {
    const t = setupPairing();
    await t.registerFirst();
    await t.enableRemote();
    const remote = await createTestSession({ rpId: REMOTE_HOST, now: t.clock.now() });
    const res = await t.call("POST", "/auth/pairing", { cookie: remote.cookie, host: REMOTE_HOST });
    expect(res.status).toBe(421);
    expect((await errorOf(res)).code).toBe("HOST_NOT_ALLOWED");
  });

  it("リモートが無効（既定）・無効で名前だけ登録済みは 409 REMOTE_NOT_CONFIGURED。トークンは作らない", async () => {
    const t = setupPairing();
    const cookie = await t.registerFirst();
    for (const setting of [null, { enabled: false, host: REMOTE_HOST }]) {
      if (setting !== null) await authStore().setRemoteSettings(setting, t.clock.now());
      const res = await t.issue(cookie);
      expect(res.status).toBe(409);
      expect((await errorOf(res)).code).toBe("REMOTE_NOT_CONFIGURED");
    }
    expect((await t.events()).some((e) => e.kind === "pairing_issued")).toBe(false);
  });

  it("未サインインは 401 UNAUTHENTICATED", async () => {
    const t = setupPairing();
    await t.registerFirst();
    await t.enableRemote();
    const res = await t.issue("");
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("UNAUTHENTICATED");
  });
});
