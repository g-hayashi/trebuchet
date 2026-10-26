import { describe, expect, it, vi } from "vitest";
import { createFmServer, type FmChild, type FmSpawn } from "../src/lib/fm-server.ts";

// 006 R10: `fm available` で確かめ、使えれば `fm serve --host 127.0.0.1 --port <port>` を子プロセスで起動し、
// `/health` を待つ。実プロセス・ネットワークには触れない（偽の spawn・fetch）

type FakeChild = FmChild & {
  command: string;
  args: string[];
  killed: boolean;
  exit(code: number | null): void;
};

/** 起動した子プロセスを記録する偽の spawn。`available` の子は終了コードですぐ終わる */
function fakeSpawn(options: { availableCode?: number | null; spawnThrows?: boolean } = {}) {
  const children: FakeChild[] = [];
  const spawn: FmSpawn = (command, args) => {
    if (options.spawnThrows) throw new Error("spawn ENOENT");
    let onExit: (code: number | null) => void = () => {};
    const child: FakeChild = {
      command,
      args,
      killed: false,
      onExit: (cb) => {
        onExit = cb;
      },
      kill: () => {
        child.killed = true;
      },
      exit: (code) => onExit(code),
    };
    children.push(child);
    if (args[0] === "available") {
      queueMicrotask(() =>
        child.exit("availableCode" in options ? (options.availableCode ?? null) : 0),
      );
    }
    return child;
  };
  return { spawn, children, serves: () => children.filter((c) => c.args[0] === "serve") };
}

const ok = () => new Response('{"status":"ok"}', { status: 200 });

const make = (over: Partial<Parameters<typeof createFmServer>[0]> = {}) =>
  createFmServer({ pollMs: 1, healthTimeoutMs: 200, availableTimeoutMs: 200, ...over });

describe("createFmServer: available", () => {
  it("`fm available` が 0 で終わるなら true。結果は覚えて、2 回目は子プロセスを起動しない", async () => {
    const { spawn, children } = fakeSpawn();
    const fm = make({ spawn, fetch: vi.fn() as unknown as typeof fetch });
    expect(await fm.available()).toBe(true);
    expect(await fm.available()).toBe(true);
    expect(children).toHaveLength(1);
    expect(children[0]?.command).toBe("fm");
    expect(children[0]?.args).toEqual(["available"]);
  });

  it("0 以外の終了、起動の失敗（fm がない）、例外はすべて false", async () => {
    expect(await make({ spawn: fakeSpawn({ availableCode: 1 }).spawn }).available()).toBe(false);
    expect(await make({ spawn: fakeSpawn({ availableCode: null }).spawn }).available()).toBe(false);
    expect(await make({ spawn: fakeSpawn({ spawnThrows: true }).spawn }).available()).toBe(false);
  });

  it("終わらない `fm available` は時間切れで false にし、子プロセスを止める", async () => {
    const { spawn, children } = fakeSpawn();
    const hang: FmSpawn = (command, args) => {
      const child = spawn(command, args);
      return { onExit: () => {}, kill: () => child.kill() };
    };
    const fm = make({ spawn: hang, availableTimeoutMs: 10 });
    expect(await fm.available()).toBe(false);
    expect(children[0]?.killed).toBe(true);
  });
});

describe("createFmServer: ensureStarted", () => {
  it("使えなければ起動せず undefined", async () => {
    const { spawn, serves } = fakeSpawn({ availableCode: 1 });
    const fm = make({ spawn, fetch: vi.fn() as unknown as typeof fetch });
    expect(await fm.ensureStarted()).toBeUndefined();
    expect(serves()).toHaveLength(0);
  });

  it("`fm serve --host 127.0.0.1 --port <port>` を起動し、/health が成功したら接続先を返す。2 回目は起動しない", async () => {
    const { spawn, serves } = fakeSpawn();
    let health = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("http://127.0.0.1:18791/health");
      health += 1;
      return health < 3 ? new Response("starting", { status: 503 }) : ok();
    });
    const fm = make({ spawn, fetch: fetchFn as unknown as typeof fetch, port: 18791 });
    expect(await fm.ensureStarted()).toBe("http://127.0.0.1:18791");
    expect(serves()).toHaveLength(1);
    expect(serves()[0]?.args).toEqual(["serve", "--host", "127.0.0.1", "--port", "18791"]);
    expect(health).toBe(3);
    expect(await fm.ensureStarted()).toBe("http://127.0.0.1:18791");
    expect(serves()).toHaveLength(1);
  });

  it("既定のポートは 18790", async () => {
    const { spawn, serves } = fakeSpawn();
    const fm = make({ spawn, fetch: (async () => ok()) as unknown as typeof fetch });
    expect(await fm.ensureStarted()).toBe("http://127.0.0.1:18790");
    expect(serves()[0]?.args.at(-1)).toBe("18790");
  });

  it("同時に呼んでも起動は 1 回", async () => {
    const { spawn, serves } = fakeSpawn();
    const fm = make({ spawn, fetch: (async () => ok()) as unknown as typeof fetch });
    const urls = await Promise.all([fm.ensureStarted(), fm.ensureStarted(), fm.ensureStarted()]);
    expect(new Set(urls).size).toBe(1);
    expect(serves()).toHaveLength(1);
  });

  it("/health が時間内に成功しなければ子プロセスを止めて undefined。一定時間は再起動を試みない", async () => {
    const { spawn, serves } = fakeSpawn();
    let nowMs = 1_000_000;
    const fm = make({
      spawn,
      fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
      healthTimeoutMs: 15,
      retryAfterMs: 60_000,
      now: () => nowMs,
    });
    expect(await fm.ensureStarted()).toBeUndefined();
    expect(serves()[0]?.killed).toBe(true);
    // 冷却の間は起動を試みない
    expect(await fm.ensureStarted()).toBeUndefined();
    expect(serves()).toHaveLength(1);
    // 冷却が明ければもう一度試す
    nowMs += 60_001;
    await fm.ensureStarted();
    expect(serves()).toHaveLength(2);
  });

  it("起動の途中で子プロセスが終了したら、待たずに undefined", async () => {
    const { spawn, serves } = fakeSpawn();
    const fm = make({
      spawn,
      healthTimeoutMs: 5_000,
      fetch: (async () => {
        serves()[0]?.exit(1);
        return new Response("", { status: 503 });
      }) as unknown as typeof fetch,
    });
    expect(await fm.ensureStarted()).toBeUndefined();
  });

  it("起動した後に子プロセスが落ちたら、次の呼び出しで起動し直す", async () => {
    const { spawn, serves } = fakeSpawn();
    const fm = make({ spawn, fetch: (async () => ok()) as unknown as typeof fetch });
    await fm.ensureStarted();
    serves()[0]?.exit(1);
    expect(await fm.ensureStarted()).toBe("http://127.0.0.1:18790");
    expect(serves()).toHaveLength(2);
  });
});

describe("createFmServer: stop", () => {
  it("起動した子プロセスを止める。起動していなければ何もしない", async () => {
    const { spawn, serves } = fakeSpawn();
    const fm = make({ spawn, fetch: (async () => ok()) as unknown as typeof fetch });
    fm.stop();
    await fm.ensureStarted();
    fm.stop();
    expect(serves()[0]?.killed).toBe(true);
  });
});
