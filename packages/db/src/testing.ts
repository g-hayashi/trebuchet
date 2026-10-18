import { randomUUIDv7 } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeAll } from "./tenant-store.ts";

/** テストの一時ファイルの置き場所（リポジトリ直下の .tmp/）。/tmp や os.tmpdir() は使わない */
export const TMP_ROOT = fileURLToPath(new URL("../../../.tmp/", import.meta.url));

export type TempDataDir = {
  dir: string;
  cleanup(): void;
};

/**
 * `.tmp/<uuid>/` を作り、TREBUCHET_DATA_DIR に設定する。
 * cleanup() で開いている DB を閉じ、ディレクトリを削除して環境変数を戻す。
 */
export function useTempDataDir(prefix = "db"): TempDataDir {
  const previous = process.env.TREBUCHET_DATA_DIR;
  const dir = `${TMP_ROOT}${prefix}-${randomUUIDv7()}`;
  mkdirSync(dir, { recursive: true });
  process.env.TREBUCHET_DATA_DIR = dir;
  return {
    dir,
    cleanup() {
      closeAll();
      rmSync(dir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.TREBUCHET_DATA_DIR;
      else process.env.TREBUCHET_DATA_DIR = previous;
    },
  };
}
