// biome-ignore lint/style/noRestrictedImports: テストでフィクスチャのファイルを読むため（src では I/O をしない）
import { readFileSync } from "node:fs";

/** このディレクトリのフィクスチャをバイト列で読む（文字コードの判定 `decodeText` に渡す） */
export function readStatementFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, import.meta.url)));
}

/** このディレクトリのフィクスチャを UTF-8 の文字列で読む（UTF-8 のファイルだけ） */
export function readStatementText(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}
