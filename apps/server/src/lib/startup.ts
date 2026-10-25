import { removeStaleSnapshots } from "@trebuchet/db";
import { type BackupSchedulerDeps, startBackupScheduler } from "./backup-scheduler.ts";
import { type RecurringSchedulerDeps, startRecurringScheduler } from "./recurring-scheduler.ts";

export type BackgroundServices = {
  /** 起動時に消した、前回の異常終了で残った平文の写しの数 */
  removedSnapshots: number;
  stop(): void;
};

/**
 * server の起動の処理（`main.ts` から呼ぶ）。
 * 前回の異常終了で残った平文の写し（`<tmpRoot>/backup-snapshot-*`）を消し、自動のバックアップと
 * 定期仕訳の自動登録（005 R18）を始める。最初の判断はすぐに行う（次の 1 時間後まで待たない）。
 * 時計は自動のバックアップと共有する
 */
export function startBackgroundServices(
  deps: BackupSchedulerDeps & {
    tmpRoot: string;
    recurring: Omit<RecurringSchedulerDeps, "clock">;
  },
): BackgroundServices {
  const removedSnapshots = removeStaleSnapshots(deps.tmpRoot);
  const backup = startBackupScheduler(deps);
  const recurring = startRecurringScheduler({ ...deps.recurring, clock: deps.clock });
  void backup.tick();
  void recurring.tick();
  return {
    removedSnapshots,
    stop: () => {
      backup.stop();
      recurring.stop();
    },
  };
}
