/**
 * 宣伝動画の変換（`pnpm promo:encode`。`pnpm promo:record` が録画のあとに呼ぶ）。
 *
 * 入力: `.tmp/promo/<lang>/video.webm`、`timeline.json`、`captions/<場面>.png`（`apps/web/e2e/promo.capture.ts` が書く）
 * 映像の下に字幕の帯（`captionHeight`）を足し、各場面の字幕の画像をその場面の間だけ重ねる（画面に被せない）
 * 出力: `docs/promo/trebuchet-<lang>.mp4`（H.264、30fps、yuv420p、+faststart）
 *       `docs/promo/trebuchet-<lang>.gif`（0〜21 秒。証憑の場面の終わりまで。幅 960px、12fps、palettegen/paletteuse。8 MB 以下が目安）
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
const GIF_SECONDS = 21;
const GIF_WIDTH = 960;
const GIF_FPS = 12;
const GIF_TARGET_BYTES = 8 * 1024 * 1024;
/** 字幕の帯の色（字幕の画像の背景と同じ。`apps/web/e2e/promo.capture.ts` の CAPTION_BACKGROUND） */
const CAPTION_BACKGROUND = "0x0f172a";
const ffmpeg =
  process.env.FFMPEG ??
  (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");

type Timeline = {
  lang: string;
  captionHeight: number;
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

/** 字幕の画像がある場面と、その画像を出す区間（録画の時刻。次の場面の開始まで） */
function captionSpans(timeline: Timeline, dir: string) {
  return timeline.scenes.flatMap((scene, index) => {
    const image = resolve(dir, "captions", `${scene.id}.png`);
    if (!existsSync(image)) return [];
    const endMs = timeline.scenes[index + 1]?.startMs ?? timeline.endMs;
    return [{ image, startMs: scene.startMs, endMs }];
  });
}

/**
 * 字幕の帯を足して字幕を重ね、録画の頭の余分（最初の場面の前）と削る区間を除いた本編の映像のフィルター。
 * 入力 0 が録画、1 以降が `spans` の順の字幕の画像。字幕は録画の時刻で重ねてから削る
 */
function videoFilter(timeline: Timeline, spans: { startMs: number; endMs: number }[]): string {
  const first = timeline.scenes[0];
  if (first === undefined) throw new Error("timeline.json に場面がありません");
  const keep = `gte(t,${seconds(first.startMs)})*lt(t,${seconds(timeline.endMs)})`;
  const dropped = timeline.cuts.map((c) => `between(t,${seconds(c.startMs)},${seconds(c.endMs)})`);
  const drop = dropped.length === 0 ? "" : `*not(${dropped.join("+")})`;
  // 先に一定のフレームレートにそろえ、帯を足す
  const steps = [
    `[0:v]fps=${FPS},pad=iw:ih+${timeline.captionHeight}:0:0:color=${CAPTION_BACKGROUND}[v0]`,
  ];
  spans.forEach((span, index) => {
    const enable = `between(t,${seconds(span.startMs)},${seconds(span.endMs)})`;
    steps.push(
      `[v${index}][${index + 1}:v]overlay=0:main_h-overlay_h:enable='${enable}'[v${index + 1}]`,
    );
  });
  // 選んだフレームの番号で時刻を振り直す
  steps.push(`[v${spans.length}]select='${keep}${drop}',setpts=N/(${FPS}*TB),format=yuv420p[out]`);
  return steps.join(";");
}

function encodeMp4(timeline: Timeline, dir: string, mp4: string): void {
  const spans = captionSpans(timeline, dir);
  // 字幕の画像は録画の長さだけ繰り返す（overlay の enable で出す区間を決める）
  const imageInputs = spans.flatMap((span) => [
    "-loop",
    "1",
    "-framerate",
    String(FPS),
    "-t",
    seconds(timeline.endMs),
    "-i",
    span.image,
  ]);
  run([
    "-i",
    resolve(dir, "video.webm"),
    ...imageInputs,
    "-filter_complex",
    videoFilter(timeline, spans),
    "-map",
    "[out]",
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
  encodeMp4(timeline, dir, mp4);
  console.log(`  MP4: ${mp4}（${(statSync(mp4).size / 1024 / 1024).toFixed(1)} MB）`);
  encodeGif(mp4, gif);
}
