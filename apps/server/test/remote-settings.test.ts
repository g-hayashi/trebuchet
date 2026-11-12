import { clearDataKey, DrizzleAuthStore, openAuth, openRegistry } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { expectedOriginFor } from "../src/lib/origin.ts";
import { isSecureHost, setSessionCookie } from "../src/lib/session.ts";
import { createTestSession, errorOf, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";
import { MIN, setupPairing } from "./pairing-helpers.ts";

// T016b: リモート（Tailscale）の設定。Host の検査は施錠中も auth.sqlite の設定に従い（LOCKED にならない）、
// `GET/PUT /settings/remote`、ts.net の Host の検証、cookie の Secure、別の Origin の拒否を確かめる

let tmp: TempDataDir;
let t: ReturnType<typeof setupPairing>;
beforeEach(() => {
  tmp = useTempDataDir("server");
  t = setupPairing();
});
afterEach(() => tmp.cleanup());

const store = () => new DrizzleAuthStore(openAuth(), openRegistry);
const REMOTE_HOST = "mac.tail1234.ts.net";
const REMOTE_ORIGIN = `https://${REMOTE_HOST}`;

const json = (body: unknown) => JSON.stringify(body);

/** パスキーでサインインした直後のセッション（再認証の済んだ状態。`t.app` と同じアプリの記録を使う） */
async function signedInLocal() {
  return {
    Host: TEST_HOST,
    Origin: TEST_ORIGIN,
    Cookie: await t.registerFirst(),
    "Content-Type": "application/json",
  };
}

const put = (headers: Record<string, string>, body: unknown) =>
  t.app.request("/api/settings/remote", { method: "PUT", headers, body: json(body) });

describe("GET/PUT /settings/remote", () => {
  it("既定は無効で名前なし", async () => {
    const res = await t.app.request("/api/settings/remote", {
      headers: await signedInLocal(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, host: null });
  });

  it("未サインインは 401", async () => {
    const res = await createApp().request("/api/settings/remote", { headers: { Host: TEST_HOST } });
    expect(res.status).toBe(401);
  });

  it("PUT した値を GET で読め、auth.sqlite に保存され、auth_events に remote_settings_changed（detail は { enabled, host }）を残す", async () => {
    const headers = await signedInLocal();
    const res = await put(headers, { enabled: true, host: REMOTE_HOST });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, host: REMOTE_HOST });

    const get = await t.app.request("/api/settings/remote", { headers });
    expect(await get.json()).toEqual({ enabled: true, host: REMOTE_HOST });
    expect(await store().getRemoteSettings()).toEqual({ enabled: true, host: REMOTE_HOST });

    const events = (await store().listEvents(10)).filter(
      (e) => e.kind === "remote_settings_changed",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ enabled: true, host: REMOTE_HOST });
    expect(events[0]?.sessionId).not.toBeNull();
  });

  it("無効にして名前だけ残す・名前を消すこともできる", async () => {
    const headers = await signedInLocal();
    await put(headers, { enabled: true, host: REMOTE_HOST });
    const off = await put(headers, { enabled: false, host: REMOTE_HOST });
    expect(await off.json()).toEqual({ enabled: false, host: REMOTE_HOST });
    const cleared = await put(headers, { enabled: false, host: null });
    expect(await cleared.json()).toEqual({ enabled: false, host: null });
    const events = (await store().listEvents(10)).filter(
      (e) => e.kind === "remote_settings_changed",
    );
    expect(events).toHaveLength(3);
  });

  it.each([
    ["別のドメイン", { enabled: true, host: "mac.example.com" }],
    ["ts.net だけ", { enabled: true, host: "ts.net" }],
    ["スキームつき", { enabled: true, host: "https://mac.tail1234.ts.net" }],
    ["有効なのに名前なし", { enabled: true, host: null }],
  ])(
    "不正な名前（%s）は 422 REMOTE_HOST_INVALID で、何も保存せず記録も残さない",
    async (_n, body) => {
      const res = await put(await signedInLocal(), body);
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe("REMOTE_HOST_INVALID");
      expect(await store().getRemoteSettings()).toEqual({ enabled: false, host: null });
      expect((await store().listEvents(10)).some((e) => e.kind === "remote_settings_changed")).toBe(
        false,
      );
    },
  );

  it("再認証から 5 分過ぎると 403 REAUTH_REQUIRED で、何も保存せず記録も残さない", async () => {
    const headers = await signedInLocal();
    t.clock.advance(5 * MIN);
    const res = await put(headers, { enabled: true, host: REMOTE_HOST });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("REAUTH_REQUIRED");
    expect(await store().getRemoteSettings()).toEqual({ enabled: false, host: null });
    expect((await store().listEvents(10)).some((e) => e.kind === "remote_settings_changed")).toBe(
      false,
    );
  });

  it("ts.net の Host から（ts.net のセッションでも）は 421 HOST_NOT_ALLOWED で、何も保存しない", async () => {
    await store().setRemoteSettings({ enabled: true, host: REMOTE_HOST }, "2026-11-02T00:00:00Z");
    const s = await createTestSession({ rpId: REMOTE_HOST, now: t.clock.now() });
    const res = await t.app.request("/api/settings/remote", {
      method: "PUT",
      headers: {
        Host: REMOTE_HOST,
        Origin: REMOTE_ORIGIN,
        Cookie: s.cookie,
        "Content-Type": "application/json",
      },
      body: json({ enabled: false, host: null }),
    });
    expect(res.status).toBe(421);
    expect((await errorOf(res)).code).toBe("HOST_NOT_ALLOWED");
    expect(await store().getRemoteSettings()).toEqual({ enabled: true, host: REMOTE_HOST });
  });

  it("形が違う本文（enabled が真偽値でない）は 400 VALIDATION", async () => {
    const res = await put(await signedInLocal(), { enabled: "yes", host: null });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});

describe("Host の検査は施錠中も auth.sqlite の設定に従う（FR-011）", () => {
  it("施錠中でも、有効で登録した名前の Host は通り（LOCKED にならない）、別の名前は 421", async () => {
    await store().setRemoteSettings({ enabled: true, host: REMOTE_HOST }, "2026-11-02T00:00:00Z");
    clearDataKey();
    const a = createApp();
    const ok = await a.request("/api/health", { headers: { Host: REMOTE_HOST } });
    expect(ok.status).toBe(200);
    const other = await a.request("/api/health", { headers: { Host: "other.tail1234.ts.net" } });
    expect(other.status).toBe(421);
    expect((await errorOf(other)).code).toBe("HOST_NOT_ALLOWED");
  });

  it("施錠中でも、無効のとき ts.net の Host は 421", async () => {
    clearDataKey();
    const res = await createApp().request("/api/health", { headers: { Host: REMOTE_HOST } });
    expect(res.status).toBe(421);
    expect((await errorOf(res)).code).toBe("HOST_NOT_ALLOWED");
  });

  it("要求ごとに読む: 再起動（createApp のやり直し）なしで設定の変更が反映される", async () => {
    const a = t.app;
    const headers = await signedInLocal();
    const probe = () => a.request("/api/health", { headers: { Host: REMOTE_HOST } });
    expect((await probe()).status).toBe(421);
    await a.request("/api/settings/remote", {
      method: "PUT",
      headers,
      body: json({ enabled: true, host: REMOTE_HOST }),
    });
    expect((await probe()).status).toBe(200);
    await a.request("/api/settings/remote", {
      method: "PUT",
      headers,
      body: json({ enabled: false, host: REMOTE_HOST }),
    });
    expect((await probe()).status).toBe(421);
  });
});

describe("ts.net の名前での接続（https）", () => {
  it("WebAuthn の検証の origin は https://<名前>、ローカルは http", () => {
    const remote = { enabled: true, host: REMOTE_HOST };
    expect(expectedOriginFor(REMOTE_HOST, remote)).toBe(REMOTE_ORIGIN);
    expect(expectedOriginFor(TEST_HOST, remote)).toBe(TEST_ORIGIN);
    expect(expectedOriginFor(REMOTE_HOST)).toBeUndefined();
  });

  it("cookie の Secure は https の接続先（ts.net）のときだけ", async () => {
    const remote = { enabled: true, host: REMOTE_HOST };
    expect(isSecureHost(REMOTE_HOST, remote)).toBe(true);
    expect(isSecureHost(TEST_HOST, remote)).toBe(false);
    const cookieFor = async (secure: boolean) => {
      const a = new Hono().get("/", (c) => {
        setSessionCookie(c, "t", { secure });
        return c.text("ok");
      });
      return (await a.request("/")).headers.get("set-cookie") ?? "";
    };
    expect(await cookieFor(true)).toContain("Secure");
    expect(await cookieFor(false)).not.toContain("Secure");
  });

  it("別の Origin の POST は 403 CSRF_REJECTED。http の Origin も、ts.net の名前では 403", async () => {
    await store().setRemoteSettings({ enabled: true, host: REMOTE_HOST }, "2026-11-02T00:00:00Z");
    const s = await createTestSession({ rpId: REMOTE_HOST });
    const send = (origin: string) =>
      createApp().request("/api/settings/remote", {
        method: "PUT",
        headers: {
          Host: REMOTE_HOST,
          Origin: origin,
          Cookie: s.cookie,
          "Content-Type": "application/json",
        },
        body: json({ enabled: true, host: REMOTE_HOST }),
      });
    for (const origin of ["https://evil.example.com", `http://${REMOTE_HOST}`]) {
      const res = await send(origin);
      expect(res.status, origin).toBe(403);
      expect((await errorOf(res)).code).toBe("CSRF_REJECTED");
    }
    // CSRF は通るが、設定の変更は localhost の Host だけ（421 HOST_NOT_ALLOWED）
    const ok = await send(REMOTE_ORIGIN);
    expect(ok.status).toBe(421);
    expect((await errorOf(ok)).code).toBe("HOST_NOT_ALLOWED");
  });
});
