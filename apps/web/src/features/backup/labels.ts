import type { BackupAlertReason, BackupRunStatus, BackupTrigger } from "@trebuchet/schema";

/** 上部の知らせの文言（`alert.reason` ごと） */
export const ALERT_MESSAGES: Record<BackupAlertReason, string> = {
  STALE: "バックアップが成功していません。しばらく前から確認できていません。",
  LAST_RUN_FAILED: "直近のバックアップに失敗しました。原因を確かめてください。",
};

export const TRIGGER_LABELS: Record<BackupTrigger, string> = { manual: "手動", auto: "自動" };

export const STATUS_LABELS: Record<BackupRunStatus, string> = {
  succeeded: "成功",
  skipped: "変更なし",
  failed: "失敗",
};

/** 失敗の理由のコード（`backup_runs.error_code`）の文言。知らないコードはそのまま出す */
const FAILURE_REASONS: Record<string, string> = {
  FOLDER_NOT_FOUND: "置き場所のフォルダが見つかりません",
  WRITE_FAILED: "書き込みに失敗しました",
  VERIFY_FAILED: "書いたファイルを読み戻せませんでした",
  SNAPSHOT_FAILED: "帳簿の写しを作れませんでした",
  RECEIPTS_SYNC_FAILED: "証憑のファイルを置き場所に写せませんでした",
};

export const describeFailure = (code: string): string => FAILURE_REASONS[code] ?? code;

/** ファイルの大きさ（表示用） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
