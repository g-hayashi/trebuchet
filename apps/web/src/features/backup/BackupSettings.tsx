import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackupStatus } from "@trebuchet/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import {
  backupKeys,
  backupRunsQuery,
  backupStatusQuery,
  runBackup,
  saveBackupSettings,
} from "./api";
import { describeFailure, formatBytes, STATUS_LABELS, TRIGGER_LABELS } from "./labels";

/** 状態と実行の履歴を取り直す（設定・実行のあと） */
function useRefreshBackup() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: backupKeys.status });
    await queryClient.invalidateQueries({ queryKey: backupKeys.runs });
  };
}

/** バックアップの設定の画面の中身（FR-014・015・019・020）。鍵はデータ鍵から作る（008 の D9） */
export function BackupSettings() {
  const { data: status, isPending, error } = useQuery(backupStatusQuery());
  return (
    <>
      <ApiErrorMessage error={error} />
      {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {status && (
        <>
          <RunCard status={status} />
          <SettingsCard status={status} />
        </>
      )}
      <HistoryCard />
    </>
  );
}

function RunCard({ status }: { status: BackupStatus }) {
  const refresh = useRefreshBackup();
  const run = useMutation({ mutationFn: runBackup, onSettled: refresh });
  return (
    <Card>
      <CardHeader>
        <CardTitle>バックアップ</CardTitle>
        <CardDescription>
          帳簿のデータを暗号化して、置き場所に保存します。自動でも定期的に取ります（解錠している間だけ）。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {status.configured ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">置き場所</dt>
            <dd>{status.folder}</dd>
            <dt className="text-muted-foreground">最後の成功</dt>
            <dd>{status.lastSuccess ? formatDateTime(status.lastSuccess) : "まだありません"}</dd>
            <dt className="text-muted-foreground">最後の確認</dt>
            <dd>{status.lastCheck ? formatDateTime(status.lastCheck) : "まだありません"}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            まだ設定されていません。下で置き場所を決めてください。
          </p>
        )}
        {status.running && (
          <p role="status" className="text-sm">
            バックアップを実行しています…
          </p>
        )}
        <ApiErrorMessage error={run.error} />
        <div>
          <Button
            disabled={!status.configured || status.running || run.isPending}
            onClick={() => run.mutate()}
          >
            今すぐバックアップ
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 置き場所の設定（FR-014）。バックアップの鍵は、この Mac のデータ鍵から作る（008 の D9）。パスフレーズは要らない。
 * Mac を失ったときは、回復キーで復元する
 */
function SettingsCard({ status }: { status: BackupStatus }) {
  const refresh = useRefreshBackup();
  const [folder, setFolder] = useState<string>();
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: saveBackupSettings,
    onSuccess: async () => {
      setSaved(true);
      await refresh();
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>置き場所の設定</CardTitle>
        <CardDescription>
          バックアップは、この Mac
          のデータ鍵で暗号化して置き場所に保存します。保存すると、すぐに最初のバックアップを取ります。Mac
          を失ったときは、初回の設定で控えた回復キーで、新しい Mac に復元できます。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          aria-label="置き場所の設定"
          className="grid max-w-xl gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate({ folder: folder ?? status.folder ?? "" });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="backup-folder">置き場所</Label>
            <Input
              id="backup-folder"
              autoComplete="off"
              placeholder="/Users/あなた/Backups"
              value={folder ?? status.folder ?? ""}
              onChange={(event) => setFolder(event.currentTarget.value)}
            />
          </div>
          <ApiErrorMessage error={save.error} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              保存
            </Button>
            {saved && <SaveNotice message="保存しました。最初のバックアップを始めました。" />}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** 実行の履歴（FR-020）。サーバーが返した新しい順のまま並べる */
function HistoryCard() {
  const { data: runs, isPending, error } = useQuery(backupRunsQuery());
  return (
    <Card>
      <CardHeader>
        <CardTitle>実行の履歴</CardTitle>
        <CardDescription>
          自動と手動の実行の結果です（新しい順）。「変更なし」は、前回から帳簿が変わっていないため、ファイルを作らなかった実行です。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ApiErrorMessage error={error} />
        {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
        {runs?.length === 0 && (
          <p className="text-sm text-muted-foreground">まだ実行されていません。</p>
        )}
        {runs && runs.length > 0 && (
          <Table aria-label="バックアップの実行履歴">
            <TableHeader>
              <TableRow>
                <TableHead>日時</TableHead>
                <TableHead>種類</TableHead>
                <TableHead>結果</TableHead>
                <TableHead>ファイル名</TableHead>
                <TableHead>サイズ</TableHead>
                <TableHead>失敗の理由</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatDateTime(r.startedAt)}</TableCell>
                  <TableCell>{TRIGGER_LABELS[r.trigger]}</TableCell>
                  <TableCell>{STATUS_LABELS[r.status]}</TableCell>
                  <TableCell>{r.fileName ?? "—"}</TableCell>
                  <TableCell>{r.sizeBytes === null ? "—" : formatBytes(r.sizeBytes)}</TableCell>
                  <TableCell>{r.errorCode === null ? "—" : describeFailure(r.errorCode)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
