import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StatementStatusFilter } from "@trebuchet/schema";
import { useEffect, useRef, useState } from "react";
import { Loading } from "@/components/loading";
import { ReasonDialog } from "@/components/reason-dialog";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { useToast } from "@/components/ui/toast";
import { AiProgressLines } from "./AiProgressLines";
import {
  postAcknowledgeChange,
  postBuildCandidates,
  postExclude,
  postUnexclude,
  postUnlink,
  type StatementView,
  statementAccountsQuery,
  statementKeys,
  statementsQuery,
} from "./api";
import { CandidateEditor } from "./CandidateEditor";
import { type AiProgress, aiFailureMessage, inferNeedsAi } from "./candidate-chain";
import { STATUS_FILTER_OPTIONS } from "./labels";
import { ReviewTable } from "./ReviewTable";
import { StatementList } from "./StatementList";

type ReasonTarget = { kind: "unexclude" | "unlink"; statement: StatementView };

/**
 * 明細の一覧の画面（006/US2。007/R17）: 絞り込み・候補の確認と承認・除外・結びつきを外す。
 * 状態が「未処理」のときは確認の表（`ReviewTable`: 行を選んで承認・除外。絞り込みは選択のボタンと同じ行）、
 * ほかの状態は一覧の表（`StatementList`。絞り込みは表の上）。
 * 開いたとき（1 回）、未処理の明細があれば候補を作り直し（AI の候補は残る）、AI に回す明細を自動で推定する。
 * 仕訳が変わる承認は `CandidateEditor` と `ReviewTable` が `invalidateLedger` を呼ぶ
 */
export function StatementsWorkspace({
  entityId,
  highlightId,
  initialStatus,
}: {
  entityId: string;
  /** 仕訳の詳細の「元の明細」から開いた明細（状態を「すべて」にして印を付ける） */
  highlightId: string | undefined;
  /** URL の `status`（ホームの「未処理の明細」など）。省略は未処理（`highlightId` があれば「すべて」） */
  initialStatus?: StatementStatusFilter | undefined;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<StatementStatusFilter | "">(
    initialStatus ?? (highlightId === undefined ? "unprocessed" : ""),
  );
  const [accountId, setAccountId] = useState("");
  const [reviewingId, setReviewingId] = useState<string>();
  const [reasonTarget, setReasonTarget] = useState<ReasonTarget>();
  const [notice, setNotice] = useState("");
  /** 候補の作り直しの後の、AI の推定の進み（AI が無効なら出ない） */
  const [ai, setAi] = useState<AiProgress>();

  const filter = {
    ...(status === "" ? {} : { status }),
    ...(accountId === "" ? {} : { accountId }),
  };
  const statements = useQuery(statementsQuery(entityId, filter));
  // 作り直しの要否は、絞り込みによらず未処理の明細の有無で決める（状態が「未処理」で口座の絞り込みがなければ、上と同じキー）
  const unprocessed = useQuery(statementsQuery(entityId, { status: "unprocessed" }));
  const accounts = useQuery(statementAccountsQuery(entityId));
  const reviewing = statements.data?.find((s) => s.id === reviewingId);

  const refresh = () => queryClient.invalidateQueries({ queryKey: statementKeys.all(entityId) });

  /** AI に回す明細を推定する（設定が有効なときだけ）。候補だけが変わり、仕訳は変わらない */
  const inferAi = async (needsAi: string[]) => {
    const run = await inferNeedsAi({ entityId, queryClient, needsAi, onProgress: setAi });
    if (!run.skipped && run.error !== undefined) {
      toast.error(aiFailureMessage(run.done, needsAi.length, run.error));
    }
    await refresh();
  };
  const build = useMutation({
    mutationFn: () => postBuildCandidates(entityId),
    onSuccess: async (result) => {
      await refresh();
      // 推定は時間がかかるので、候補の更新の完了を待たせない
      if (result.needsAi.length > 0) void inferAi(result.needsAi);
    },
  });
  // 開いたとき 1 回だけ（読み直しや StrictMode の二重実行でも、ref が保たれるので呼び直さない）
  const rebuilt = useRef(false);
  const { mutate: rebuild } = build;
  useEffect(() => {
    if (rebuilt.current || unprocessed.data === undefined) return;
    rebuilt.current = true;
    if (unprocessed.data.length > 0) rebuild();
  }, [unprocessed.data, rebuild]);
  const exclude = useMutation({
    mutationFn: (s: StatementView) => postExclude(entityId, s.id),
    onSuccess: refresh,
  });
  const acknowledge = useMutation({
    mutationFn: (s: StatementView) => postAcknowledgeChange(entityId, s.id),
    onSuccess: refresh,
  });

  const confirmReason = async (reason: string) => {
    if (!reasonTarget) return;
    const { kind, statement } = reasonTarget;
    await (kind === "unexclude"
      ? postUnexclude(entityId, statement.id, reason)
      : postUnlink(entityId, statement.id, reason));
    setReasonTarget(undefined);
    await refresh();
  };

  const busyId = exclude.isPending
    ? exclude.variables?.id
    : acknowledge.isPending
      ? acknowledge.variables?.id
      : undefined;
  const error = statements.error ?? accounts.error ?? exclude.error ?? acknowledge.error;

  const filters = (
    <>
      <div className="grid gap-1">
        <Label htmlFor="statement-status">状態</Label>
        <NativeSelect
          id="statement-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as StatementStatusFilter | "")}
        >
          {STATUS_FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="statement-account">口座</Label>
        <NativeSelect
          id="statement-account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          <option value="">すべて</option>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </NativeSelect>
      </div>
    </>
  );

  return (
    <div className="grid gap-6">
      <SaveNotice message={notice} />
      {(build.isPending || ai !== undefined) && (
        <div className="grid gap-1 text-sm text-muted-foreground">
          {build.isPending && <p role="status">候補を更新中…</p>}
          {ai !== undefined && (
            <div role="status" aria-label="AI の推定の進捗" className="grid gap-1">
              <AiProgressLines ai={ai} />
            </div>
          )}
        </div>
      )}
      <ApiErrorMessage error={build.error} />

      {status !== "unprocessed" && <div className="flex flex-wrap items-end gap-4">{filters}</div>}

      <ApiErrorMessage error={error} />
      {statements.isPending && !error && <Loading />}
      {statements.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">該当する明細はありません。</p>
      )}
      {/* 未処理は確認の表。明細がなくなっても、承認・除外の結果の知らせと絞り込みを残すため外さない */}
      {status === "unprocessed" && (
        <ReviewTable entityId={entityId} statements={statements.data ?? []} toolbar={filters} />
      )}
      {statements.data && statements.data.length > 0 && status !== "unprocessed" && (
        <StatementList
          entityId={entityId}
          statements={statements.data}
          highlightId={highlightId}
          busyId={busyId}
          actions={{
            onReview: (s) => {
              setNotice("");
              setReviewingId(s.id);
            },
            onExclude: (s) => exclude.mutate(s),
            onUnexclude: (s) => setReasonTarget({ kind: "unexclude", statement: s }),
            onAcknowledge: (s) => acknowledge.mutate(s),
            onUnlink: (s) => setReasonTarget({ kind: "unlink", statement: s }),
          }}
        />
      )}

      {reviewing && (
        <CandidateEditor
          key={reviewing.id}
          entityId={entityId}
          statement={reviewing}
          onClose={() => setReviewingId(undefined)}
          onApproved={(message) => {
            setReviewingId(undefined);
            setNotice(message);
          }}
        />
      )}

      <ReasonDialog
        open={reasonTarget !== undefined}
        title={reasonTarget?.kind === "unlink" ? "結びつきを外す理由" : "除外を取り消す理由"}
        description={
          reasonTarget?.kind === "unlink"
            ? "既存の仕訳との結びつきを外すと、明細は未処理に戻ります（仕訳は変わりません）。理由は記録に残ります。"
            : "除外を取り消すと、明細は未処理に戻ります。理由は記録に残ります。"
        }
        confirmLabel={reasonTarget?.kind === "unlink" ? "結びつきを外す" : "除外を取り消す"}
        onConfirm={confirmReason}
        onCancel={() => setReasonTarget(undefined)}
      />
    </div>
  );
}
