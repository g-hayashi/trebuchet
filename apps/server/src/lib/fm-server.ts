import { spawn as nodeSpawn } from "node:child_process";
import { LOOPBACK_HOST } from "./origin.ts";
import { sleep } from "./util.ts";

/** 端末内の AI（`fm serve`）のモデル名。候補の `model` にも記録する */
export const LOCAL_AI_MODEL = "system";
/** `fm serve` の既定のポート（環境変数 `TREBUCHET_FM_PORT` は deps.ts が読む） */
export const FM_DEFAULT_PORT = 18790;

// 端末内の AI（Apple のオンデバイスモデル）を OpenAI 互換の API で出す `fm serve` の管理（006 R10）。
// 最初の推定のときに `fm models` の出力で確かめ、使えれば `fm serve` を子プロセスで起動して `/health` を待つ。
// `fm models` は `✓ system ()` のようにモデルごとに 1 行を出す。`pcc` が使えないだけでも終了コードは 1 になるので、
// 終了コードではなく `system` の行の `✓` を見る（`fm available` は非推奨の別名）。
// server の終了で止める。使えなければ（Intel の Mac、Apple Intelligence が無効など）端末内の段を飛ばす

/** 子プロセス。テストは偽物を渡す */
export type FmChild = {
  /** 終了（または起動の失敗）を知らせる。失敗は `null`。stdout を受け取る子は、stdout を読み終えてから呼ぶ */
  onExit(listener: (code: number | null) => void): void;
  /** stdout を受け取る（`captureStdout` を付けて起動した子だけ） */
  onStdout(listener: (chunk: string) => void): void;
  kill(): void;
};
export type FmSpawn = (
  command: string,
  args: string[],
  options?: { captureStdout?: boolean },
) => FmChild;

const defaultSpawn: FmSpawn = (command, args, options) => {
  const capture = options?.captureStdout === true;
  const child = nodeSpawn(command, args, {
    stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
  });
  child.stdout?.setEncoding("utf8");
  return {
    onExit(listener) {
      // stdout を読み切ってから知らせるため、capture のときは close を待つ
      child.once(capture ? "close" : "exit", (code) => listener(code));
      child.once("error", () => listener(null));
    },
    onStdout(listener) {
      child.stdout?.on("data", (chunk: string) => listener(chunk));
    },
    kill: () => {
      child.kill();
    },
  };
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI のエスケープを除く
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** `fm models` の出力で、`model` の行が使える（`✓`）か。ANSI の色は除いて見る */
function modelAvailable(output: string, model: string): boolean {
  const plain = output.replace(ANSI, "");
  return plain.split(/\r?\n/).some((line) => {
    const m = /^\s*✓\s+(\S+)/u.exec(line);
    return m?.[1] === model;
  });
}

export type FmServerOptions = {
  spawn?: FmSpawn;
  fetch?: typeof fetch;
  /** 既定は `fm`（PATH から探す） */
  command?: string;
  /** 既定は `FM_DEFAULT_PORT`（環境変数 `TREBUCHET_FM_PORT` は deps.ts が読む） */
  port?: number;
  /** `/health` を待つ上限（既定 30 秒） */
  healthTimeoutMs?: number;
  pollMs?: number;
  /** `fm models` を待つ上限（既定 10 秒） */
  availableTimeoutMs?: number;
  /** 使えるかを見るモデル名（既定 `LOCAL_AI_MODEL`） */
  model?: string;
  /** 起動に失敗してから、次に試すまでの間（既定 60 秒。1 件ごとに待たせない） */
  retryAfterMs?: number;
  now?: () => number;
};

export type FmServer = {
  /** `fm models` の出力に、使えるモデル（`✓ system`）の行があるか。最初の結果を覚える */
  available(): Promise<boolean>;
  /** 使えれば `fm serve` を（なければ）起動し、接続先（`http://<ループバック>:<port>`）を返す。使えなければ undefined */
  ensureStarted(): Promise<string | undefined>;
  /** 起動した子プロセスを止める（server の終了時） */
  stop(): void;
};

export function createFmServer(options: FmServerOptions = {}): FmServer {
  const spawn = options.spawn ?? defaultSpawn;
  const fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const command = options.command ?? "fm";
  const model = options.model ?? LOCAL_AI_MODEL;
  const port = options.port ?? FM_DEFAULT_PORT;
  const healthTimeoutMs = options.healthTimeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const availableTimeoutMs = options.availableTimeoutMs ?? 10_000;
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  const now = options.now ?? Date.now;
  const baseUrl = `http://${LOOPBACK_HOST}:${port}`;

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
      let stdout = "";
      try {
        proc = spawn(command, ["models"], { captureStdout: true });
      } catch {
        clearTimeout(timer);
        resolve(false);
        return;
      }
      proc.onStdout((chunk) => {
        stdout += chunk;
      });
      proc.onExit((code) => {
        clearTimeout(timer);
        // 終了コードは見ない（pcc が使えないだけで 1 になる）。起動の失敗（null）は使えない
        resolve(code !== null && modelAvailable(stdout, model));
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
      mine = spawn(command, ["serve", "--host", LOOPBACK_HOST, "--port", String(port)]);
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
