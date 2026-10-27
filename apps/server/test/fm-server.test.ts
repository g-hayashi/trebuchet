import { describe, expect, it, vi } from "vitest";
import { createFmServer, type FmChild, type FmSpawn } from "../src/lib/fm-server.ts";

// 006 R10: `fm models` の出力で確かめ、使えれば `fm serve --host 127.0.0.1 --port <port>` を子プロセスで起動し、
// `/health` を待つ。実プロセス・ネットワークには触れない（偽の spawn・fetch）

type FakeChild = FmChild & {
  command: string;
  args: string[];
  killed: boolean;
  exit(code: number | null): void;
};

/** 実機の `fm models` の出力（system は使え、pcc は使えない） */
const MODELS_OK = [
  "  Apple Foundation Models\n",
  "  ✓ system ()\n",
  "  ✗ pcc        (Using Private Cloud Compute requires an iCloud account.)\n",
];
const MODELS_NG = [
  "  Apple Foundation Models\n",
  "  ✗ system (Apple Intelligence is not enabled)\n",
];

/**
 * 起動した子プロセスを記録する偽の spawn。`models` の子は stdout を流してから終了コードで終わる。
 * 既定は実機と同じ（system が使え、pcc が使えないので終了コード 1）
 */
function fakeSpawn(
  options: { modelsOut?: string[]; modelsCode?: number | null; spawnThrows?: boolean } = {},
) {
  const children: FakeChild[] = [];
  const spawn: FmSpawn = (command, args) => {
    if (options.spawnThrows) throw new Error("spawn ENOENT");
    let onExit: (code: number | null) => void = () => {};
    let onStdout: (chunk: string) => void = () => {};
    const child: FakeChild = {
      command,
      args,
      killed: false,
      onExit: (cb) => {
        onExit = cb;
      },
      onStdout: (cb) => {
        onStdout = cb;
      },
      kill: () => {
        child.killed = true;
      },
      exit: (code) => onExit(code),
    };
    children.push(child);
    if (args[0] === "models") {
      queueMicrotask(() => {
        for (const chunk of options.modelsOut ?? MODELS_OK) onStdout(chunk);
        child.exit("modelsCode" in options ? (options.modelsCode ?? null) : 1);
      });
    }
    return child;
  };
  return { spawn, children, serves: () => children.filter((c) => c.args[0] === "serve") };
}

const ok = () => new Response('{"status":"ok"}', { status: 200 });

const make = (over: Partial<Parameters<typeof createFmServer>[0]> = {}) =>
  createFmServer({ pollMs: 1, healthTimeoutMs: 200, availableTimeoutMs: 200, ...over });

describe("createFmServer: available", () => {
  it("`✓ system` があれば、`✗ pcc` で終了コード 1 でも true。結果は覚えて、2 回目は子プロセスを起動しない", async () => {
    const { spawn, children } = fakeSpawn({ modelsCode: 1 });
    const fm = make({ spawn, fetch: vi.fn() as unknown as typeof fetch });
    expect(await fm.available()).toBe(true);
    expect(await fm.available()).toBe(true);
    expect(children).toHaveLength(1);
    expect(children[0]?.command).toBe("fm");
  });

  it("引数は `models` だけ（`available` や モデル名は渡さない）", async () => {
    const { spawn, children } = fakeSpawn();
    await make({ spawn }).available();
    expect(children[0]?.args).toEqual(["models"]);
  });

  it("終了コードが 0 でも `✓ system` がなければ false。`✗ system` も false", async () => {
    expect(
      await make({ spawn: fakeSpawn({ modelsOut: MODELS_NG, modelsCode: 0 }).spawn }).available(),
    ).toBe(false);
    expect(
      await make({ spawn: fakeSpawn({ modelsOut: [], modelsCode: 0 }).spawn }).available(),
    ).toBe(false);
    // 別のモデルだけが使える（system で始まる別名も system ではない）
    const other = ["  ✓ pcc ()\n", "  ✓ systemx ()\n"];
    expect(
      await make({ spawn: fakeSpawn({ modelsOut: other, modelsCode: 0 }).spawn }).available(),
    ).toBe(false);
  });

  it("ANSI の色つきの出力でも判定できる。チャンクが行の途中で切れても判定できる", async () => {
    const colored = [
      "\u001b[1m  Apple Foundation Models\u001b[0m\n",
      "  \u001b[32m✓\u001b[0m \u001b[1msystem\u001b[0m ()\n",
    ];
    expect(await make({ spawn: fakeSpawn({ modelsOut: colored }).spawn }).available()).toBe(true);
    const split = ["  Apple Foundation Models\n  ✓ sys", "tem ()\n  ✗ pcc (x)\n"];
    expect(await make({ spawn: fakeSpawn({ modelsOut: split }).spawn }).available()).toBe(true);
    const coloredNg = ["  \u001b[31m✗\u001b[0m system (x)\n"];
    expect(await make({ spawn: fakeSpawn({ modelsOut: coloredNg }).spawn }).available()).toBe(
      false,
    );
  });

  it("モデル名は options.model で変えられる", async () => {
    const out = ["  ✗ system ()\n", "  ✓ other ()\n"];
    expect(
      await make({ spawn: fakeSpawn({ modelsOut: out }).spawn, model: "other" }).available(),
    ).toBe(true);
  });

  it("起動の失敗（fm がない、終了コード null）、例外はすべて false", async () => {
    expect(await make({ spawn: fakeSpawn({ modelsCode: null }).spawn }).available()).toBe(false);
    expect(await make({ spawn: fakeSpawn({ spawnThrows: true }).spawn }).available()).toBe(false);
  });

  it("終わらない `fm models` は時間切れで false にし、子プロセスを止める", async () => {
    const { spawn, children } = fakeSpawn();
    const hang: FmSpawn = (command, args) => {
      const child = spawn(command, args);
      return { onExit: () => {}, onStdout: () => {}, kill: () => child.kill() };
    };
    const fm = make({ spawn: hang, availableTimeoutMs: 10 });
    expect(await fm.available()).toBe(false);
    expect(children[0]?.killed).toBe(true);
  });
});

describe("createFmServer: ensureStarted", () => {
  it("使えなければ起動せず undefined", async () => {
    const { spawn, serves } = fakeSpawn({ modelsOut: MODELS_NG, modelsCode: 1 });
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
