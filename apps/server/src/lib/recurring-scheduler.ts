import {
  type Clock,
  type IdGenerator,
  postDueRecurring,
  type RecurringUnitOfWork,
} from "@trebuchet/domain";
import { todayOf } from "./today.ts";

const HOUR_MS = 60 * 60 * 1000;

export type RecurringSchedulerDeps = {
  /** 判定する事業体の ID（registry の全事業体）。呼ぶたびに引き直す */
  entities: () => string[];
  /** 事業体の DB に対する定期仕訳の UnitOfWork。事業体ごとに開く */
  openUnitOfWork: (entityId: string) => RecurringUnitOfWork;
  ids: IdGenerator;
  clock: Clock;
  /** 判定の間隔。既定は 1 時間（R18） */
  intervalMs?: number;
};

export type RecurringScheduler = {
  /** 全事業体を順に 1 回判定する（予定日が今日以前の未登録の回を登録する）。例外は投げない */
  tick(): Promise<void>;
  stop(): void;
};

/**
 * 定期仕訳の自動登録（R18）。`start` の後は間隔ごとに `tick` を呼ぶ。最初の判定は呼び出し側が `tick` で行う。
 * 1 つの事業体の失敗（DB のエラーなど）で、ほかの事業体を止めない。ログには例外の名前だけを出す
 */
export function startRecurringScheduler(deps: RecurringSchedulerDeps): RecurringScheduler {
  let judging = false;

  async function tick(): Promise<void> {
    if (judging) return;
    judging = true;
    try {
      const today = todayOf(deps.clock);
      for (const entityId of deps.entities()) {
        try {
          postDueRecurring(
            { uow: deps.openUnitOfWork(entityId), ids: deps.ids, clock: deps.clock },
            today,
          );
        } catch (e) {
          console.error("recurring: 定期仕訳の判定に失敗", e instanceof Error ? e.name : "unknown");
        }
      }
    } catch (e) {
      console.error("recurring: 定期仕訳の判定に失敗", e instanceof Error ? e.name : "unknown");
    } finally {
      judging = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? HOUR_MS);
  timer.unref();

  return { tick, stop: () => clearInterval(timer) };
}
