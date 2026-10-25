import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeError } from "@/lib/api-errors";
import { thisMonth } from "@/lib/dates";
import { type FetchSource, jobQuery, postMfmeFetch } from "./api";

const monthOf = (progress: unknown): string | undefined => {
  if (typeof progress !== "object" || progress === null) return undefined;
  const month = (progress as { month?: unknown }).month;
  return typeof month === "string" ? month : undefined;
};

/**
 * MF ME からの自動取得（US4。R13）。期間を決めて「取得を開始」を押すと、サーバーが見えるブラウザを開く。
 * ログインと 2 段階認証は利用者がそのウィンドウで行う（パスワードは保存しない。FR-009）。
 * 終わったら `onFetched` に取込元（ジョブの ID）を渡し、画面が貼り付けと同じプレビューへ進む。
 * 失敗したら何も取り込まず、理由と失敗した口座、貼り付けでの取込の案内を示す（FR-010）
 */
export function MfmeFetch({
  entityId,
  onFetched,
  onFallbackToPaste,
}: {
  entityId: string;
  onFetched: (source: FetchSource) => void;
  onFallbackToPaste: () => void;
}) {
  const id = useId();
  const [from, setFrom] = useState(thisMonth());
  const [to, setTo] = useState(thisMonth());
  const [error, setError] = useState<string | undefined>();
  const [jobId, setJobId] = useState<string | undefined>();

  const start = useMutation({
    mutationFn: () => postMfmeFetch(entityId, { from, to }),
    onSuccess: (result) => setJobId(result.jobId),
  });

  const job = useQuery({ ...jobQuery(entityId, jobId ?? ""), enabled: jobId !== undefined });
  const status = job.data?.status;
  const active = start.isPending || status === "waiting_login" || status === "running";

  // 終わったら、同じジョブについて 1 回だけ知らせる（最新の onFetched を使う）
  const notified = useRef<string | undefined>(undefined);
  const latest = useRef(onFetched);
  latest.current = onFetched;
  useEffect(() => {
    if (jobId !== undefined && status === "done" && notified.current !== jobId) {
      notified.current = jobId;
      latest.current({ kind: "mfme_fetch", jobId });
    }
  }, [jobId, status]);

  const submit = () => {
    if (from === "" || to === "") {
      setError("期間（開始月と終了月）を入力してください");
      return;
    }
    if (from > to) {
      setError("開始月は終了月以前にしてください");
      return;
    }
    setError(undefined);
    setJobId(undefined);
    start.mutate();
  };

  const failure =
    status === "failed"
      ? {
          message: job.data?.error?.message ?? "取得に失敗しました。",
          failedAccounts: job.data?.error?.failedAccounts ?? [],
        }
      : job.error
        ? { message: describeError(job.error).message, failedAccounts: [] }
        : undefined;

  return (
    <div className="grid gap-3">
      <form
        className="flex flex-wrap items-end gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor={`${id}-from`}>開始月</Label>
          <Input
            id={`${id}-from`}
            type="month"
            className="w-40"
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-error`}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-to`}>終了月</Label>
          <Input
            id={`${id}-to`}
            type="month"
            className="w-40"
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-error`}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={active}>
          取得を開始
        </Button>
      </form>
      <FieldError id={`${id}-error`} message={error} />
      <ApiErrorMessage error={start.error} />

      <div aria-live="polite" className="text-sm">
        {status === "waiting_login" && (
          <p>
            ブラウザのウィンドウで MF ME にログインしてください（2
            段階認証もそのウィンドウで行います）。パスワードはこのアプリに保存されません。
          </p>
        )}
        {status === "running" && (
          <p>
            取得しています…
            {monthOf(job.data?.progress) !== undefined && `（${monthOf(job.data?.progress)}）`}
          </p>
        )}
        {status === "done" && <p>取得しました。プレビューで内容を確かめてください。</p>}
      </div>

      {failure && (
        <div
          role="alert"
          className="grid gap-2 rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
        >
          <p className="font-medium">{failure.message}</p>
          {failure.failedAccounts.length > 0 && (
            <div>
              <p>取得できなかった口座</p>
              <ul className="list-disc pl-5">
                {failure.failedAccounts.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </div>
          )}
          <p>明細は取り込んでいません。MF ME の表をコピーして、貼り付けで取り込めます。</p>
          <div>
            <Button type="button" variant="outline" onClick={onFallbackToPaste}>
              貼り付けで取り込む
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
