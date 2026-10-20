import type { Session } from "./types.ts";

/** 通常のセッションは最後の操作から 8 時間で切れる（data-model §1.3） */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
/** 回復用の一時セッションは作成から 10 分で切れる */
export const RECOVERY_SESSION_MS = 10 * 60 * 1000;

/**
 * セッションが有効か（INV-28）。`now` は ISO 8601。
 * 失効済みは常に無効。normal は最後の操作から、recovery は作成からの経過で判定する。
 */
export function isSessionActive(
  session: Pick<Session, "kind" | "createdAt" | "lastSeenAt" | "revokedAt">,
  now: string,
): boolean {
  if (session.revokedAt !== null) return false;
  const nowMs = Date.parse(now);
  if (session.kind === "recovery") {
    return nowMs - Date.parse(session.createdAt) < RECOVERY_SESSION_MS;
  }
  return nowMs - Date.parse(session.lastSeenAt) < SESSION_IDLE_MS;
}
