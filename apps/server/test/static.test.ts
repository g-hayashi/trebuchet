import { randomUUIDv7 } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { TMP_ROOT } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import type { GetRemoteSettings } from "../src/lib/origin.ts";
import { resolveWebDist, withWebDist } from "../src/static.ts";
import { createTestSession, errorOf, TEST_HOST } from "./helpers.ts";

// T016b: server が web のビルド成果物を `/api` の外に配信する（R3、FR-003・011）。
// 認証は要らないが Host の検査は掛かる。`/api` の未知は 404 JSON、それ以外の未知は index.html

const INDEX = "<!doctype html><title>trebuchet</title>";
const REMOTE_HOST = "mac.tail1234.ts.net";

let tmp: TempDataDir;
let dist: string;
beforeEach(() => {
  tmp = useTempDataDir("server");
  dist = `${TMP_ROOT}web-dist-${randomUUIDv7()}`;
  mkdirSync(`${dist}/assets`, { recursive: true });
  writeFileSync(`${dist}/index.html`, INDEX);
  writeFileSync(`${dist}/assets/app.js`, "console.log(1)");
});
afterEach(() => {
  rmSync(dist, { recursive: true, force: true });
  tmp.cleanup();
});

const noRemote: GetRemoteSettings = async () => ({ enabled: false, host: null });
const build = (getRemoteSettings: GetRemoteSettings = noRemote) =>
  withWebDist(createApp({ getRemoteSettings }), { dist, getRemoteSettings });
const get = (a: ReturnType<typeof build>, path: string, host = TEST_HOST) =>
  a.request(path, { headers: { Host: host } });

describe("静的配信", () => {
  it("/ は index.html（認証なし）", async () => {
    const res = await get(build(), "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(INDEX);
  });

  it("ファイルはそのまま返る（content-type つき）", async () => {
    const res = await get(build(), "/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toBe("console.log(1)");
  });

  it("画面のパス（/e/x/blue-return）は index.html", async () => {
    const res = await get(build(), "/e/x/blue-return");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
  });

  it("/api/unknown は 404 JSON（index.html にしない）。/api の認証は従来どおり", async () => {
    const a = build();
    const unauth = await get(a, "/api/unknown");
    expect(unauth.status).toBe(401);
    expect(await get(a, "/api/health")).toHaveProperty("status", 200);
  });

  it("サインイン済みの /api/unknown は 404 JSON", async () => {
    const s = await createTestSession();
    const res = await build().request("/api/unknown", {
      headers: { Host: TEST_HOST, Cookie: s.cookie },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await errorOf(res)).code).toBe("NOT_FOUND");
  });

  it("許さない Host は静的にも 421 HOST_NOT_ALLOWED（/ も画面のパスも）", async () => {
    const a = build();
    for (const path of ["/", "/assets/app.js", "/e/x/blue-return"]) {
      const res = await get(a, path, "evil.example.com");
      expect(res.status, path).toBe(421);
      expect((await errorOf(res)).code).toBe("HOST_NOT_ALLOWED");
    }
  });

  it("リモートが有効なら ts.net の名前の Host で配信される。無効なら 421", async () => {
    const on: GetRemoteSettings = async () => ({ enabled: true, host: REMOTE_HOST });
    const a = build(on);
    expect((await get(a, "/", REMOTE_HOST)).status).toBe(200);
    expect((await get(build(), "/", REMOTE_HOST)).status).toBe(421);
  });

  it("パスの .. で dist の外のファイルを読めない", async () => {
    const res = await get(build(), "/../package.json");
    expect(await res.text()).toBe(INDEX);
  });
});

describe("resolveWebDist", () => {
  it("TREBUCHET_WEB_DIST の下に index.html があればそのパス。なければ undefined（配信しない）", () => {
    expect(resolveWebDist({ TREBUCHET_WEB_DIST: dist })).toBe(dist);
    expect(resolveWebDist({ TREBUCHET_WEB_DIST: `${dist}/missing` })).toBeUndefined();
    expect(resolveWebDist({ TREBUCHET_WEB_DIST: `${dist}/assets` })).toBeUndefined();
  });

  it("既定は apps/web/dist（なければ undefined。値は問わない）", () => {
    const r = resolveWebDist({});
    expect(r === undefined || r.endsWith("apps/web/dist")).toBe(true);
  });
});
