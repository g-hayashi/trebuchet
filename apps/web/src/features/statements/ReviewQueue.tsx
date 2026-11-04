import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { useToast } from "@/components/ui/toast";
import { accountsQuery } from "@/features/accounts/api";
import { formatYen } from "@/lib/format";
import { invalidateLedger } from "@/lib/queries";
import {
  postApprove,
  postExclude,
  type StatementView,
  statementKeys,
  statementsQuery,
} from "./api";
import { BulkApprove } from "./BulkApprove";
import { METHOD_LABELS } from "./labels";

const SIDE_LABELS = { debit: "借方", credit: "貸方" } as const;

/** 行の key。同じ貸借・科目・金額の行が重なっても分かれるよう、何度目かを付ける */
function linesWithKey<L extends { side: string; accountId: string; amount: number }>(lines: L[]) {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const base = `${line.side}-${line.accountId}-${line.amount}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}-${n}`, line };
  });
}

/** 仕訳の案（draft）か、既存の仕訳への結びつき（match）が、候補にあるか */
const hasProposal = (candidate: StatementView["candidate"]) =>
  candidate !== null &&
  candidate.method !== "none" &&
  (candidate.draft !== null || candidate.match !== undefined);

/**
 * 明細の確認（011 US3。FR-021）: 未処理の明細を 1 件ずつ、明細と候補の仕訳を並べて出す。
 * 「承認して次へ」（主な操作）は候補のまま承認する（ルールは承認のたびに自動で学ぶ）。
 * 「飛ばす」は何も送らず次へ進み（この画面を開いている間だけ覚える）、「除外」は理由なしで除外する。
 * まとめて承認は上に置く。候補がない明細は一覧で直す入口を出す
 */
export function ReviewQueue({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const statements = useQuery(statementsQuery(entityId, { status: "unprocessed" }));
  const accounts = useQuery(accountsQuery(entityId));
  const [skipped, setSkipped] = useState<string[]>([]);

  const queue = statements.data?.filter((s) => !skipped.includes(s.id)) ?? [];
  const current = queue[0];

  const approve = useMutation({
    mutationFn: (s: StatementView) => postApprove(entityId, s.id, {}),
    onSuccess: async (result) => {
      await invalidateLedger(queryClient, entityId);
      const notes = [
        result.journal
          ? `承認しました（仕訳 No.${result.journal.journalNo}）。`
          : "既存の仕訳に結びつけました。",
        result.pairLink ? "振替の対の相手の明細も、同じ仕訳に結びつけました。" : "",
        ...result.warnings.map((w) => `注意: ${w.message}`),
      ].filter((n) => n !== "");
      toast.success(notes.join(" "));
    },
    onError: (e) => toast.error(e.message),
  });
  const exclude = useMutation({
    mutationFn: (s: StatementView) => postExclude(entityId, s.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: statementKeys.all(entityId) }),
        queryClient.invalidateQueries({ queryKey: ["entities", entityId, "home"] }),
      ]);
      toast.success("除外しました。");
    },
    onError: (e) => toast.error(e.message),
  });
  const busy = approve.isPending || exclude.isPending;

  const accountName = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? id;

  return (
    <div className="grid gap-6">
      {statements.data && <BulkApprove entityId={entityId} statements={statements.data} />}

      <section aria-label="明細の確認" className="grid gap-4">
        <h2 className="text-lg font-semibold">明細の確認</h2>
        <ApiErrorMessage error={statements.error ?? accounts.error} />
        {statements.isPending && !statements.error && (
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        )}

        {statements.data && current === undefined && (
          <div className="grid gap-3">
            <p className="font-medium">未処理の明細の確認が終わりました。</p>
            {skipped.length > 0 && (
              <p className="text-sm text-muted-foreground">
                飛ばした明細が {skipped.length} 件あります。明細の一覧から確認できます。
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Link
                to="/e/$entityId"
                params={{ entityId }}
                className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
              >
                ホームへ
              </Link>
              <Link
                to="/e/$entityId/statements"
                params={{ entityId }}
                className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
              >
                明細の一覧へ
              </Link>
            </div>
          </div>
        )}

        {current && (
          <div className="grid gap-4 rounded-md border px-4 py-4">
            <p className="text-sm text-muted-foreground tabular-nums">残り {queue.length} 件</p>
            <h3 className="font-medium">
              {current.date} {current.accountName} {current.content}（{formatYen(current.amount)}
              円）
            </h3>

            {hasProposal(current.candidate) && current.candidate ? (
              <div className="grid gap-2">
                <p className="text-sm text-muted-foreground">
                  <span>{METHOD_LABELS[current.candidate.method]}</span>
                  {current.candidate.confidence !== null && (
                    <span className="tabular-nums">（確信度 {current.candidate.confidence}）</span>
                  )}
                </p>
                <p className="text-sm">{current.candidate.reason}</p>
                {current.candidate.draft ? (
                  <table aria-label="候補の仕訳" className="w-full text-sm">
                    <tbody>
                      {linesWithKey(current.candidate.draft.lines).map(({ key, line: l }) => (
                        <tr key={key} className="border-b">
                          <td className="py-1 pr-4">{SIDE_LABELS[l.side]}</td>
                          <td className="py-1 pr-4">{accountName(l.accountId)}</td>
                          <td className="py-1 text-right tabular-nums">{formatYen(l.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-sm">既存の仕訳に結びつけます。</p>
                )}
              </div>
            ) : (
              <div className="grid gap-2">
                <p className="text-sm">仕訳の案がありません。</p>
                <div>
                  <Link
                    to="/e/$entityId/statements"
                    params={{ entityId }}
                    search={{ statementId: current.id }}
                    className="text-sm underline underline-offset-4"
                  >
                    一覧で仕訳を直す
                  </Link>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={busy || !hasProposal(current.candidate)}
                onClick={() => approve.mutate(current)}
              >
                承認して次へ
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setSkipped((ids) => [...ids, current.id])}
              >
                飛ばす
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => exclude.mutate(current)}>
                除外
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
