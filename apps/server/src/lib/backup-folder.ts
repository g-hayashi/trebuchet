import { fileURLToPath } from "node:url";
import type { BackupStatus } from "@trebuchet/schema";

// tenant-store.ts の DEFAULT_DATA_DIR と同じく import.meta.url からリポジトリ直下を求める。
// TREBUCHET_DATA_DIR とは独立した場所にする。
const DEFAULT_BACKUP_DIR = fileURLToPath(new URL("../../../../bak", import.meta.url));

/** 読み取り専用。既定先の作成は実行中に行い、失敗を backup_runs に残す。 */
export function resolveBackupFolder(
  configuredFolder: string | undefined,
): Pick<BackupStatus, "folder" | "folderSource"> {
  if (configuredFolder !== undefined) {
    return { folder: configuredFolder, folderSource: "configured" };
  }
  return {
    folder: process.env.TREBUCHET_DEFAULT_BACKUP_DIR ?? DEFAULT_BACKUP_DIR,
    folderSource: "default",
  };
}
