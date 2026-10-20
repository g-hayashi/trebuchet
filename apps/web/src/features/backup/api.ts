import { queryOptions } from "@tanstack/react-query";
import type { BackupPassphraseInput, BackupSettingsInput } from "@trebuchet/schema";
import { api, unwrap } from "@/lib/api";
import { queryKeys } from "@/lib/queries";

// バックアップの API（contracts/http-api.md の「バックアップ」）。判定はサーバーに従い、画面は結果を表示するだけ

const backup = api.api.backup;

/** 実行中は、終わりが分かるまで取り直す */
const POLL_MS = 2000;

export const backupStatusQuery = () =>
  queryOptions({
    queryKey: queryKeys.backupStatus,
    queryFn: async () => unwrap(await backup.status.$get()),
    refetchInterval: (query) => (query.state.data?.running ? POLL_MS : false),
  });

export const backupRunsQuery = () =>
  queryOptions({
    queryKey: queryKeys.backupRuns,
    queryFn: async () => (await unwrap(await backup.runs.$get())).runs,
  });

export const saveBackupSettings = async (json: BackupSettingsInput) =>
  unwrap(await backup.settings.$put({ json }));

export const changeBackupPassphrase = async (json: BackupPassphraseInput) =>
  unwrap(await backup.passphrase.$put({ json }));

export const runBackup = async () => unwrap(await backup.run.$post());
