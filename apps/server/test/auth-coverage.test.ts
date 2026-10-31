import { existsSync } from "node:fs";
import { clearDataKey, registryFile } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { requiresAuth } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { createTestSession, errorOf, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";

// T007: INV-29。公開の完全一致の一覧以外の全ルートは、未サインインで必ず 401。
// ルートを足したのに認証が掛かっていなければ、このテストが落ちる

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server");
});
afterEach(() => tmp.cleanup());

const SAMPLE_UUID = "0191f5a0-0000-7000-8000-000000000000";

/** `:entityId`・`:id{[0-9]+}`・`:name?`・`*` を適当な値で埋める */
function fillParams(path: string): string {
  return path
    .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, (m) =>
      m.startsWith(":entityId") ? SAMPLE_UUID : "1",
    )
    .replace(/\*/g, "x");
}

/** app.routes から (メソッド, パス) の組を列挙する。ミドルウェア（ALL）は除く */
function listRoutes(): { method: string; path: string }[] {
  const seen = new Set<string>();
  const out: { method: string; path: string }[] = [];
  for (const r of app.routes) {
    if (r.method === "ALL") continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

const protectedRoutes = () => listRoutes().filter((r) => requiresAuth(r.method, r.path));

describe("INV-29 全ルートの保護", () => {
  it("列挙したルートの数が下限を下回らない（列挙が空で素通りしない）", () => {
    expect(listRoutes().length).toBeGreaterThanOrEqual(40);
    expect(protectedRoutes().length).toBeGreaterThanOrEqual(35);
  });

  it("認証のルート（T008）を列挙が拾い、公開の名簿にないものは保護の対象になる", () => {
    const keys = new Set(listRoutes().map((r) => `${r.method} ${r.path}`));
    const protectedKeys = new Set(protectedRoutes().map((r) => `${r.method} ${r.path}`));
    for (const key of [
      "POST /api/auth/sign-out",
      "POST /api/auth/reauth/options",
      "POST /api/auth/reauth/verify",
      "GET /api/auth/passkeys",
      "POST /api/auth/passkeys/options",
      "POST /api/auth/passkeys/verify",
      "PATCH /api/auth/passkeys/:id",
      "DELETE /api/auth/passkeys/:id",
      "POST /api/auth/recovery/regenerate",
      "POST /api/auth/recovery/acknowledge",
      "GET /api/auth/sessions",
      "DELETE /api/auth/sessions/:id",
      "GET /api/auth/events",
    ]) {
      expect(keys.has(key), `${key} が app.routes にある`).toBe(true);
      expect(protectedKeys.has(key), `${key} が保護されている`).toBe(true);
    }
    for (const key of [
      "GET /api/auth/status",
      "POST /api/auth/register/options",
      "POST /api/auth/register/verify",
      "POST /api/auth/sign-in/options",
      "POST /api/auth/sign-in/verify",
      "POST /api/auth/recovery/verify",
      "POST /api/auth/recovery/register/options",
      "POST /api/auth/recovery/register/verify",
    ]) {
      expect(keys.has(key), `${key} が app.routes にある`).toBe(true);
      expect(protectedKeys.has(key), `${key} は公開の名簿`).toBe(false);
    }
  });

  it("保護された全ルートが、未サインインで 401 UNAUTHENTICATED", async () => {
    const failures: string[] = [];
    for (const { method, path } of protectedRoutes()) {
      const url = fillParams(path);
      const res = await app.request(url, {
        method,
        headers: { Host: TEST_HOST, Origin: TEST_ORIGIN },
      });
      if (res.status !== 401) {
        failures.push(`${method} ${path} -> ${res.status}`);
        continue;
      }
      if ((await errorOf(res)).code !== "UNAUTHENTICATED") failures.push(`${method} ${path} code`);
    }
    expect(failures).toEqual([]);
  });

  it("保護された全ルートが、有効なセッションでも施錠中は 401 LOCKED（008 の D5。DB を開く前に止まる）", async () => {
    const session = await createTestSession();
    clearDataKey();
    const failures: string[] = [];
    for (const { method, path } of protectedRoutes()) {
      const res = await app.request(fillParams(path), {
        method,
        headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie },
      });
      if (res.status !== 401 || (await errorOf(res)).code !== "LOCKED") {
        failures.push(`${method} ${path} -> ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
    expect(existsSync(registryFile())).toBe(false);
  });

  it("明細の取込（007）の layout・preview・確定は列挙に入り、保護されている。multipart でも未サインインは 401", async () => {
    const protectedKeys = new Set(protectedRoutes().map((r) => `${r.method} ${r.path}`));
    for (const path of ["layout", "preview"]) {
      expect(protectedKeys.has(`POST /api/entities/:entityId/statements/imports/${path}`)).toBe(
        true,
      );
    }
    expect(protectedKeys.has("POST /api/entities/:entityId/statements/imports")).toBe(true);
    for (const key of [
      "GET /api/entities/:entityId/statement-sources",
      "PATCH /api/entities/:entityId/statement-sources/:id",
      "DELETE /api/entities/:entityId/statement-sources/:id",
    ]) {
      expect(protectedKeys.has(key), `${key} が保護されている`).toBe(true);
    }
    for (const path of ["/imports/layout", "/imports/preview", "/imports"]) {
      const body = new FormData();
      body.append("file", new File(["a\tb"], "x.txt"));
      body.append("options", JSON.stringify({ origin: "paste" }));
      const res = await app.request(`/api/entities/${SAMPLE_UUID}/statements${path}`, {
        method: "POST",
        headers: { Host: TEST_HOST, Origin: TEST_ORIGIN },
        body,
      });
      expect(res.status, path).toBe(401);
    }
  });

  it("存在しない事業体の ID でも 404 ではなく 401（認証がテナントの解決より先）", async () => {
    const res = await app.request(`/api/entities/${SAMPLE_UUID}/accounts`, {
      headers: { Host: TEST_HOST },
    });
    expect(res.status).toBe(401);
  });

  it("ルートの一覧にない保護された名前（/api/auth/recovery/regenerate）も未サインインで 401", async () => {
    const res = await app.request("/api/auth/recovery/regenerate", {
      method: "POST",
      headers: { Host: TEST_HOST, Origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("UNAUTHENTICATED");
  });

  it("公開の一覧にない /api/auth/* と未知のパスも 401（ワイルドカードで公開にしない）", async () => {
    const cases: [string, string][] = [
      ["GET", "/api/auth/anything"],
      ["POST", "/api/auth/register/options/"],
      ["GET", "/api/auth/status/"],
      ["POST", "/api/health"],
      ["GET", "/api/unknown"],
    ];
    for (const [method, path] of cases) {
      const res = await app.request(path, {
        method,
        headers: { Host: TEST_HOST, Origin: TEST_ORIGIN },
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
