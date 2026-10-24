/**
 * 置き場所にあるバックアップのファイル（db の `listBackupFiles` の返り値と同じ形）。
 * `macId` はファイル名の先頭 8 文字、`createdAt` は UTC の ISO 8601。
 */
export type BackupFileInfo = { name: string; macId: string; createdAt: string };
