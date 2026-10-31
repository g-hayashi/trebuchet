/** パスキーの追加・削除、回復キーの再発行の前に求める再認証の有効な時間（008 の D4.4） */
export const REAUTH_TTL_MS = 5 * 60 * 1000;

/**
 * セッションごとの、最後にパスキーで本人を確かめた時刻（メモリーだけ）。
 * 施錠でセッションは全部消え、新しいセッションは別の ID なので、古い記録は使われない
 */
export class ReauthTracker {
  private readonly at = new Map<string, number>();

  mark(sessionId: string, nowMs: number): void {
    for (const [id, ms] of this.at) {
      if (nowMs - ms >= REAUTH_TTL_MS) this.at.delete(id);
    }
    this.at.set(sessionId, nowMs);
  }

  isFresh(sessionId: string, nowMs: number): boolean {
    const ms = this.at.get(sessionId);
    return ms !== undefined && nowMs - ms < REAUTH_TTL_MS && nowMs >= ms;
  }
}
