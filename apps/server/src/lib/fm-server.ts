import { spawn as nodeSpawn } from "node:child_process";

// 端末内の AI（Apple のオンデバイスモデル）を OpenAI 互換の API で出す `fm serve` の管理（006 R10）。
// 最初の推定のときに `fm available` で確かめ、使えれば `fm serve` を子プロセスで起動して `/health` を待つ。
// server の終了で止める。使えなければ（Intel の Mac、Apple Intelligence が無効など）端末内の段を飛ばす

/** 子プロセス。テストは偽物を渡す */
export type FmChild = {
  /** 終了（または起動の失敗）を知らせる。失敗は `null` */
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
};
export type FmSpawn = (command: string, args: string[]) => FmChild;

const defaultSpawn: FmSpawn = (command, args) => {
  const child = nodeSpawn(command, args, { stdio: "ignore" });
  return {
    onExit(listener) {
      child.once("exit", (code) => listener(code));
      child.once("error", () => listener(null));
    },
    kill: () => {
      child.kill();
    },
  };
};

export type FmServerOptions = {
  spawn?: FmSpawn;
  fetch?: typeof fetch;
  /** 既定は `fm`（PATH から探す） */
  command?: string;
  /** 既定は 18790（環境変数 `TREBUCHET_FM_PORT` は deps.ts が読む） */
  port?: number;
  /** `/health` を待つ上限（既定 30 秒） */
  healthTimeoutMs?: number;
  pollMs?: number;
  /** `fm available` を待つ上限（既定 10 秒） */
  availableTimeoutMs?: number;
  /** 起動に失敗してから、次に試すまでの間（既定 60 秒。1 件ごとに待たせない） */
  retryAfterMs?: number;
  now?: () => number;
};

export type FmServer = {
  /** `fm available` が 0 で終わるか。最初の結果を覚える */
  available(): Promise<boolean>;
  /** 使えれば `fm serve` を（なければ）起動し、接続先（`http://127.0.0.1:<port>`）を返す。使えなければ undefined */
  ensureStarted(): Promise<string | undefined>;
  /** 起動した子プロセスを止める（server の終了時） */
  stop(): void;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFmServer(options: FmServerOptions = {}): FmServer {
  const spawn = options.spawn ?? defaultSpawn;
  const fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const command = options.command ?? "fm";
  const port = options.port ?? 18790;
  const healthTimeoutMs = options.healthTimeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const availableTimeoutMs = options.availableTimeoutMs ?? 10_000;
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  const now = options.now ?? Date.now;
  const baseUrl = `http://127.0.0.1:${port}`;

  let availability: Promise<boolean> | undefined;
  let child: FmChild | undefined;
  let starting: Promise<string | undefined> | undefined;
  let failedAt: number | undefined;

  const checkAvailable = (): Promise<boolean> =>
    new Promise((resolve) => {
      let proc: FmChild | undefined;
      const timer = setTimeout(() => {
        proc?.kill();
        resolve(false);
      }, availableTimeoutMs);
      try {
        proc = spawn(command, ["available"]);
      } catch {
        clearTimeout(timer);
        resolve(false);
        return;
      }
      proc.onExit((code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });

  const healthy = async (): Promise<boolean> => {
    try {
      const res = await fetchFn(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  };

  const start = async (): Promise<string | undefined> => {
    if (!(await server.available())) return undefined;
    let mine: FmChild;
    try {
      mine = spawn(command, ["serve", "--host", "127.0.0.1", "--port", String(port)]);
    } catch {
      return undefined;
    }
    child = mine;
    let exited = false;
    mine.onExit(() => {
      exited = true;
      // 起動した後に落ちたら、次の呼び出しで起動し直す
      if (child === mine) {
        child = undefined;
        starting = undefined;
      }
    });
    // 待ちは実時間（`now` は起動に失敗した後の冷却の判定だけに使う）
    const startedAt = Date.now();
    while (child === mine && !exited && Date.now() - startedAt < healthTimeoutMs) {
      if (await healthy()) return child === mine && !exited ? baseUrl : undefined;
      await sleep(pollMs);
    }
    if (child === mine) child = undefined;
    mine.kill();
    return undefined;
  };

  const server: FmServer = {
    available() {
      availability ??= checkAvailable();
      return availability;
    },
    async ensureStarted() {
      if (starting !== undefined) return starting;
      if (failedAt !== undefined && now() - failedAt < retryAfterMs) return undefined;
      const attempt = start();
      starting = attempt;
      const url = await attempt;
      if (url === undefined) {
        failedAt = now();
        if (starting === attempt) starting = undefined;
      }
      return url;
    },
    stop() {
      const running = child;
      child = undefined;
      starting = undefined;
      running?.kill();
    },
  };
  return server;
}
