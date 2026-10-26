import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type CandidateMethod, MAX_INFER_BATCH } from "@trebuchet/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { postInfer, statementKeys } from "./api";
import { METHOD_LABELS } from "./labels";

type Progress = {
  total: number;
  done: number;
  counts: Partial<Record<CandidateMethod, number>>;
  externalUsed: boolean;
  localAvailable: boolean;
  finished: boolean;
};

/** 表示の順（AI が決めた順に、候補なしを最後） */
const COUNT_ORDER: CandidateMethod[] = ["local_ai", "external_ai", "none"];

const chunks = <T,>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
};

const summary = (progress: Progress, failed: boolean): string => {
  if (!progress.finished) {
    return failed
      ? `${progress.done} / ${progress.total} 件で止まりました。`
      : `推定しています… ${progress.done} / ${progress.total} 件`;
  }
  const parts = COUNT_ORDER.flatMap((m) => {
    const count = progress.counts[m];
    return count ? [`${METHOD_LABELS[m]} ${count} 件`] : [];
  });
  return `${progress.total} 件を推定しました${parts.length > 0 ? `（${parts.join("、")}）` : ""}。`;
};

/**
 * AI で推定（H:§4.3。FR-025〜028）。「候補を作る」で AI に回すことになった明細（`needsAi`）を、
 * 10 件ずつ順に送る。1 回ごとに進捗を出し、失敗したらそこで止める（済んだ分の候補は残る）。
 * 推定は候補だけを変え、仕訳は変えない。送り終えた明細は `onProcessed` で対象から外す
 */
export function AiInfer({
  entityId,
  needsAi,
  onProcessed,
}: {
  entityId: string;
  needsAi: string[];
  onProcessed: (ids: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<Progress>();

  const infer = useMutation({
    mutationFn: async (ids: string[]) => {
      let state: Progress = {
        total: ids.length,
        done: 0,
        counts: {},
        externalUsed: false,
        localAvailable: true,
        finished: false,
      };
      setProgress(state);
      try {
        for (const batch of chunks(ids, MAX_INFER_BATCH)) {
          const response = await postInfer(entityId, batch);
          const counts = { ...state.counts };
          for (const r of response.results) counts[r.method] = (counts[r.method] ?? 0) + 1;
          state = {
            ...state,
            done: state.done + batch.length,
            counts,
            externalUsed: state.externalUsed || response.externalUsed,
            localAvailable: response.localAvailable,
          };
          setProgress(state);
          onProcessed(batch);
        }
        setProgress({ ...state, finished: true });
      } finally {
        // 済んだ分の候補を読み直す（失敗しても残る）
        await queryClient.invalidateQueries({ queryKey: statementKeys.all(entityId) });
      }
    },
  });

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          disabled={needsAi.length === 0 || infer.isPending}
          onClick={() => infer.mutate(needsAi)}
        >
          AI で推定
        </Button>
        <span className="text-sm text-muted-foreground tabular-nums">
          AI に回す明細: {needsAi.length} 件
        </span>
      </div>
      {progress && (
        <div role="status" aria-label="AI の推定の進捗" className="grid gap-1 text-sm">
          <p>{summary(progress, infer.isError)}</p>
          {progress.done > 0 && !progress.localAvailable && (
            <p>端末内の AI が使えません。設定を確かめてください。</p>
          )}
          {progress.externalUsed && (
            <p>外部の AI へ内容を送りました（確信度がしきい値に届かなかった明細だけ）。</p>
          )}
        </div>
      )}
      <ApiErrorMessage error={infer.error} />
    </div>
  );
}
