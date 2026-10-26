import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeError } from "@/lib/api-errors";
import { formatDateTime } from "@/lib/format";
import { type EvalRunView, evalRunsQuery, jobQuery, postEvalStart, statementKeys } from "./api";
import { METHOD_LABELS } from "./labels";

type Fields = EvalRunView["result"]["fields"];

const FIELD_LABELS: Record<keyof Fields, string> = {
  counterAccount: "科目",
  taxCategory: "税区分",
  partner: "取引先",
  purpose: "事業／私用",
};
const FIELD_KEYS = Object.keys(FIELD_LABELS) as (keyof Fields)[];

/** 率は千分率の整数。「80.0%」の形にする */
const rate = (perMille: number) => `${(perMille / 10).toFixed(1)}%`;

/** 前回との差（千分率の差を % の点で）。「+7.5 pt」「-2.5 pt」「±0.0 pt」 */
const diff = (now: number, before: number) => {
  const d = now - before;
  const sign = d > 0 ? "+" : d < 0 ? "-" : "±";
  return `${sign}${(Math.abs(d) / 10).toFixed(1)} pt`;
};

/**
 * 評価（H:§6.1・§6.2。FR-029）: 古い明細で学び、新しい明細の科目などを当てて一致率を測る。
 * 実行はジョブ（取得と同じ）で、終わったら履歴を読み直す。履歴は新しい順で、各行に 1 つ前の実行との差を示す
 */
export function EvalRuns({ entityId }: { entityId: string }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [splitDate, setSplitDate] = useState("");
  const [includeAi, setIncludeAi] = useState(false);
  const [jobId, setJobId] = useState<string>();

  const runs = useQuery(evalRunsQuery(entityId));
  const start = useMutation({
    mutationFn: () =>
      postEvalStart(entityId, { includeAi, ...(splitDate === "" ? {} : { splitDate }) }),
    onSuccess: (result) => setJobId(result.jobId),
  });
  const job = useQuery({ ...jobQuery(entityId, jobId ?? ""), enabled: jobId !== undefined });
  const status = job.data?.status;
  const active = start.isPending || status === "waiting_login" || status === "running";

  // 終わったら、同じジョブについて 1 回だけ履歴を読み直す
  const notified = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (jobId !== undefined && status === "done" && notified.current !== jobId) {
      notified.current = jobId;
      void queryClient.invalidateQueries({ queryKey: statementKeys.evals(entityId) });
    }
  }, [jobId, status, entityId, queryClient]);

  const failure =
    status === "failed"
      ? (job.data?.error?.message ?? "評価に失敗しました。")
      : job.error
        ? describeError(job.error).message
        : undefined;

  const latest = runs.data?.[0];

  return (
    <div className="grid gap-6">
      <section aria-label="評価の実行" className="grid gap-3 rounded-md border px-4 py-3">
        <h2 className="font-medium">評価を実行</h2>
        <p className="text-sm text-muted-foreground">
          取り込んだ明細を分割日で古い側と新しい側に分け、古い側から作ったルールで新しい側の科目などを当てて、登録済みの仕訳との一致率を測ります。帳簿は変わりません。
        </p>
        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setJobId(undefined);
            start.mutate();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={`${id}-split`}>分割日（省略で自動）</Label>
            <Input
              id={`${id}-split`}
              type="date"
              className="w-44"
              value={splitDate}
              onChange={(e) => setSplitDate(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <input
              id={`${id}-ai`}
              type="checkbox"
              checked={includeAi}
              onChange={(e) => setIncludeAi(e.target.checked)}
            />
            <Label htmlFor={`${id}-ai`}>AI も評価する</Label>
          </div>
          <Button type="submit" disabled={active}>
            評価を実行
          </Button>
        </form>
        <ApiErrorMessage error={start.error} />
        <div aria-live="polite" className="text-sm">
          {(status === "running" || (start.isSuccess && status === undefined)) && (
            <p>評価しています…</p>
          )}
          {status === "done" && <p>評価しました。</p>}
        </div>
        {failure && (
          <div
            role="alert"
            className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
          >
            {failure}
          </div>
        )}
      </section>

      <section aria-label="評価の履歴" className="grid gap-3">
        <h2 className="font-medium">評価の履歴</h2>
        <ApiErrorMessage error={runs.error} />
        {runs.isPending && !runs.error && (
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        )}
        {runs.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">まだ評価していません。</p>
        )}
        {runs.data && runs.data.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">
              一致率は、新しい側の明細のうち、推定が登録済みの仕訳と合った割合です。「前回との差」は
              1 つ前の実行との差です（分割日や AI
              の有無が違うと、そのまま比べられないことがあります）。
            </p>
            <Table aria-label="評価の履歴">
              <TableHeader>
                <TableRow>
                  <TableHead>実行日時</TableHead>
                  <TableHead>分割日</TableHead>
                  <TableHead className="text-right">件数</TableHead>
                  <TableHead>AI</TableHead>
                  {FIELD_KEYS.map((k) => (
                    <TableHead key={k} className="text-right">
                      {FIELD_LABELS[k]}
                    </TableHead>
                  ))}
                  <TableHead>前回との差</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((run, i) => {
                  const before = runs.data[i + 1];
                  return (
                    <TableRow key={run.id}>
                      <TableCell>{formatDateTime(run.createdAt)}</TableCell>
                      <TableCell>{run.splitDate}</TableCell>
                      <TableCell className="text-right tabular-nums">{run.sampleCount}</TableCell>
                      <TableCell>
                        {run.includeAi
                          ? run.models.length > 0
                            ? run.models.join("、")
                            : "あり"
                          : "なし"}
                      </TableCell>
                      {FIELD_KEYS.map((k) => (
                        <TableCell key={k} className="text-right tabular-nums">
                          {rate(run.result.fields[k])}
                        </TableCell>
                      ))}
                      <TableCell className="text-sm tabular-nums">
                        {before === undefined
                          ? "前回なし"
                          : FIELD_KEYS.map(
                              (k) =>
                                `${FIELD_LABELS[k]} ${diff(run.result.fields[k], before.result.fields[k])}`,
                            ).join(" / ")}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </>
        )}
      </section>

      {latest && (
        <section aria-label="方法ごとの一致率" className="grid gap-3">
          <h2 className="font-medium">方法ごとの一致率（最新）</h2>
          <Table aria-label="方法ごとの一致率（最新）">
            <TableHeader>
              <TableRow>
                <TableHead>方法</TableHead>
                <TableHead className="text-right">件数</TableHead>
                <TableHead className="text-right">一致率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latest.result.methods.map((m) => (
                <TableRow key={m.method}>
                  <TableCell>{METHOD_LABELS[m.method]}</TableCell>
                  <TableCell className="text-right tabular-nums">{m.count}</TableCell>
                  <TableCell className="text-right tabular-nums">{rate(m.matchRate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}
