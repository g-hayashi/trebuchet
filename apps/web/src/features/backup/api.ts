import { queryOptions } from "@tanstack/react-query";
import type { BackupInspection, BackupSettingsInput } from "@trebuchet/schema";
import { uploadForm } from "@/features/imports/upload";
import { api, unwrap } from "@/lib/api";

// バックアップの API（contracts/http-api.md の「バックアップ」）。判定はサーバーに従い、画面は結果を表示するだけ

const backup = api.api.backup;

/** クエリのキー。状態は全画面の上部の知らせも読む */
export const backupKeys = {
  status: ["backup", "status"] as const,
  runs: ["backup", "runs"] as const,
};

/** 実行中は、終わりが分かるまで取り直す */
const POLL_MS = 2000;

export const backupStatusQuery = () =>
  queryOptions({
    queryKey: backupKeys.status,
    queryFn: async () => unwrap(await backup.status.$get()),
    refetchInterval: (query) => (query.state.data?.running ? POLL_MS : false),
  });

export const backupRunsQuery = () =>
  queryOptions({
    queryKey: backupKeys.runs,
    queryFn: async () => (await unwrap(await backup.runs.$get())).runs,
  });

export const saveBackupSettings = async (json: BackupSettingsInput) =>
  unwrap(await backup.settings.$put({ json }));

export const runBackup = async () => unwrap(await backup.run.$post());

/** バックアップのファイルの検査（FR-024）。解錠中の鍵で復号する（パスフレーズはない）。ファイルはメモリだけで扱われ、帳簿は変わらない */
export const inspectBackup = async (input: { file: File }) =>
  uploadForm<BackupInspection>("/api/backup/inspect", input);
