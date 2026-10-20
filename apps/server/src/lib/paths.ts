import { fileURLToPath } from "node:url";

/** 一時ファイルの置き場所（リポジトリ直下の `.tmp/`）。`/tmp` や `os.tmpdir()` は使わない */
export const TMP_ROOT = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
