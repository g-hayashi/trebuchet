// biome-ignore lint/style/noRestrictedImports: テストでフィクスチャのファイルを読むため（src では I/O をしない）
import { readFileSync } from "node:fs";

/** このディレクトリのフィクスチャをバイト列で読む */
export function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, import.meta.url)));
}
