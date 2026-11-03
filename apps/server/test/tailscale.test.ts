import { describe, expect, it } from "vitest";
import {
  createTailscaleCli,
  TAILSCALE_APP_PATH,
  TailscaleError,
  type TailscaleExec,
} from "../src/lib/tailscale.ts";

// 偽の exec で、tailscale の CLI の呼び方（引数・実行ファイルの選び方）と JSON の解釈を確かめる。本物は呼ばない

type Call = { file: string; args: string[]; timeout: number };

const DNS = "Mac.tail1234.ts.net.";
const NAME = "mac.tail1234.ts.net";
const STATUS_RUNNING = JSON.stringify({ BackendState: "Running", Self: { DNSName: DNS } });
const serveJson = (proxy: string, key = `${NAME}:443`) =>
  JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: { [key]: { Handlers: { "/": { Proxy: proxy } } } },
  });

const enoent = () => Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });

/** 引数の並び（スペース区切り）ごとの応答。`Error` なら reject */
function fakeExec(responses: Record<string, string | Error>, options: { missing?: string[] } = {}) {
  const calls: Call[] = [];
  const exec: TailscaleExec = async (file, args, o) => {
    calls.push({ file, args, timeout: o.timeout });
    if (options.missing?.includes(file)) throw enoent();
    const r = responses[args.join(" ")];
    if (r === undefined) throw new Error(`unexpected args: ${args.join(" ")}`);
    if (r instanceof Error) throw r;
    return { stdout: r, stderr: "secret-stderr" };
  };
  return { exec, calls };
}

describe("createTailscaleCli.status", () => {
  it("Running で、serve が 127.0.0.1:<port> を指していれば serving: true（名前は小文字・末尾の . なし）", async () => {
    const { exec, calls } = fakeExec({
      "status --json": STATUS_RUNNING,
      "serve status --json": serveJson("http://127.0.0.1:8787"),
    });
    const cli = createTailscaleCli({ port: 8787, exec });
    expect(await cli.status()).toEqual({
      installed: true,
      running: true,
      dnsName: NAME,
      serving: true,
    });
    expect(calls.map((c) => c.file)).toEqual(["tailscale", "tailscale"]);
    expect(calls.every((c) => c.timeout === 10_000)).toBe(true);
  });

  it("serve が別のポートを指す・別の名前・設定なしは serving: false", async () => {
    for (const serve of [
      serveJson("http://127.0.0.1:9999"),
      serveJson("http://127.0.0.1:8787", "other.tail1234.ts.net:443"),
      "{}",
    ]) {
      const { exec } = fakeExec({ "status --json": STATUS_RUNNING, "serve status --json": serve });
      const s = await createTailscaleCli({ port: 8787, exec }).status();
      expect(s).toMatchObject({ installed: true, running: true, dnsName: NAME, serving: false });
    }
  });

  it("Running でなければ serve は調べず running: false・serving: false", async () => {
    const { exec, calls } = fakeExec({
      "status --json": JSON.stringify({ BackendState: "Stopped", Self: { DNSName: DNS } }),
    });
    const s = await createTailscaleCli({ port: 8787, exec }).status();
    expect(s).toEqual({ installed: true, running: false, dnsName: NAME, serving: false });
    expect(calls).toHaveLength(1);
  });

  it("PATH に tailscale がなければ Mac アプリの実行ファイルを使う", async () => {
    const { exec, calls } = fakeExec(
      {
        "status --json": STATUS_RUNNING,
        "serve status --json": serveJson("http://127.0.0.1:8787"),
      },
      { missing: ["tailscale"] },
    );
    const s = await createTailscaleCli({ port: 8787, exec }).status();
    expect(s.installed).toBe(true);
    expect(calls.at(-1)?.file).toBe(TAILSCALE_APP_PATH);
    expect(TAILSCALE_APP_PATH).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  });

  it("どちらもなければ installed: false", async () => {
    const { exec } = fakeExec({}, { missing: ["tailscale", TAILSCALE_APP_PATH] });
    expect(await createTailscaleCli({ port: 8787, exec }).status()).toEqual({
      installed: false,
      running: false,
      dnsName: null,
      serving: false,
    });
  });

  it("status --json の失敗（tailscaled に繋がらない等）は例外にせず、インストール済み・停止中として返す", async () => {
    const failing = fakeExec({ "status --json": new Error("secret-stderr exit 1") });
    expect(await createTailscaleCli({ port: 8787, exec: failing.exec }).status()).toEqual({
      installed: true,
      running: false,
      dnsName: null,
      serving: false,
    });
  });

  it("壊れた JSON は TAILSCALE_COMMAND_FAILED。stderr は含めない", async () => {
    const broken = fakeExec({ "status --json": "not json" });
    const e2 = await createTailscaleCli({ port: 8787, exec: broken.exec })
      .status()
      .catch((e: unknown) => e);
    expect((e2 as TailscaleError).code).toBe("TAILSCALE_COMMAND_FAILED");
  });
});

describe("createTailscaleCli.startServe / stopServe", () => {
  it("開始: serve --bg --https=443 http://127.0.0.1:<port>（Funnel・reset は使わない）", async () => {
    const { exec, calls } = fakeExec({
      "serve --bg --https=443 http://127.0.0.1:8787": "",
    });
    await createTailscaleCli({ port: 8787, exec }).startServe();
    expect(calls.map((c) => c.args)).toEqual([
      ["serve", "--bg", "--https=443", "http://127.0.0.1:8787"],
    ]);
  });

  it("停止: serve --https=443 off", async () => {
    const { exec, calls } = fakeExec({ "serve --https=443 off": "" });
    await createTailscaleCli({ port: 8787, exec }).stopServe();
    expect(calls.map((c) => c.args)).toEqual([["serve", "--https=443", "off"]]);
  });

  it("使う引数に funnel・reset が出ない", async () => {
    const { exec, calls } = fakeExec({
      "serve --bg --https=443 http://127.0.0.1:1234": "",
      "serve --https=443 off": "",
    });
    const cli = createTailscaleCli({ port: 1234, exec });
    await cli.startServe();
    await cli.stopServe();
    const all = calls.flatMap((c) => c.args).join(" ");
    expect(all).not.toMatch(/funnel|reset/i);
  });

  it("未インストールは TAILSCALE_NOT_FOUND、失敗は TAILSCALE_COMMAND_FAILED", async () => {
    const none = fakeExec({}, { missing: ["tailscale", TAILSCALE_APP_PATH] });
    const e1 = await createTailscaleCli({ port: 8787, exec: none.exec })
      .startServe()
      .catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(TailscaleError);
    expect((e1 as TailscaleError).code).toBe("TAILSCALE_NOT_FOUND");

    const failing = fakeExec({ "serve --https=443 off": new Error("boom") });
    const e2 = await createTailscaleCli({ port: 8787, exec: failing.exec })
      .stopServe()
      .catch((e: unknown) => e);
    expect((e2 as TailscaleError).code).toBe("TAILSCALE_COMMAND_FAILED");
  });
});
