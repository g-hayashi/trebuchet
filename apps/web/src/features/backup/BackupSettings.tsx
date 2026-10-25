import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type BackupStatus, PASSPHRASE_MIN_LENGTH } from "@trebuchet/schema";
import { useId, useState } from "react";
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
  changeBackupPassphrase,
  runBackup,
  saveBackupSettings,
} from "./api";
import { describeFailure, formatBytes, STATUS_LABELS, TRIGGER_LABELS } from "./labels";

/** 状態と実行の履歴を取り直す（設定・変更・実行のあと） */
function useRefreshBackup() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: backupKeys.status });
    await queryClient.invalidateQueries({ queryKey: backupKeys.runs });
  };
}

/** バックアップの設定の画面の中身（FR-014・015・019・020・023） */
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
          {status.configured && <PassphraseCard status={status} />}
        </>
      )}
      <HistoryCard />
    </>
  );
}

/** パスフレーズを2回入力する欄。短さと不一致は入力の補助として示すだけで、最終の判定はサーバー */
function PassphraseFields({
  idPrefix,
  labels,
  passphrase,
  confirm,
  onPassphrase,
  onConfirm,
}: {
  idPrefix: string;
  labels: { passphrase: string; confirm: string };
  passphrase: string;
  confirm: string;
  onPassphrase: (value: string) => void;
  onConfirm: (value: string) => void;
}) {
  const short = passphrase.length > 0 && passphrase.length < PASSPHRASE_MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-passphrase`}>{labels.passphrase}</Label>
        <Input
          id={`${idPrefix}-passphrase`}
          type="password"
          autoComplete="new-password"
          value={passphrase}
          onChange={(event) => onPassphrase(event.currentTarget.value)}
        />
        {short && (
          <p role="status" className="text-sm text-destructive">
            パスフレーズは{PASSPHRASE_MIN_LENGTH}文字以上にしてください（今は{passphrase.length}
            文字）。
          </p>
        )}
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-confirm`}>{labels.confirm}</Label>
        <Input
          id={`${idPrefix}-confirm`}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => onConfirm(event.currentTarget.value)}
        />
        {mismatch && (
          <p role="status" className="text-sm text-destructive">
            確認の入力が一致しません。
          </p>
        )}
      </div>
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
          帳簿のデータを暗号化して、置き場所に保存します。自動でも定期的に取ります。
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
            まだ設定されていません。下で置き場所とパスフレーズを決めてください。
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

/** 置き場所とパスフレーズの設定（FR-014）。パスフレーズを失うと復元できないことへの同意が要る */
function SettingsCard({ status }: { status: BackupStatus }) {
  const refresh = useRefreshBackup();
  const checkId = useId();
  const [folder, setFolder] = useState<string>();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: saveBackupSettings,
    onSuccess: async () => {
      setPassphrase("");
      setConfirm("");
      setAcknowledged(false);
      setSaved(true);
      await refresh();
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>置き場所とパスフレーズの設定</CardTitle>
        <CardDescription>
          バックアップは、パスフレーズで暗号化して置き場所に保存します。保存すると、すぐに最初のバックアップを取ります。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          aria-label="置き場所とパスフレーズの設定"
          className="grid max-w-xl gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!acknowledged) return;
            setSaved(false);
            save.mutate({
              folder: folder ?? status.folder ?? "",
              passphrase,
              passphraseConfirm: confirm,
              acknowledged: true,
            });
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
          <PassphraseFields
            idPrefix="backup-settings"
            labels={{ passphrase: "パスフレーズ", confirm: "パスフレーズ（確認）" }}
            passphrase={passphrase}
            confirm={confirm}
            onPassphrase={setPassphrase}
            onConfirm={setConfirm}
          />
          <div className="flex items-start gap-2 text-sm">
            <input
              id={checkId}
              type="checkbox"
              className="mt-1"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            />
            <label htmlFor={checkId}>
              パスフレーズを失うと復元できないことを理解しました（パスフレーズは、安全な場所に控えてください）
            </label>
          </div>
          <ApiErrorMessage error={save.error} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!acknowledged || save.isPending}>
              保存
            </Button>
            {saved && <SaveNotice message="保存しました。最初のバックアップを始めました。" />}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * パスフレーズの変更（FR-023）。キーチェーンが空のとき（`PASSPHRASE_NEEDED`）は今のパスフレーズを聞かず、
 * 入力し直してもらう。それ以外は今のパスフレーズを求める（検査はサーバー）
 */
function PassphraseCard({ status }: { status: BackupStatus }) {
  const refresh = useRefreshBackup();
  const needsReenter = status.alert?.reason === "PASSPHRASE_NEEDED";
  const [current, setCurrent] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saved, setSaved] = useState(false);
  const change = useMutation({
    mutationFn: changeBackupPassphrase,
    onSuccess: async () => {
      setCurrent("");
      setPassphrase("");
      setConfirm("");
      setSaved(true);
      await refresh();
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>パスフレーズの変更</CardTitle>
        <CardDescription>
          変更すると、新しいパスフレーズでバックアップを取り直します。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          aria-label="パスフレーズの変更"
          className="grid max-w-xl gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            change.mutate({
              ...(needsReenter ? {} : { current }),
              passphrase,
              passphraseConfirm: confirm,
            });
          }}
        >
          <p className="text-sm">
            <strong className="font-semibold">
              以前のバックアップは古いパスフレーズのままです。
            </strong>
            古いファイルを復元するときは、古いパスフレーズが要ります。
          </p>
          {needsReenter ? (
            <p className="text-sm">
              保存してあるパスフレーズが見つかりません。パスフレーズを入力し直してください。
            </p>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="backup-current-passphrase">今のパスフレーズ</Label>
              <Input
                id="backup-current-passphrase"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.currentTarget.value)}
              />
            </div>
          )}
          <PassphraseFields
            idPrefix="backup-change"
            labels={{ passphrase: "新しいパスフレーズ", confirm: "新しいパスフレーズ（確認）" }}
            passphrase={passphrase}
            confirm={confirm}
            onPassphrase={setPassphrase}
            onConfirm={setConfirm}
          />
          <ApiErrorMessage error={change.error} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={change.isPending}>
              パスフレーズを変更
            </Button>
            {saved && (
              <SaveNotice message="変更しました。新しいパスフレーズでバックアップを始めました。" />
            )}
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
