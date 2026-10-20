import { removeStaleSnapshots } from "@trebuchet/db";
import { type BackupSchedulerDeps, startBackupScheduler } from "./backup-scheduler.ts";

export type BackgroundServices = {
  /** 起動時に消した、前回の異常終了で残った平文の写しの数 */
  removedSnapshots: number;
  stop(): void;
};

/**
 * server の起動の処理（`main.ts` から呼ぶ）。
 * 前回の異常終了で残った平文の写し（`<tmpRoot>/backup-snapshot-*`）を消し、自動のバックアップを始める。
 * 最初の判断はすぐに行う（次の 1 時間後まで待たない）。
 */
export function startBackgroundServices(
  deps: BackupSchedulerDeps & { tmpRoot: string },
): BackgroundServices {
  const removedSnapshots = removeStaleSnapshots(deps.tmpRoot);
  const scheduler = startBackupScheduler(deps);
  void scheduler.tick();
  return { removedSnapshots, stop: () => scheduler.stop() };
}
