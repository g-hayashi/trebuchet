/**
 * scripts の環境変数の読み取り。bench と eval で共有する（DB・server を import しない軽い部品）。
 */

/** 環境変数 `name` の正の数（未設定・空なら fallback）。正の数でなければ例外 */
export function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} は正の数: ${raw}`);
  return value;
}

/** 評価（eval）が起動する `fm serve` の既定のポート。server の既定（18790）と分け、`pnpm dev` 中でも衝突しない */
export const EVAL_FM_DEFAULT_PORT = 18791;

/** 評価の `fm serve` のポート（環境変数 `TREBUCHET_FM_PORT`、既定は `EVAL_FM_DEFAULT_PORT`） */
export function evalFmPort(): number {
  return positiveNumber("TREBUCHET_FM_PORT", EVAL_FM_DEFAULT_PORT);
}
