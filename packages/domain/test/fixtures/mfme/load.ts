// biome-ignore lint/style/noRestrictedImports: テストでフィクスチャのファイルを読むため（src では I/O をしない）
import { readFileSync } from "node:fs";

/** このディレクトリのフィクスチャを文字列で読む */
export function readTextFixture(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}
