import type { AuthStore, Clock } from "@trebuchet/domain";
import type { Vault } from "./vault.ts";

const MINUTE_MS = 60 * 1000;

/**
 * 有効なセッション（全権は無操作 30 分、回復は作成から 10 分）が 1 つもなく、解錠中なら施錠する（008 の D3）。
 * 回復のセッションの間も DK が要る（パスキーの包みを作る）ので、回復のセッションも数える。
 * 新しいセッションを入れた後に呼ぶ（先に呼ぶと解錠の直後に施錠される。落とし穴 5）。施錠したら true
 */
export async function sweepSessions(deps: {
  store: AuthStore;
  vault: Vault;
  now: string;
}): Promise<boolean> {
  if (!deps.vault.isUnlocked()) return false;
  if ((await deps.store.listActiveSessions(deps.now)).length > 0) return false;
  await deps.vault.lock();
  return true;
}

export type SessionSweeper = {
  /** 1 回判定する。例外は投げない */
  tick(): Promise<void>;
  stop(): void;
};

/** 間隔ごとに `sweepSessions` を呼ぶ（既定は 1 分）。要求がなくても、離席の後に施錠する */
export function startSessionSweeper(deps: {
  store: () => AuthStore;
  vault: Vault;
  clock: Clock;
  intervalMs?: number;
}): SessionSweeper {
  async function tick(): Promise<void> {
    try {
      await sweepSessions({ store: deps.store(), vault: deps.vault, now: deps.clock.now() });
    } catch (e) {
      console.error("session: 期限の判定に失敗", e instanceof Error ? e.name : "unknown");
    }
  }
  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? MINUTE_MS);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
