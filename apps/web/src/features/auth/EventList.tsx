import { useQuery } from "@tanstack/react-query";
import type { AuthEventKind } from "@trebuchet/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CsvExport } from "@/components/ui/csv-export";
import { ApiErrorMessage } from "@/components/ui/form-error";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { EVENTS_CSV_HREF, eventsQuery } from "./api";

const KIND_LABELS: Record<AuthEventKind, string> = {
  register: "登録",
  sign_in: "解錠",
  sign_in_failed: "解錠の失敗",
  recovery_used: "回復キーでの解錠",
  recovery_failed: "回復キーの失敗",
  recovery_regenerated: "回復キーの作り直し",
  passkey_renamed: "パスキーの名前の変更",
  passkey_deleted: "パスキーの削除",
  session_revoked: "セッションの失効",
  sign_out: "施錠",
  pairing_issued: "ペアリングの発行",
  pairing_used: "ペアリングの使用",
  remote_settings_changed: "リモートの設定の変更",
};

/** 認証の記録（FR-008）。最近の 5 件を、サーバーが返した新しい順のまま並べる。全件は CSV に書き出す（FR-054）。書き換え・削除の操作はない */
export function EventList() {
  const { data: events, isPending, error } = useQuery(eventsQuery());
  return (
    <Card>
      <CardHeader>
        <CardTitle>認証の記録</CardTitle>
        <CardDescription>
          登録・解錠・施錠・回復などの最近の記録です（新しい順に 5 件）。全件は CSV に書き出せます。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ApiErrorMessage error={error} />
        <div>
          <CsvExport href={EVENTS_CSV_HREF} disabled={!events || events.length === 0} />
        </div>
        {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
        {events && (
          <Table aria-label="認証の記録">
            <TableHeader>
              <TableRow>
                <TableHead>日時</TableHead>
                <TableHead>出来事</TableHead>
                <TableHead>接続先</TableHead>
                <TableHead>端末</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{formatDateTime(e.occurredAt)}</TableCell>
                  <TableCell>{KIND_LABELS[e.kind]}</TableCell>
                  <TableCell>{e.rpId ?? "—"}</TableCell>
                  <TableCell>{e.userAgent ?? "不明"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
