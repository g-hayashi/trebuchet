import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { StatementStatusFilter } from "@trebuchet/schema";
import { useState } from "react";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { AiInfer } from "./AiInfer";
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
import { BulkApprove } from "./BulkApprove";
import { CandidateEditor } from "./CandidateEditor";
import { STATUS_FILTER_OPTIONS } from "./labels";
import { StatementList } from "./StatementList";

const linkButtonClass =
  "inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent";

type ReasonTarget = { kind: "unexclude" | "unlink"; statement: StatementView };

/**
 * 明細の一覧の画面（US2）: 絞り込み・候補を作る・まとめて承認・候補の確認と承認・除外・結びつきを外す。
 * 仕訳が変わる承認は `CandidateEditor` と `BulkApprove` が `invalidateLedger` を呼ぶ
 */
export function StatementsWorkspace({
  entityId,
  highlightId,
}: {
  entityId: string;
  /** 仕訳の詳細の「元の明細」から開いた明細（状態を「すべて」にして印を付ける） */
  highlightId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatementStatusFilter | "">(
    highlightId === undefined ? "unprocessed" : "",
  );
  const [accountId, setAccountId] = useState("");
  const [reviewingId, setReviewingId] = useState<string>();
  const [reasonTarget, setReasonTarget] = useState<ReasonTarget>();
  const [notice, setNotice] = useState("");
  /** 「候補を作る」で AI に回すことになった明細の ID（AI で推定が送り終えると外れる） */
  const [needsAi, setNeedsAi] = useState<string[]>([]);

  const filter = {
    ...(status === "" ? {} : { status }),
    ...(accountId === "" ? {} : { accountId }),
  };
  const statements = useQuery(statementsQuery(entityId, filter));
  const accounts = useQuery(statementAccountsQuery(entityId));
  const reviewing = statements.data?.find((s) => s.id === reviewingId);

  const refresh = () => queryClient.invalidateQueries({ queryKey: statementKeys.all(entityId) });

  const build = useMutation({
    mutationFn: () => postBuildCandidates(entityId),
    onSuccess: async (result) => {
      setNotice(`候補を ${result.built} 件作りました（候補なし ${result.needsAi.length} 件）。`);
      setNeedsAi(result.needsAi);
      await refresh();
    },
  });
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

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/e/$entityId/statements/import" params={{ entityId }} className={linkButtonClass}>
          明細を取り込む
        </Link>
        <Link to="/e/$entityId/statements/rules" params={{ entityId }} className={linkButtonClass}>
          推定のルール
        </Link>
        <Link
          to="/e/$entityId/statements/settings"
          params={{ entityId }}
          className={linkButtonClass}
        >
          しきい値の設定
        </Link>
        <Link to="/e/$entityId/statements/evals" params={{ entityId }} className={linkButtonClass}>
          推定の評価
        </Link>
        <Button disabled={build.isPending} onClick={() => build.mutate()}>
          候補を作る
        </Button>
        {notice && <SaveNotice message={notice} />}
      </div>
      <ApiErrorMessage error={build.error} />
      <AiInfer
        entityId={entityId}
        needsAi={needsAi}
        onProcessed={(ids) => setNeedsAi((current) => current.filter((id) => !ids.includes(id)))}
      />

      <div className="flex flex-wrap items-end gap-4">
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
      </div>

      <ApiErrorMessage error={error} />
      {statements.data && <BulkApprove entityId={entityId} statements={statements.data} />}

      {statements.isPending && !error && (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      )}
      {statements.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">該当する明細はありません。</p>
      )}
      {statements.data && statements.data.length > 0 && (
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
