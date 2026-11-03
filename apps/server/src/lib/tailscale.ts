import { execFile } from "node:child_process";
import type { TailscaleStatus } from "@trebuchet/schema";

export type { TailscaleStatus };

/**
 * tailscale の CLI を決まった引数だけで呼ぶ（004 US4）。シェルを通さず（`execFile`）、10 秒で打ち切る。
 * - 開始は `serve --bg --https=443 http://127.0.0.1:<port>`、停止は `serve --https=443 off`
 *   （`reset` は他の設定を消すので使わない。Funnel は使わない）
 * - stdout・stderr はログに出さず、エラーにも含めない
 */
export type TailscaleCli = {
  status(): Promise<TailscaleStatus>;
  startServe(): Promise<void>;
  stopServe(): Promise<void>;
};

export type TailscaleErrorCode = "TAILSCALE_NOT_FOUND" | "TAILSCALE_COMMAND_FAILED";

/** 型つきのエラー。ルートが DomainException に写す */
export class TailscaleError extends Error {
  readonly code: TailscaleErrorCode;
  constructor(code: TailscaleErrorCode, message: string) {
    super(message);
    this.name = "TailscaleError";
    this.code = code;
  }
}

export type TailscaleExec = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export const TAILSCALE_TIMEOUT_MS = 10_000;
export const TAILSCALE_APP_PATH = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const PATH_COMMAND = "tailscale";

/** 既定の実行（`execFile`）。失敗・時間切れ・見つからない（`code: "ENOENT"`）は例外 */
const defaultExec: TailscaleExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(error);
      else resolve({ stdout, stderr });
    });
  });

const isMissing = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";

const notFound = () =>
  new TailscaleError(
    "TAILSCALE_NOT_FOUND",
    "tailscale が見つかりません。Tailscale を入れてください",
  );
const commandFailed = () =>
  new TailscaleError("TAILSCALE_COMMAND_FAILED", "tailscale のコマンドが失敗しました");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseJson(stdout: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw commandFailed();
  }
  if (!isRecord(value)) throw commandFailed();
  return value;
}

function dnsNameOf(status: Record<string, unknown>): string | null {
  const self = status.Self;
  const name = isRecord(self) ? self.DNSName : undefined;
  if (typeof name !== "string") return null;
  const trimmed = name.replace(/\.$/, "").toLowerCase();
  return trimmed === "" ? null : trimmed;
}

/** `Web` に `<dnsName>:443` があり、その `/` のハンドラーが `http://127.0.0.1:<port>` を指すか */
function isServing(serve: Record<string, unknown>, dnsName: string, port: number): boolean {
  const web = serve.Web;
  if (!isRecord(web)) return false;
  const site = Object.entries(web).find(([key]) => key.toLowerCase() === `${dnsName}:443`)?.[1];
  const handlers = isRecord(site) ? site.Handlers : undefined;
  if (!isRecord(handlers)) return false;
  return Object.values(handlers).some((h) => isRecord(h) && h.Proxy === `http://127.0.0.1:${port}`);
}

export function createTailscaleCli({
  port,
  exec = defaultExec,
}: {
  port: number;
  exec?: TailscaleExec;
}): TailscaleCli {
  const target = `http://127.0.0.1:${port}`;

  /** PATH の `tailscale`、なければ Mac アプリの実行ファイル。どちらもなければ TAILSCALE_NOT_FOUND */
  async function run(args: string[]): Promise<string> {
    for (const file of [PATH_COMMAND, TAILSCALE_APP_PATH]) {
      try {
        return (await exec(file, args, { timeout: TAILSCALE_TIMEOUT_MS })).stdout;
      } catch (e) {
        if (isMissing(e)) continue;
        throw commandFailed();
      }
    }
    throw notFound();
  }

  return {
    async status() {
      let raw: string;
      try {
        raw = await run(["status", "--json"]);
      } catch (e) {
        if (e instanceof TailscaleError) {
          // 見つからない = 未インストール。実行の失敗（tailscaled に繋がらない等）= 停止中
          return {
            installed: e.code !== "TAILSCALE_NOT_FOUND",
            running: false,
            dnsName: null,
            serving: false,
          };
        }
        throw e;
      }
      const statusJson = parseJson(raw);
      const running = statusJson.BackendState === "Running";
      const dnsName = dnsNameOf(statusJson);
      if (!running || dnsName === null) {
        return { installed: true, running, dnsName, serving: false };
      }
      const serve = parseJson(await run(["serve", "status", "--json"]));
      return { installed: true, running, dnsName, serving: isServing(serve, dnsName, port) };
    },
    async startServe() {
      await run(["serve", "--bg", "--https=443", target]);
    },
    async stopServe() {
      await run(["serve", "--https=443", "off"]);
    },
  };
}
