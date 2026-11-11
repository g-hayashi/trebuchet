import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type DemoAssets,
  detectReceiptFormat,
  type ReceiptImageTool,
  type ReceiptProbe,
} from "@trebuchet/domain";

// デモ事業（014 R4）の合成の証憑の画像。`apps/server/assets/demo/` に同梱し、作成のときに読む
// （テストのフィクスチャを実行時に読まない。FR-006）。キーは `DemoPlan.receipts[].asset`、
// 拡張子は取り込むときのファイル名（`DemoReceipt.originalName`）に合わせる

const ASSET_DIR = resolve(import.meta.dirname, "../assets/demo");

const FILES = {
  "receipt-01": "receipt-01.jpg",
  "receipt-05": "receipt-05.jpg",
  "receipt-06": "receipt-06.png",
} as const;

const isKey = (key: string): key is keyof typeof FILES => Object.hasOwn(FILES, key);

/**
 * 同梱の画像を読む `DemoAssets`。知らないキーは例外（計画と素材の食い違い。createDemoEntity が `DEMO_FAILED` にする）。
 * `probes` は画像の寸法（`probeDemoAssets` が先に調べたもの）。無いキーは null
 */
function createDemoAssets(
  options: { dir?: string; probes?: ReadonlyMap<string, ReceiptProbe | null> } = {},
): DemoAssets {
  const dir = options.dir ?? ASSET_DIR;
  return {
    receiptImage(key) {
      if (!isKey(key)) throw new Error(`demo asset not found: ${key}`);
      return new Uint8Array(readFileSync(resolve(dir, FILES[key])));
    },
    receiptProbe: (key) => options.probes?.get(key) ?? null,
  };
}

/**
 * 同梱の画像の寸法を `imageTool.probe` で調べた `DemoAssets`（createDemoEntity は同期なので、先に await しておく）。
 * 調べられない（形式が違う・probe の失敗・例外）画像は null で続ける（寸法は無くても証憑は作れる）
 */
export async function loadDemoAssets(
  imageTool: Pick<ReceiptImageTool, "probe">,
  dir?: string,
): Promise<DemoAssets> {
  const base = createDemoAssets(dir === undefined ? {} : { dir });
  const probes = new Map<string, ReceiptProbe | null>();
  for (const key of Object.keys(FILES)) {
    probes.set(key, await probeOf(imageTool, base.receiptImage(key)));
  }
  return createDemoAssets({ ...(dir === undefined ? {} : { dir }), probes });
}

async function probeOf(
  imageTool: Pick<ReceiptImageTool, "probe">,
  bytes: Uint8Array,
): Promise<ReceiptProbe | null> {
  try {
    const mediaType = detectReceiptFormat(bytes);
    if (mediaType === undefined) return null;
    const probed = await imageTool.probe(bytes, mediaType);
    return probed.ok ? (probed.value ?? null) : null;
  } catch {
    return null;
  }
}
