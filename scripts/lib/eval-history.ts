/**
 * 評価（`eval-column-suggestions.ts`・`eval-statements.ts`・`eval-receipts.ts`）の共通部品。
 * 結果（件数と割合だけ）を `.tmp/eval-*` に残して前回と比べる部分と、AI を呼ぶ fetch の包み。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { TMP_ROOT } from "../../packages/db/src/tenant-store.ts";

/** 評価の結果を残す場所（`.tmp/<name>/`。末尾に `/` を付ける） */
export function evalDir(name: string): string {
  return `${TMP_ROOT}${name}/`;
}

/** AI を呼ぶ fetch。呼ぶたびに `globalThis.fetch` を引く */
export const evalFetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args);

/** 千分率を「87.5%」の形に */
export const pct = (rate: number): string => `${(rate / 10).toFixed(1)}%`;

/** 前回との差（ポイント）。符号つき。前回がなければ空 */
export function delta(current: number, previous: number | undefined): string {
  if (previous === undefined) return "";
  const diff = (current - previous) / 10;
  return ` (前回比 ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pt)`;
}

/**
 * 前回の結果（日時つきのファイル名の最後）。なければ undefined。
 * 読めない・形が違う（`isValid` が false）ときも undefined
 */
export function readPrevious<T>(
  dir: string,
  isValid: (saved: T) => boolean = () => true,
): T | undefined {
  try {
    const last = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .at(-1);
    if (last === undefined) return undefined;
    const saved = JSON.parse(readFileSync(`${dir}${last}`, "utf8")) as T;
    return isValid(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

/** 結果を `<dir><日時>.json` に保存し、ファイル名を返す（`saved.at` は ISO の日時） */
export function saveEval(dir: string, saved: { at: string }): string {
  mkdirSync(dir, { recursive: true });
  const name = `${saved.at.replaceAll(":", "-").replaceAll(".", "-")}.json`;
  writeFileSync(`${dir}${name}`, `${JSON.stringify(saved, null, 2)}\n`);
  return name;
}
