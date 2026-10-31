import type { Clock } from "@trebuchet/domain";

/** WebAuthn の challenge の保持（R1）。メモリに 5 分、最大 100 件 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX = 100;

type Entry = { scope: string; expiresAt: number; data: unknown };

/**
 * 要求ごとに 1 つの challenge を、用途（`scope`）と途中の値（`data`。008 の PRF の salt・登録を検証した資格情報）
 * つきで保持する。取り出しは 1 回だけ（成功・失敗で破棄）。100 件を超えたら古いものから捨てる。
 * 期限切れ・用途の不一致・捨てられたものは `consume` が false、`take` が undefined を返す
 */
export class ChallengeStore {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  private nowMs(): number {
    return Date.parse(this.clock.now());
  }

  issue(scope: string, challenge: string, data?: unknown): void {
    const now = this.nowMs();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // 同じ値を入れ直すと Map の末尾（最新）に移る
    this.entries.delete(challenge);
    this.entries.set(challenge, { scope, expiresAt: now + CHALLENGE_TTL_MS, data });
    while (this.entries.size > CHALLENGE_MAX) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** 有効なら一緒に入れた値。見つかったものは、有効かによらず破棄する */
  take(scope: string, challenge: string): { data: unknown } | undefined {
    const entry = this.entries.get(challenge);
    if (entry === undefined) return undefined;
    this.entries.delete(challenge);
    return entry.scope === scope && entry.expiresAt > this.nowMs()
      ? { data: entry.data }
      : undefined;
  }

  /** 有効なら true。見つかったものは、真偽によらず破棄する */
  consume(scope: string, challenge: string): boolean {
    return this.take(scope, challenge) !== undefined;
  }

  get size(): number {
    return this.entries.size;
  }
}
