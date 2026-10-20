import { randomUUIDv7 } from "node:crypto";
import { DrizzleAuthStore, hashToken, openRegistry } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { issueSession, SESSION_COOKIE, setSessionCookie } from "../src/lib/session.ts";
import { createTestSession, errorOf, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";

// T007: Host → CSRF → 認証の順の検査（R5・R6、FR-003・004・009・011）。
// 認証の経路を通らずに registry にセッションを作る（helpers.createTestSession）

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server");
});
afterEach(() => tmp.cleanup());

const store = () => new DrizzleAuthStore(openRegistry());
const REMOTE_HOST = "mac.tail1234.ts.net";
const remoteOn = async () => ({ enabled: true, host: REMOTE_HOST });

/** 検査を通ったら 200 を返す保護されたダミーのルートを足したアプリ */
function buildApp(options: Parameters<typeof createApp>[0] = {}) {
  const a = createApp(options);
  a.get("/ping", (c) => c.json({ ok: true }));
  a.post("/ping", (c) => c.json({ ok: true }));
  a.delete("/ping", (c) => c.json({ ok: true }));
  return a;
}

type Req = { method?: string; headers?: Record<string, string>; body?: string };
const send = (a: ReturnType<typeof buildApp>, path: string, r: Req = {}) =>
  a.request(path, {
    method: r.method ?? "GET",
    headers: r.headers ?? {},
    ...(r.body === undefined ? {} : { body: r.body }),
  });

async function signedIn(extra: Record<string, string> = {}, host = TEST_HOST) {
  const s = await createTestSession();
  return { ...extra, Host: host, Cookie: s.cookie };
}

describe("Host の検査（FR-011）", () => {
  it("許さない Host は 421 HOST_NOT_ALLOWED（認証の前に判定する）", async () => {
    const res = await send(buildApp(), "/api/ping", {
      headers: await signedIn({}, "evil.example.com"),
    });
    expect(res.status).toBe(421);
    expect((await errorOf(res)).code).toBe("HOST_NOT_ALLOWED");
  });

  it("Host がなくても 421", async () => {
    const res = await send(buildApp(), "/api/health");
    expect(res.status).toBe(421);
  });

  it("公開のルート（health）でも許さない Host は 421", async () => {
    const res = await send(buildApp(), "/api/health", { headers: { Host: "evil.example.com" } });
    expect(res.status).toBe(421);
  });

  it("127.0.0.1:5173 は許さない。127.0.0.1:8787 の health は通る", async () => {
    const a = buildApp();
    expect((await send(a, "/api/health", { headers: { Host: "127.0.0.1:5173" } })).status).toBe(
      421,
    );
    expect((await send(a, "/api/health", { headers: { Host: "127.0.0.1:8787" } })).status).toBe(
      200,
    );
  });

  it("localhost:5173 と localhost:8787 の health は通る", async () => {
    const a = buildApp();
    for (const host of ["localhost:5173", "localhost:8787"]) {
      expect((await send(a, "/api/health", { headers: { Host: host } })).status).toBe(200);
    }
  });

  it("リモートが無効なら ts.net の Host は 421。有効で登録した名前なら通る", async () => {
    const off = await send(buildApp(), "/api/health", { headers: { Host: REMOTE_HOST } });
    expect(off.status).toBe(421);
    const on = await send(buildApp({ getRemoteSettings: remoteOn }), "/api/health", {
      headers: { Host: REMOTE_HOST },
    });
    expect(on.status).toBe(200);
  });
});

describe("CSRF の検査（FR-009）", () => {
  const post = async (headers: Record<string, string>, extra: Req = {}) =>
    send(buildApp(), "/api/ping", {
      method: "POST",
      ...extra,
      headers: { ...(await signedIn()), ...headers, ...extra.headers },
    });

  it("Origin が別の POST は 403 CSRF_REJECTED", async () => {
    const res = await post({ Origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("CSRF_REJECTED");
  });

  it("Origin なしで Sec-Fetch-Site: cross-site の POST は 403", async () => {
    const res = await post({ "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("CSRF_REJECTED");
  });

  it("Origin も Sec-Fetch-Site もない POST は 403", async () => {
    expect((await post({})).status).toBe(403);
  });

  it("Origin: null は 403", async () => {
    expect((await post({ Origin: "null" })).status).toBe(403);
  });

  it("クロスサイトの JSON の POST は 403", async () => {
    const res = await post(
      { Origin: "https://evil.example.com", "Content-Type": "application/json" },
      { body: JSON.stringify({ a: 1 }) },
    );
    expect(res.status).toBe(403);
  });

  it("クロスサイトの本文なしの DELETE は 403", async () => {
    const res = await send(buildApp(), "/api/ping", {
      method: "DELETE",
      headers: { ...(await signedIn()), Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it.each([
    ["text/plain", "x=1"],
    ["multipart/form-data; boundary=x", "--x--"],
    ["application/x-www-form-urlencoded", "a=1"],
    [undefined, undefined],
  ])("Content-Type が %s でも Origin が別なら 403", async (contentType, body) => {
    const res = await post(
      {
        Origin: "https://evil.example.com",
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      body === undefined ? {} : { body },
    );
    expect(res.status).toBe(403);
  });

  it("Origin が許す一覧にあれば通る（JSON・本文なし・text/plain のどれでも）", async () => {
    expect((await post({ Origin: TEST_ORIGIN })).status).toBe(200);
    expect(
      (
        await post(
          { Origin: TEST_ORIGIN, "Content-Type": "application/json" },
          { body: JSON.stringify({}) },
        )
      ).status,
    ).toBe(200);
    expect(
      (await post({ Origin: "http://localhost:8787", "Content-Type": "text/plain" }, { body: "x" }))
        .status,
    ).toBe(200);
  });

  it("Origin なしで Sec-Fetch-Site: same-origin なら通る", async () => {
    expect((await post({ "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
  });

  it("Origin なしで Sec-Fetch-Site: same-site / none は 403", async () => {
    expect((await post({ "Sec-Fetch-Site": "same-site" })).status).toBe(403);
    expect((await post({ "Sec-Fetch-Site": "none" })).status).toBe(403);
  });

  it("Origin があれば Sec-Fetch-Site が same-origin でも Origin を優先して 403", async () => {
    const res = await post({ Origin: "https://evil.example.com", "Sec-Fetch-Site": "same-origin" });
    expect(res.status).toBe(403);
  });

  it("GET は Origin なしで通る（HEAD も）", async () => {
    const a = buildApp();
    expect((await send(a, "/api/ping", { headers: await signedIn() })).status).toBe(200);
    expect((await send(a, "/api/ping", { method: "HEAD", headers: await signedIn() })).status).toBe(
      200,
    );
  });

  it("GET は別の Origin でも CSRF の検査では止まらない", async () => {
    const res = await send(buildApp(), "/api/ping", {
      headers: await signedIn({ Origin: "https://evil.example.com" }),
    });
    expect(res.status).toBe(200);
  });

  it("リモートが有効なら https://<名前> の Origin で通る。無効なら 403", async () => {
    const s = await createTestSession({ rpId: REMOTE_HOST });
    const headers = { Host: REMOTE_HOST, Origin: `https://${REMOTE_HOST}`, Cookie: s.cookie };
    expect(
      (
        await send(buildApp({ getRemoteSettings: remoteOn }), "/api/ping", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(200);
    // リモートが無効なときは、Host の検査で先に 421
    expect((await send(buildApp(), "/api/ping", { method: "POST", headers })).status).toBe(421);
  });

  it("Host の検査が CSRF より先（許さない Host で Origin も別なら 421）", async () => {
    const res = await send(buildApp(), "/api/ping", {
      method: "POST",
      headers: { Host: "evil.example.com", Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(421);
  });

  it("CSRF が認証より先（cookie なしでも Origin が別なら 403）", async () => {
    const res = await send(buildApp(), "/api/ping", {
      method: "POST",
      headers: { Host: TEST_HOST, Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });
});

describe("認証（FR-003・004、INV-28）", () => {
  const get = async (cookie?: string, host = TEST_HOST) =>
    send(buildApp(), "/api/ping", {
      headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) },
    });
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const HOUR = 60 * 60 * 1000;

  it("cookie なしは 401 UNAUTHENTICATED", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("UNAUTHENTICATED");
  });

  it("知らないトークンの cookie は 401", async () => {
    expect((await get(`${SESSION_COOKIE}=nonexistent`)).status).toBe(401);
  });

  it("別名の cookie は無視される", async () => {
    const s = await createTestSession();
    expect((await get(`other=${s.token}`)).status).toBe(401);
  });

  it("有効なセッションは通る", async () => {
    const s = await createTestSession();
    expect((await get(s.cookie)).status).toBe(200);
  });

  it("最後の操作から8時間を超えたセッションは 401", async () => {
    const s = await createTestSession({ now: iso(8 * HOUR + 1000) });
    expect((await get(s.cookie)).status).toBe(401);
  });

  it("7時間59分のセッションは通る", async () => {
    const s = await createTestSession({ now: iso(8 * HOUR - 60 * 1000) });
    expect((await get(s.cookie)).status).toBe(200);
  });

  it("revoked_at つきのセッションは 401", async () => {
    const s = await createTestSession();
    await store().revokeSession(s.id, new Date().toISOString());
    expect((await get(s.cookie)).status).toBe(401);
  });

  it("別の rp_id のセッションは 401（ローカルの Host でリモートのセッション）", async () => {
    const s = await createTestSession({ rpId: REMOTE_HOST });
    expect((await get(s.cookie)).status).toBe(401);
  });

  it("リモートの Host でローカルのセッションは 401。同じ rp_id なら通る", async () => {
    const a = buildApp({ getRemoteSettings: remoteOn });
    const local = await createTestSession({ rpId: "localhost" });
    const remote = await createTestSession({ rpId: REMOTE_HOST });
    const at = (cookie: string) =>
      send(a, "/api/ping", { headers: { Host: REMOTE_HOST, Cookie: cookie } });
    expect((await at(local.cookie)).status).toBe(401);
    expect((await at(remote.cookie)).status).toBe(200);
  });

  it("回復用の一時セッションは通常のルートに通らない", async () => {
    const s = await createTestSession({ kind: "recovery" });
    expect((await get(s.cookie)).status).toBe(401);
  });

  it("トークンが DB に平文で残っていない（ハッシュだけ）", async () => {
    const s = await createTestSession();
    const rows = openRegistry().$client.prepare("SELECT * FROM sessions").all();
    expect(JSON.stringify(rows)).not.toContain(s.token);
    expect(JSON.stringify(rows)).toContain(hashToken(s.token));
  });

  it("last_seen_at は1分以上たっていれば更新する", async () => {
    const s = await createTestSession({ now: iso(5 * 60 * 1000) });
    const before = (await store().findSessionByTokenHash(hashToken(s.token)))?.lastSeenAt;
    expect((await get(s.cookie)).status).toBe(200);
    const after = (await store().findSessionByTokenHash(hashToken(s.token)))?.lastSeenAt;
    expect(Date.parse(after ?? "")).toBeGreaterThan(Date.parse(before ?? ""));
  });

  it("last_seen_at は1分以内なら更新しない", async () => {
    const s = await createTestSession({ now: iso(10 * 1000) });
    const before = (await store().findSessionByTokenHash(hashToken(s.token)))?.lastSeenAt;
    expect((await get(s.cookie)).status).toBe(200);
    const after = (await store().findSessionByTokenHash(hashToken(s.token)))?.lastSeenAt;
    expect(after).toBe(before);
  });

  it("401 の要求では last_seen_at を更新しない（失効したセッション）", async () => {
    const s = await createTestSession({ now: iso(9 * HOUR) });
    expect((await get(s.cookie)).status).toBe(401);
    const row = await store().findSessionByTokenHash(hashToken(s.token));
    expect(Date.parse(row?.lastSeenAt ?? "")).toBeLessThan(Date.now() - 8 * HOUR);
  });
});

describe("公開の手続きの前提（FR-001・006、INV-29）", () => {
  /**
   * 公開の完全一致の一覧のうち、まだ本物のルートがないもの（pairing/register/*、T017 で足す）に
   * ダミーのハンドラーを足したアプリ。ほかは T008 の本物のルート
   */
  function publicApp(options: Parameters<typeof createApp>[0] = {}) {
    const a = createApp(options);
    for (const p of ["/auth/pairing/register/options", "/auth/pairing/register/verify"]) {
      a.post(p, (c) => c.json({ ok: true }));
    }
    return a;
  }

  /** 前提の検査（401・409・421）を通ったか。本物のルートは、空の本文で 200 か 400 VALIDATION になる */
  const passes = (res: Response) => ![401, 409, 421].includes(res.status);
  const post = (a: ReturnType<typeof publicApp>, path: string, headers: Record<string, string>) =>
    a.request(path, {
      method: "POST",
      headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, ...headers },
    });

  async function addPasskey() {
    await store().addPasskey({
      id: randomUUIDv7(),
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      rpId: "localhost",
      transports: null,
      name: "テスト",
      createdAt: new Date().toISOString(),
    });
  }

  it.each(["/api/auth/register/options", "/api/auth/register/verify"])(
    "%s はパスキー0件・ローカルの Host で通る",
    async (path) => {
      expect(passes(await post(publicApp(), path, {}))).toBe(true);
    },
  );

  it.each(["/api/auth/register/options", "/api/auth/register/verify"])(
    "%s はパスキー1件で 409 ALREADY_REGISTERED",
    async (path) => {
      await addPasskey();
      const res = await post(publicApp(), path, {});
      expect(res.status).toBe(409);
      expect((await errorOf(res)).code).toBe("ALREADY_REGISTERED");
    },
  );

  it.each(["/api/auth/register/options", "/api/auth/register/verify"])(
    "%s はパスキー0件でも ts.net の Host なら 421",
    async (path) => {
      const a = publicApp({ getRemoteSettings: remoteOn });
      const res = await post(a, path, { Host: REMOTE_HOST, Origin: `https://${REMOTE_HOST}` });
      expect(res.status).toBe(421);
      expect((await errorOf(res)).code).toBe("HOST_NOT_ALLOWED");
    },
  );

  it.each(["/api/auth/recovery/register/options", "/api/auth/recovery/register/verify"])(
    "%s は cookie なしで 401",
    async (path) => {
      const res = await post(publicApp(), path, {});
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe("UNAUTHENTICATED");
    },
  );

  it.each(["/api/auth/recovery/register/options", "/api/auth/recovery/register/verify"])(
    "%s は通常のセッションで 401。一時セッションなら通る",
    async (path) => {
      const normal = await createTestSession();
      expect((await post(publicApp(), path, { Cookie: normal.cookie })).status).toBe(401);
      const recovery = await createTestSession({ kind: "recovery" });
      expect(passes(await post(publicApp(), path, { Cookie: recovery.cookie }))).toBe(true);
    },
  );

  it("recovery/register/* は10分を過ぎた一時セッションで 401", async () => {
    const old = await createTestSession({
      kind: "recovery",
      now: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    });
    const res = await post(publicApp(), "/api/auth/recovery/register/verify", {
      Cookie: old.cookie,
    });
    expect(res.status).toBe(401);
  });

  it("recovery/register/* は失効した一時セッションで 401", async () => {
    const s = await createTestSession({ kind: "recovery" });
    await store().revokeSession(s.id, new Date().toISOString());
    const res = await post(publicApp(), "/api/auth/recovery/register/options", {
      Cookie: s.cookie,
    });
    expect(res.status).toBe(401);
  });

  it.each([
    "/api/auth/sign-in/options",
    "/api/auth/sign-in/verify",
    "/api/auth/recovery/verify",
    "/api/auth/pairing/register/options",
    "/api/auth/pairing/register/verify",
  ])("%s は未サインインで通る", async (path) => {
    expect(passes(await post(publicApp(), path, {}))).toBe(true);
  });

  it("status・health は未サインインで通る", async () => {
    const a = publicApp();
    expect((await a.request("/api/auth/status", { headers: { Host: TEST_HOST } })).status).toBe(
      200,
    );
    expect((await a.request("/api/health", { headers: { Host: TEST_HOST } })).status).toBe(200);
  });
});

describe("セッションの発行（lib/session.ts、R5）", () => {
  it("トークンは 32 バイトの base64url で、DB にはハッシュだけが残る", async () => {
    const { token, id } = await issueSession(store(), {
      kind: "normal",
      rpId: "localhost",
      passkeyId: null,
      userAgent: "ua",
      id: randomUUIDv7(),
      now: new Date().toISOString(),
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await store().findSessionByTokenHash(hashToken(token));
    expect(row?.id).toBe(id);
    expect(row?.tokenHash).not.toBe(token);
    const rows = openRegistry().$client.prepare("SELECT * FROM sessions").all();
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("2回発行すると別のトークン", async () => {
    const mk = () =>
      issueSession(store(), {
        kind: "normal",
        rpId: "localhost",
        passkeyId: null,
        userAgent: null,
        id: randomUUIDv7(),
        now: new Date().toISOString(),
      });
    expect((await mk()).token).not.toBe((await mk()).token);
  });

  it("cookie は HttpOnly・SameSite=Strict・Path=/。https のときだけ Secure", async () => {
    const a = new Hono();
    a.get("/http", (c) => {
      setSessionCookie(c, "tok", { secure: false });
      return c.text("ok");
    });
    a.get("/https", (c) => {
      setSessionCookie(c, "tok", { secure: true });
      return c.text("ok");
    });
    const plain = (await a.request("/http")).headers.get("set-cookie") ?? "";
    expect(plain).toContain(`${SESSION_COOKIE}=tok`);
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("SameSite=Strict");
    expect(plain).toContain("Path=/");
    expect(plain).not.toContain("Secure");
    const secure = (await a.request("/https")).headers.get("set-cookie") ?? "";
    expect(secure).toContain("Secure");
  });
});
