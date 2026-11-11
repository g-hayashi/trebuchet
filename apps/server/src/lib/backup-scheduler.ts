import {
  type AuthStore,
  type BackupStore,
  type Clock,
  shouldRunAutoBackup,
} from "@trebuchet/domain";
import type { BackupRunner } from "./backup-run.ts";
import { errorName, HOUR_MS, startInterval } from "./util.ts";

export type BackupSchedulerDeps = {
  runner: Pick<BackupRunner, "start">;
  auth: () => AuthStore;
  backups: () => BackupStore;
  clock: Clock;
  /** 判断の間隔。既定は 1 時間（R10） */
  intervalMs?: number;
};

export type BackupScheduler = {
  /** 1 回判断する（最後の確認から 24 時間以上なら自動で実行する）。例外は投げない */
  tick(): Promise<void>;
  stop(): void;
};

/** 自動のバックアップ（R10）。`start` の後は間隔ごとに `tick` を呼ぶ。最初の判断は呼び出し側が `tick` で行う */
export function startBackupScheduler(deps: BackupSchedulerDeps): BackupScheduler {
  let judging = false;

  async function tick(): Promise<void> {
    if (judging) return;
    judging = true;
    try {
      const lastCheck = (await deps.backups().getLastCheck())?.finishedAt;
      if (!shouldRunAutoBackup(lastCheck, deps.clock.now())) return;
      const started = await deps.runner.start("auto");
      if (started.ok) await started.value.done;
    } catch (e) {
      console.error("backup: 自動の判断に失敗", errorName(e));
    } finally {
      judging = false;
    }
  }

  return { tick, stop: startInterval(tick, deps.intervalMs ?? HOUR_MS) };
}
