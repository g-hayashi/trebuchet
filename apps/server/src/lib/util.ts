/** server の lib・ルートが共有する小さな部品 */

export const HOUR_MS = 60 * 60 * 1000;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** ログに出す例外の名前。メッセージ・スタックは出さない（値が混ざりうるため） */
export const errorName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/**
 * 間隔ごとに `tick` を呼ぶ。プロセスの終了は妨げない（`unref`）。止める関数を返す。
 * `tick` は例外を投げない前提（各スケジューラーの `tick` が自分で捕まえる）
 */
export function startInterval(tick: () => Promise<void>, ms: number): () => void {
  const timer = setInterval(() => {
    void tick();
  }, ms);
  timer.unref();
  return () => clearInterval(timer);
}
