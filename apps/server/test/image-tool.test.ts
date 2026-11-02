import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { RECEIPT_MAX_PIXELS } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImageTool, type ExecFn } from "../src/lib/image-tool.ts";

// T013: sips を呼ぶ画像の変換器（010/R12）。偽の exec を使い、sips は呼ばない

let tmp: TempDataDir;
let tmpRoot: string;
beforeEach(() => {
  tmp = useTempDataDir("server");
  tmpRoot = `${tmp.dir}/`;
});
afterEach(() => tmp.cleanup());

type Call = { file: string; args: string[]; timeout: number; tmpdir: string | undefined };

const BYTES = new Uint8Array([1, 2, 3, 4]);
const OUT = new Uint8Array([9, 9, 9]);

const probeOutput = (w: number, h: number, space = "RGB", bits = 8) =>
  `/work/in.jpg\n  pixelWidth: ${w}\n  pixelHeight: ${h}\n  space: ${space}\n  bitsPerSample: ${bits}\n`;

/** `--out <path>` に OUT を書く偽の sips。-g のときは stdout を返す */
function fakeExec(options: { probe?: string; fail?: (call: Call) => boolean } = {}) {
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args, opts) => {
    const call: Call = {
      file,
      args,
      timeout: opts.timeout,
      tmpdir: opts.env.TMPDIR,
    };
    calls.push(call);
    if (options.fail?.(call)) throw Object.assign(new Error("sips failed"), { code: 1 });
    const input = args.find((a) => a.includes("receipt-convert-"));
    // 入力は平文の写しとして作業ディレクトリに書かれている
    if (input !== undefined) expect((await readFile(input)).byteLength).toBeGreaterThan(0);
    const out = args.indexOf("--out");
    if (out >= 0) await writeFile(args[out + 1] ?? "", OUT);
    return { stdout: options.probe ?? "", stderr: "" };
  };
  return { exec, calls };
}

const leftovers = () => readdirSync(tmp.dir).filter((n) => n.startsWith("receipt-convert-"));

describe("probe", () => {
  it("sips -g で寸法と色を読む。引数・作業ファイル・TMPDIR・時間切れ 20 秒", async () => {
    const fake = fakeExec({ probe: probeOutput(4032, 3024) });
    const tool = createImageTool({ exec: fake.exec, tmpRoot });
    const result = await tool.probe(BYTES, "image/jpeg");
    expect(result).toEqual({ ok: true, value: { width: 4032, height: 3024, fullColor: true } });
    const [call] = fake.calls;
    expect(call?.file).toBe("sips");
    expect(call?.args.slice(0, 8)).toEqual([
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      "-g",
      "space",
      "-g",
      "bitsPerSample",
    ]);
    expect(call?.args.at(-1)).toContain("receipt-convert-");
    expect(call?.args.at(-1)).toMatch(/\.jpg$/);
    expect(call?.timeout).toBe(20_000);
    expect(call?.tmpdir).toBe(tmpRoot);
    expect(leftovers()).toEqual([]);
  });

  it("グレースケール・8 ビット未満は fullColor が false、色の情報がなければ null", async () => {
    const gray = createImageTool({
      exec: fakeExec({ probe: probeOutput(100, 100, "Gray") }).exec,
      tmpRoot,
    });
    expect(await gray.probe(BYTES, "image/png")).toEqual({
      ok: true,
      value: { width: 100, height: 100, fullColor: false },
    });
    const low = createImageTool({
      exec: fakeExec({ probe: probeOutput(100, 100, "RGB", 4) }).exec,
      tmpRoot,
    });
    expect(await low.probe(BYTES, "image/png")).toMatchObject({ value: { fullColor: false } });
    const none = createImageTool({
      exec: fakeExec({ probe: "x\n  pixelWidth: 10\n  pixelHeight: 20\n" }).exec,
      tmpRoot,
    });
    expect(await none.probe(BYTES, "image/png")).toEqual({
      ok: true,
      value: { width: 10, height: 20, fullColor: null },
    });
  });

  it("PDF は調べない（sips を呼ばず ok(undefined)）", async () => {
    const fake = fakeExec();
    const tool = createImageTool({ exec: fake.exec, tmpRoot });
    expect(await tool.probe(BYTES, "application/pdf")).toEqual({ ok: true, value: undefined });
    expect(fake.calls).toEqual([]);
  });

  it("1 億画素ちょうどは通り、1 億 + 1 は 422 VALIDATION（details.maxPixels）", async () => {
    const at = createImageTool({
      exec: fakeExec({ probe: probeOutput(10_000, 10_000) }).exec,
      tmpRoot,
    });
    expect(10_000 * 10_000).toBe(RECEIPT_MAX_PIXELS);
    expect(await at.probe(BYTES, "image/jpeg")).toMatchObject({ ok: true });

    const over = createImageTool({
      exec: fakeExec({ probe: probeOutput(100_000_001, 1) }).exec,
      tmpRoot,
    });
    const result = await over.probe(BYTES, "image/jpeg");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", details: { maxPixels: RECEIPT_MAX_PIXELS } },
    });
    expect(leftovers()).toEqual([]);
  });

  it("寸法を返せない（sips の失敗・時間切れ・読めない出力）は拒まず ok(undefined)。作業ディレクトリは残らない", async () => {
    const failing = createImageTool({ exec: fakeExec({ fail: () => true }).exec, tmpRoot });
    expect(await failing.probe(BYTES, "image/heic")).toEqual({ ok: true, value: undefined });
    const timeout = createImageTool({
      exec: async () => {
        throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
      },
      tmpRoot,
    });
    expect(await timeout.probe(BYTES, "image/heic")).toEqual({ ok: true, value: undefined });
    const garbage = createImageTool({ exec: fakeExec({ probe: "???" }).exec, tmpRoot });
    expect(await garbage.probe(BYTES, "image/heic")).toEqual({ ok: true, value: undefined });
    expect(leftovers()).toEqual([]);
  });
});

describe("toDisplay", () => {
  it("HEIC だけ sips で JPEG にする（原本は変えない）", async () => {
    const fake = fakeExec();
    const tool = createImageTool({ exec: fake.exec, tmpRoot });
    const result = await tool.toDisplay(BYTES, "image/heic");
    expect(result).toEqual({ ok: true, value: { bytes: OUT, mediaType: "image/jpeg" } });
    const [call] = fake.calls;
    expect(call?.args.slice(0, 3)).toEqual(["-s", "format", "jpeg"]);
    expect(call?.args).toContain("--out");
    expect(call?.timeout).toBe(20_000);
    expect(leftovers()).toEqual([]);
  });

  it("JPEG・PNG・PDF は原本をそのまま返し、sips を呼ばない", async () => {
    const fake = fakeExec();
    const tool = createImageTool({ exec: fake.exec, tmpRoot });
    for (const mediaType of ["image/jpeg", "image/png", "application/pdf"] as const) {
      expect(await tool.toDisplay(BYTES, mediaType)).toEqual({
        ok: true,
        value: { bytes: BYTES, mediaType },
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it("sips の失敗・時間切れ・出力が作られない場合は RECEIPT_CONVERSION_FAILED。作業ディレクトリは残らない", async () => {
    const failing = createImageTool({ exec: fakeExec({ fail: () => true }).exec, tmpRoot });
    expect(await failing.toDisplay(BYTES, "image/heic")).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_CONVERSION_FAILED" },
    });
    const timeout = createImageTool({
      exec: async () => {
        throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
      },
      tmpRoot,
    });
    expect(await timeout.toDisplay(BYTES, "image/heic")).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_CONVERSION_FAILED" },
    });
    // 何も出力しない sips（終了コード 0 でもファイルがない）
    const silent = createImageTool({ exec: async () => ({ stdout: "", stderr: "" }), tmpRoot });
    expect(await silent.toDisplay(BYTES, "image/heic")).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_CONVERSION_FAILED" },
    });
    expect(leftovers()).toEqual([]);
  });
});

describe("toAiJpeg", () => {
  it("画像は長辺 maxPx の JPEG（品質 80）にする", async () => {
    const fake = fakeExec();
    const tool = createImageTool({ exec: fake.exec, tmpRoot });
    const result = await tool.toAiJpeg(BYTES, "image/heic", 2048);
    expect(result).toEqual({ ok: true, value: OUT });
    expect(fake.calls).toHaveLength(1);
    const args = fake.calls[0]?.args ?? [];
    expect(args.slice(0, 7)).toEqual(["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z"]);
    expect(args[7]).toBe("2048");
    expect(leftovers()).toEqual([]);
  });

  it("PDF は 1 ページ目を PNG に描いてから JPEG に縮小する（2 回の sips）", async () => {
    const fake = fakeExec();
    const tool = createImageTool({ exec: fake.exec, tmpRoot });
    const result = await tool.toAiJpeg(BYTES, "application/pdf", 2048);
    expect(result).toEqual({ ok: true, value: OUT });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.args.slice(0, 3)).toEqual(["-s", "format", "png"]);
    expect(fake.calls[1]?.args).toContain("2048");
    expect(fake.calls[1]?.args.slice(0, 3)).toEqual(["-s", "format", "jpeg"]);
    expect(leftovers()).toEqual([]);
  });

  it("PDF を描けない（どちらの段の失敗でも）は RECEIPT_READ_UNSUPPORTED", async () => {
    for (const failAt of [1, 2]) {
      let n = 0;
      const fake = fakeExec({ fail: () => ++n === failAt });
      const tool = createImageTool({ exec: fake.exec, tmpRoot });
      expect(await tool.toAiJpeg(BYTES, "application/pdf", 2048)).toMatchObject({
        ok: false,
        error: { code: "RECEIPT_READ_UNSUPPORTED" },
      });
    }
    expect(leftovers()).toEqual([]);
  });

  it("画像の変換の失敗は RECEIPT_CONVERSION_FAILED", async () => {
    const tool = createImageTool({ exec: fakeExec({ fail: () => true }).exec, tmpRoot });
    expect(await tool.toAiJpeg(BYTES, "image/jpeg", 2048)).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_CONVERSION_FAILED" },
    });
    expect(leftovers()).toEqual([]);
  });
});
