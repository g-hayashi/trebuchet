import { DrizzleAuthStore, openAuth, openRegistry } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { type TailscaleCli, TailscaleError, type TailscaleStatus } from "../src/lib/tailscale.ts";
import { createTestSession, errorOf, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";

// 004 US4: リモートの設定画面が tailscale の serve の状態を見て開始・停止する API。本物の tailscale は呼ばない

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server");
});
afterEach(() => tmp.cleanup());

const REMOTE_HOST = "mac.tail1234.ts.net";
const REMOTE_ORIGIN = `https://${REMOTE_HOST}`;

const STOPPED: TailscaleStatus = {
  installed: true,
  running: true,
  dnsName: REMOTE_HOST,
  serving: false,
};
const SERVING: TailscaleStatus = { ...STOPPED, serving: true };

/** serve の状態を持つ偽物。呼ばれた操作を記録する */
function fakeCli(initial: TailscaleStatus = STOPPED, failWith?: TailscaleError) {
  let status = initial;
  const calls: string[] = [];
  const cli: TailscaleCli = {
    async status() {
      calls.push("status");
      if (failWith !== undefined) throw failWith;
      return status;
    },
    async startServe() {
      calls.push("start");
      if (failWith !== undefined) throw failWith;
      status = { ...status, serving: true };
    },
    async stopServe() {
      calls.push("stop");
      if (failWith !== undefined) throw failWith;
      status = { ...status, serving: false };
    },
  };
  return { cli, calls };
}

async function local() {
  const s = await createTestSession();
  return {
    Host: TEST_HOST,
    Origin: TEST_ORIGIN,
    Cookie: s.cookie,
    "Content-Type": "application/json",
  };
}

const putServe = (
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  body: unknown,
) =>
  app.request("/api/settings/remote/tailscale/serve", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

describe("GET /settings/remote/tailscale", () => {
  it("状態をそのまま返す", async () => {
    const { cli } = fakeCli(SERVING);
    const res = await createApp({ tailscale: cli }).request("/api/settings/remote/tailscale", {
      headers: await local(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SERVING);
  });

  it("未サインインは 401（cli は呼ばない）", async () => {
    const { cli, calls } = fakeCli();
    const res = await createApp({ tailscale: cli }).request("/api/settings/remote/tailscale", {
      headers: { Host: TEST_HOST },
    });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("ts.net の Host からは 421 HOST_NOT_ALLOWED（cli は呼ばない）", async () => {
    await new DrizzleAuthStore(openAuth(), openRegistry).setRemoteSettings(
      { enabled: true, host: REMOTE_HOST },
      "2026-11-02T00:00:00Z",
    );
    const s = await createTestSession({ rpId: REMOTE_HOST });
    const { cli, calls } = fakeCli();
    const res = await createApp({ tailscale: cli }).request("/api/settings/remote/tailscale", {
      headers: { Host: REMOTE_HOST, Cookie: s.cookie },
    });
    expect(res.status).toBe(421);
    expect((await errorOf(res)).code).toBe("HOST_NOT_ALLOWED");
    expect(calls).toEqual([]);
  });

  it("TAILSCALE_NOT_FOUND は 503、TAILSCALE_COMMAND_FAILED は 502", async () => {
    const headers = await local();
    const notFound = fakeCli(STOPPED, new TailscaleError("TAILSCALE_NOT_FOUND", "x"));
    const r1 = await createApp({ tailscale: notFound.cli }).request(
      "/api/settings/remote/tailscale",
      { headers },
    );
    expect(r1.status).toBe(503);
    expect((await errorOf(r1)).code).toBe("TAILSCALE_NOT_FOUND");

    const failed = fakeCli(STOPPED, new TailscaleError("TAILSCALE_COMMAND_FAILED", "x"));
    const r2 = await createApp({ tailscale: failed.cli }).request(
      "/api/settings/remote/tailscale",
      {
        headers,
      },
    );
    expect(r2.status).toBe(502);
    expect((await errorOf(r2)).code).toBe("TAILSCALE_COMMAND_FAILED");
  });
});

describe("PUT /settings/remote/tailscale/serve", () => {
  it("enabled: true で開始し、実行後の状態を返す", async () => {
    const { cli, calls } = fakeCli(STOPPED);
    const res = await putServe(createApp({ tailscale: cli }), await local(), { enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SERVING);
    expect(calls).toEqual(["start", "status"]);
  });

  it("enabled: false で停止し、実行後の状態を返す", async () => {
    const { cli, calls } = fakeCli(SERVING);
    const res = await putServe(createApp({ tailscale: cli }), await local(), { enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STOPPED);
    expect(calls).toEqual(["stop", "status"]);
  });

  it("本文の形が違えば 400 VALIDATION", async () => {
    const { cli, calls } = fakeCli();
    const res = await putServe(createApp({ tailscale: cli }), await local(), { enabled: "yes" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
    expect(calls).toEqual([]);
  });

  it("未サインインは 401", async () => {
    const { cli, calls } = fakeCli();
    const res = await putServe(
      createApp({ tailscale: cli }),
      { Host: TEST_HOST, Origin: TEST_ORIGIN, "Content-Type": "application/json" },
      { enabled: true },
    );
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("ts.net の Host からは 421 HOST_NOT_ALLOWED（cli は呼ばない）", async () => {
    await new DrizzleAuthStore(openAuth(), openRegistry).setRemoteSettings(
      { enabled: true, host: REMOTE_HOST },
      "2026-11-02T00:00:00Z",
    );
    const s = await createTestSession({ rpId: REMOTE_HOST });
    const { cli, calls } = fakeCli();
    const res = await putServe(
      createApp({ tailscale: cli }),
      {
        Host: REMOTE_HOST,
        Origin: REMOTE_ORIGIN,
        Cookie: s.cookie,
        "Content-Type": "application/json",
      },
      { enabled: true },
    );
    expect(res.status).toBe(421);
    expect((await errorOf(res)).code).toBe("HOST_NOT_ALLOWED");
    expect(calls).toEqual([]);
  });

  it("失敗は 502 TAILSCALE_COMMAND_FAILED、未インストールは 503 TAILSCALE_NOT_FOUND", async () => {
    const headers = await local();
    const failed = fakeCli(STOPPED, new TailscaleError("TAILSCALE_COMMAND_FAILED", "x"));
    const r1 = await putServe(createApp({ tailscale: failed.cli }), headers, { enabled: true });
    expect(r1.status).toBe(502);
    expect((await errorOf(r1)).code).toBe("TAILSCALE_COMMAND_FAILED");
    const none = fakeCli(STOPPED, new TailscaleError("TAILSCALE_NOT_FOUND", "x"));
    const r2 = await putServe(createApp({ tailscale: none.cli }), headers, { enabled: false });
    expect(r2.status).toBe(503);
    expect((await errorOf(r2)).code).toBe("TAILSCALE_NOT_FOUND");
  });
});
