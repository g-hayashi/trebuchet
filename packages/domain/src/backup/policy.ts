import type { BackupAlertReason, BackupRun, BackupTrigger } from "@trebuchet/schema";

const HOUR_MS = 60 * 60 * 1000;
/** 最後の確認からこの時間がたったら自動のバックアップを判断する（R10） */
export const AUTO_BACKUP_INTERVAL_MS = 24 * HOUR_MS;
/** 最後の確認からこの時間がたつと知らせる（R10） */
export const BACKUP_STALE_MS = 48 * HOUR_MS;

/** 最後の確認 = `backup_runs` の最後の succeeded または skipped の終了時刻（ISO 8601）。なければ null */
type LastCheck = string | null | undefined;

/** 最後の確認から 24 時間以上たっている（確認が一度もない）なら true。`now` は ISO 8601 */
export function shouldRunAutoBackup(lastCheck: LastCheck, now: string): boolean {
  if (lastCheck === null || lastCheck === undefined) return true;
  return Date.parse(now) - Date.parse(lastCheck) >= AUTO_BACKUP_INTERVAL_MS;
}

/**
 * 全画面の知らせ。優先順は STALE → LAST_RUN_FAILED（バックアップの鍵は DK から作るので、
 * 「パスフレーズが使えない」の知らせはない。008 の D9）。
 * 設定済みで一度も実行がなければ null。`now` は ISO 8601。
 */
export function backupAlert(input: {
  configured: boolean;
  lastCheck: LastCheck;
  lastRun: Pick<BackupRun, "status"> | null | undefined;
  now: string;
}): { reason: BackupAlertReason } | null {
  if (!input.configured) return null;
  if (
    input.lastCheck !== null &&
    input.lastCheck !== undefined &&
    Date.parse(input.now) - Date.parse(input.lastCheck) >= BACKUP_STALE_MS
  ) {
    return { reason: "STALE" };
  }
  if (input.lastRun?.status === "failed") return { reason: "LAST_RUN_FAILED" };
  return null;
}

/**
 * 「変更なし」として書き込みを省くか（R10）。次の 3 つをすべて満たす自動の実行だけ true。
 * ① 内容の SHA-256 が前回の成功と同じ ② 前回の成功のファイルが置き場所にある ③ forceWrite でない。
 * 手動は常に false。
 */
export function shouldSkipBackup(input: {
  trigger: BackupTrigger;
  forceWrite: boolean;
  contentSha256: string;
  lastSuccess: Pick<BackupRun, "contentSha256" | "fileName"> | null | undefined;
  existingFiles: readonly string[];
}): boolean {
  if (input.trigger === "manual" || input.forceWrite) return false;
  const last = input.lastSuccess;
  if (last === null || last === undefined) return false;
  if (last.contentSha256 === null || last.contentSha256 !== input.contentSha256) return false;
  if (last.fileName === null) return false;
  return input.existingFiles.includes(last.fileName);
}
