import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { TMP_ROOT } from "./env.ts";

/** E2E 用のデータ（.tmp/e2e-<uuid>）を消す。リポジトリの .tmp 直下の e2e-* 以外は触らない */
export default async function globalTeardown() {
  const dir = process.env.TREBUCHET_E2E_DATA_DIR;
  if (!dir) return;
  const target = resolve(dir);
  if (dirname(target) !== TMP_ROOT || !basename(target).startsWith("e2e-")) return;
  await rm(target, { recursive: true, force: true });
}
