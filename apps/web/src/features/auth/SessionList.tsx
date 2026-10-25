import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { authKeys, revokeSession, sessionsQuery } from "./api";

/** サインイン中のセッション（FR-013）。現在のセッションに印を付け、他のセッションを失効できる */
export function SessionList() {
  const queryClient = useQueryClient();
  const { data: sessions, isPending, error } = useQuery(sessionsQuery());
  const revoke = useMutation({
    mutationFn: revokeSession,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: authKeys.sessions });
      await queryClient.invalidateQueries({ queryKey: authKeys.events });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>セッション</CardTitle>
        <CardDescription>
          サインイン中の端末です。心当たりのないセッションは失効してください。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ApiErrorMessage error={error ?? revoke.error} />
        {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
        {sessions && (
          <Table aria-label="セッションの一覧">
            <TableHeader>
              <TableRow>
                <TableHead>接続先</TableHead>
                <TableHead>端末</TableHead>
                <TableHead>開始</TableHead>
                <TableHead>最後の操作</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.rpId}</TableCell>
                  <TableCell>{s.userAgent ?? "不明"}</TableCell>
                  <TableCell>{formatDateTime(s.createdAt)}</TableCell>
                  <TableCell>{formatDateTime(s.lastSeenAt)}</TableCell>
                  <TableCell>
                    {s.current ? (
                      <span className="whitespace-nowrap rounded-md bg-secondary px-2 py-1 text-xs font-medium">
                        現在のセッション
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(s.id)}
                      >
                        失効
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
