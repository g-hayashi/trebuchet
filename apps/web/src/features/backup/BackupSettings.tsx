import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackupStatus } from "@trebuchet/schema";
import { useState } from "react";
import { Loading } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CsvExport } from "@/components/ui/csv-export";
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
import { formatBytes, formatDateTime } from "@/lib/format";
import {
  backupKeys,
  backupRunsQuery,
  backupStatusQuery,
  RUNS_CSV_HREF,
  runBackup,
  saveBackupSettings,
} from "./api";
import { ALERT_MESSAGES, describeFailure, STATUS_LABELS, TRIGGER_LABELS } from "./labels";

/** 状態と実行の履歴を取り直す（設定・実行のあと） */
function useRefreshBackup() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: backupKeys.status });
    await queryClient.invalidateQueries({ queryKey: backupKeys.runs });
  };
}

/** バックアップの状態と置き場所の設定（FR-014・015・019・020）。鍵はデータ鍵から作る（008 の D9）。画面の最初に置く */
export function BackupSettings() {
  const { data: status, isPending, error } = useQuery(backupStatusQuery());
  return (
    <>
      <ApiErrorMessage error={error} />
      {isPending && <Loading />}
      {status && (
        <>
          <RunCard status={status} />
          <SettingsCard status={status} />
        </>
      )}
    </>
  );
}

/** 書けずに失敗した実行の理由（置き場所を変えれば直るもの） */
const WRITE_FAILURE_CODES = new Set(["FOLDER_NOT_FOUND", "WRITE_FAILED"]);

/**
 * 直近の失敗の警告（FR-020）。置き場所に書けずに失敗したときは、警告のすぐ下で置き場所を変える案内を出す
 * （既定の `bak/` に書けないときも同じ。Edge Cases）
 */
function FailureWarning({ status }: { status: BackupStatus }) {
  if (!status.alert) return null;
  const cannotWrite =
    status.alert.reason === "LAST_RUN_FAILED" &&
    status.lastRun?.errorCode != null &&
    WRITE_FAILURE_CODES.has(status.lastRun.errorCode);
  return (
    <section
      aria-label="バックアップの警告"
      className="grid gap-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
    >
      <p>{ALERT_MESSAGES[status.alert.reason]}</p>
      {cannotWrite && (
        <p>置き場所に書き込めませんでした。下の「置き場所の設定」で、置き場所を変えてください。</p>
      )}
    </section>
  );
}

function RunCard({ status }: { status: BackupStatus }) {
  const refresh = useRefreshBackup();
  const run = useMutation({ mutationFn: runBackup, onSettled: refresh });
  return (
    <Card>
      <CardHeader>
        <CardTitle>状態</CardTitle>
        <CardDescription>
          帳簿のデータを暗号化して、置き場所に保存します。自動でも定期的に取ります（解錠している間だけ）。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <FailureWarning status={status} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">置き場所</dt>
          <dd>{status.folder}</dd>
          <dt className="text-muted-foreground">最後の成功</dt>
          <dd>{status.lastSuccess ? formatDateTime(status.lastSuccess) : "まだありません"}</dd>
          <dt className="text-muted-foreground">最後の確認</dt>
          <dd>{status.lastCheck ? formatDateTime(status.lastCheck) : "まだありません"}</dd>
        </dl>
        {status.folderSource === "default" && (
          <p className="text-sm">
            置き場所を決めていないので、この Mac の中（bak/）にあります。Mac
            を失うとバックアップも失われます。同期フォルダなどに変えられます。
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
            variant="outline"
            disabled={status.running || run.isPending}
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

/** 実行の履歴（FR-020）。最近の 5 件を、サーバーが返した新しい順のまま並べる。全件は CSV に書き出す（FR-054） */
export function BackupHistory() {
  const { data: runs, isPending, error } = useQuery(backupRunsQuery());
  return (
    <Card>
      <CardHeader>
        <CardTitle>実行の履歴</CardTitle>
        <CardDescription>
          自動と手動の最近の実行の結果です（新しい順に 5 件）。全件は CSV
          に書き出せます。「変更なし」は、前回から帳簿が変わっていないため、ファイルを作らなかった実行です。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ApiErrorMessage error={error} />
        <div>
          <CsvExport href={RUNS_CSV_HREF} disabled={!runs || runs.length === 0} />
        </div>
        {isPending && <Loading />}
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
