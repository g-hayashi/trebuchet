/**
 * 宣伝動画の変換（`pnpm promo:encode`。`pnpm promo:record` が録画のあとに呼ぶ）。
 *
 * 入力: `.tmp/promo/<lang>/video.webm` と `timeline.json`（`apps/web/e2e/promo.capture.ts` が書く）
 * 出力: `docs/promo/trebuchet-<lang>.mp4`（H.264、30fps、yuv420p、+faststart）
 *       `docs/promo/trebuchet-<lang>.gif`（0〜18 秒、幅 960px、12fps、palettegen/paletteuse。8 MB 以下が目安）
 *
 * 使い方: `node scripts/promo-encode.ts [ja] [en]`（省略で、`.tmp/promo/` にある言語すべて）
 * ffmpeg は環境変数 FFMPEG、なければ /opt/homebrew/bin/ffmpeg、なければ PATH の ffmpeg
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { TMP_ROOT } from "../packages/db/src/tenant-store.ts";

const root = resolve(import.meta.dirname, "..");
/** 録画の置き場所（`apps/web/e2e/promo.capture.ts` が書く） */
const PROMO_DIR = resolve(TMP_ROOT, "promo");
const FPS = 30;
const GIF_SECONDS = 18;
const GIF_WIDTH = 960;
const GIF_FPS = 12;
const GIF_TARGET_BYTES = 8 * 1024 * 1024;
const ffmpeg =
  process.env.FFMPEG ??
  (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");

type Timeline = {
  lang: string;
  scenes: { id: string; startMs: number; targetMs: number }[];
  cuts: { startMs: number; endMs: number }[];
  endMs: number;
};

function run(args: string[]): void {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error)
    throw new Error(`ffmpeg を実行できません（${ffmpeg}）: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg が失敗しました（${result.status}）`);
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

/** 録画の頭の余分（最初の場面の前）と、削る区間を除いた本編の映像のフィルター */
function trimFilter(timeline: Timeline): string {
  const first = timeline.scenes[0];
  if (first === undefined) throw new Error("timeline.json に場面がありません");
  const keep = `gte(t,${seconds(first.startMs)})*lt(t,${seconds(timeline.endMs)})`;
  const dropped = timeline.cuts.map((c) => `between(t,${seconds(c.startMs)},${seconds(c.endMs)})`);
  const drop = dropped.length === 0 ? "" : `*not(${dropped.join("+")})`;
  // 先に一定のフレームレートにそろえてから選び、番号で時刻を振り直す
  return `fps=${FPS},select='${keep}${drop}',setpts=N/(${FPS}*TB),format=yuv420p`;
}

function encodeMp4(timeline: Timeline, webm: string, mp4: string): void {
  run([
    "-i",
    webm,
    "-vf",
    trimFilter(timeline),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-movflags",
    "+faststart",
    mp4,
  ]);
}

/** 色数を減らしながら、目安の大きさ以下になるまで作る */
function encodeGif(mp4: string, gif: string): void {
  for (const colors of [128, 96, 64, 48]) {
    run([
      "-t",
      String(GIF_SECONDS),
      "-i",
      mp4,
      "-vf",
      `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      "-loop",
      "0",
      gif,
    ]);
    const size = statSync(gif).size;
    console.log(`  GIF ${colors} 色: ${(size / 1024 / 1024).toFixed(1)} MB`);
    if (size <= GIF_TARGET_BYTES) return;
  }
  console.warn(`  GIF が目安（8 MB）を超えています: ${gif}`);
}

const requested = process.argv.slice(2);
const langs =
  requested.length > 0 ? requested : ["ja", "en"].filter((l) => existsSync(resolve(PROMO_DIR, l)));
if (langs.length === 0)
  throw new Error("録画がありません。先に pnpm promo:capture を実行してください");

const outDir = resolve(root, "docs/promo");
mkdirSync(outDir, { recursive: true });
for (const lang of langs) {
  const dir = resolve(PROMO_DIR, lang);
  const webm = resolve(dir, "video.webm");
  const timelinePath = resolve(dir, "timeline.json");
  if (!existsSync(webm) || !existsSync(timelinePath)) {
    throw new Error(`録画がありません: ${dir}（video.webm と timeline.json が要ります）`);
  }
  const timeline = JSON.parse(readFileSync(timelinePath, "utf8")) as Timeline;
  const mp4 = resolve(outDir, `trebuchet-${lang}.mp4`);
  const gif = resolve(outDir, `trebuchet-${lang}.gif`);
  console.log(`変換: ${lang}`);
  encodeMp4(timeline, webm, mp4);
  console.log(`  MP4: ${mp4}（${(statSync(mp4).size / 1024 / 1024).toFixed(1)} MB）`);
  encodeGif(mp4, gif);
}
