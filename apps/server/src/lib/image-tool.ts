import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  domainError,
  err,
  ok,
  type ReceiptImageTool,
  type ReceiptProbe,
  type Result,
} from "@trebuchet/domain";
import { RECEIPT_MAX_PIXELS, type ReceiptMediaType } from "@trebuchet/schema";

/**
 * 証憑の画像の変換（010/R12、contracts/domain-module.md §4）。macOS の `sips` を `execFile` で呼ぶ
 * （新しい依存を足さない）。HEIC → JPEG、PDF の 1 ページ目 → PNG → 長辺 2,048、
 * AI 用の JPEG のすべてが `sips` で足りる（`qlmanage` の代替は使わない）。
 *
 * - 作業ファイル（平文の写し）は `<tmpRoot>receipt-convert-<乱数>/` に書き、`finally` で必ず消す（R9）。
 *   起動時の掃除は `startup.ts`。子プロセスの `TMPDIR` も `tmpRoot`（`/tmp` に平文を書かせない）
 * - 時間切れ 20 秒。`sips` がない・失敗・時間切れは、`probe` は寸法なし（拒まない）、
 *   表示・AI 用は失敗として返す
 */

/** 作業ディレクトリの名前の接頭辞。`startup.ts` の掃除と同じ値 */
export const RECEIPT_CONVERT_DIR_PREFIX = "receipt-convert-";

export const IMAGE_TOOL_TIMEOUT_MS = 20_000;

/** AI 用の JPEG の品質 */
const AI_JPEG_QUALITY = "80";

export type ExecFn = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/** 既定の実行（`execFile`）。失敗・時間切れ（killed）は例外 */
export const defaultExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(error);
      else resolve({ stdout, stderr });
    });
  });

const EXTENSIONS: Record<ReceiptMediaType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

const conversionFailed = () =>
  err(domainError("RECEIPT_CONVERSION_FAILED", "画像を変換できませんでした"));

/** `sips -g` の出力（`  key: value` の行）を読む */
function sipsValue(stdout: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, "m").exec(stdout);
  return match?.[1];
}

function parseProbe(stdout: string): ReceiptProbe | undefined {
  const width = Number(sipsValue(stdout, "pixelWidth"));
  const height = Number(sipsValue(stdout, "pixelHeight"));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  const space = sipsValue(stdout, "space");
  const bitsText = sipsValue(stdout, "bitsPerSample");
  const bits = bitsText === undefined ? undefined : Number(bitsText);
  let fullColor: boolean | null = null;
  if (space !== undefined) {
    // フルカラーの目安: RGB で 1 色 8 ビット以上（階調。R3）
    fullColor = space.toUpperCase() === "RGB" && (bits === undefined || bits >= 8);
  }
  return { width, height, fullColor };
}

export function createImageTool(deps: { exec?: ExecFn; tmpRoot: string }): ReceiptImageTool {
  const exec = deps.exec ?? defaultExec;
  const env = { ...process.env, TMPDIR: deps.tmpRoot };

  const run = (args: string[]) => exec("sips", args, { timeout: IMAGE_TOOL_TIMEOUT_MS, env });

  /** 作業ディレクトリを作って fn に渡し、終わったら（失敗しても）消す */
  async function withWorkDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = join(deps.tmpRoot, `${RECEIPT_CONVERT_DIR_PREFIX}${randomUUID()}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** `sips <args> <input> --out <output>` を実行し、出力を読む。出力が作られなければ失敗 */
  async function convert(args: string[], input: string, output: string): Promise<Uint8Array> {
    await run([...args, input, "--out", output]);
    return new Uint8Array(await readFile(output));
  }

  return {
    async probe(bytes, mediaType): Promise<Result<ReceiptProbe | undefined>> {
      if (mediaType === "application/pdf") return ok(undefined);
      try {
        const probed = await withWorkDir(async (dir) => {
          const input = join(dir, `input.${EXTENSIONS[mediaType]}`);
          await writeFile(input, bytes, { mode: 0o600 });
          const { stdout } = await run([
            "-g",
            "pixelWidth",
            "-g",
            "pixelHeight",
            "-g",
            "space",
            "-g",
            "bitsPerSample",
            input,
          ]);
          return parseProbe(stdout);
        });
        if (probed !== undefined && probed.width * probed.height > RECEIPT_MAX_PIXELS) {
          return err(
            domainError("VALIDATION", "画像の画素数が大きすぎます", {
              maxPixels: RECEIPT_MAX_PIXELS,
            }),
          );
        }
        return ok(probed);
      } catch {
        // 寸法を返せないときは拒まない（保存はでき、警告が出ないだけ）
        return ok(undefined);
      }
    },

    async toDisplay(bytes, mediaType) {
      if (mediaType !== "image/heic") return ok({ bytes, mediaType });
      try {
        const converted = await withWorkDir(async (dir) => {
          const input = join(dir, `input.${EXTENSIONS[mediaType]}`);
          await writeFile(input, bytes, { mode: 0o600 });
          return convert(["-s", "format", "jpeg"], input, join(dir, "display.jpg"));
        });
        return ok({ bytes: converted, mediaType: "image/jpeg" });
      } catch {
        return conversionFailed();
      }
    },

    async toAiJpeg(bytes, mediaType, maxPx) {
      const isPdf = mediaType === "application/pdf";
      try {
        const jpeg = await withWorkDir(async (dir) => {
          const input = join(dir, `input.${EXTENSIONS[mediaType]}`);
          await writeFile(input, bytes, { mode: 0o600 });
          // PDF は 1 ページ目を PNG に描いてから縮小する
          const source = isPdf ? join(dir, "page.png") : input;
          if (isPdf) await convert(["-s", "format", "png"], input, source);
          return convert(
            ["-s", "format", "jpeg", "-s", "formatOptions", AI_JPEG_QUALITY, "-Z", String(maxPx)],
            source,
            join(dir, "ai.jpg"),
          );
        });
        return ok(jpeg);
      } catch {
        return isPdf
          ? err(domainError("RECEIPT_READ_UNSUPPORTED", "PDF の読み取りには対応していません"))
          : conversionFailed();
      }
    },
  };
}
