import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatYen } from "@/lib/format";
import { badgeClass } from "@/lib/styles";
import type { StatementView } from "./api";
import { changedFields } from "./changes";
import { METHOD_LABELS, STATUS_LABELS } from "./labels";

/** 一覧の行の操作。呼び出し側（`StatementsWorkspace`）が API を呼ぶ */
export type StatementActions = {
  onReview: (statement: StatementView) => void;
  onExclude: (statement: StatementView) => void;
  onUnexclude: (statement: StatementView) => void;
  onAcknowledge: (statement: StatementView) => void;
  onUnlink: (statement: StatementView) => void;
};

function Row({
  entityId,
  statement: s,
  highlight,
  busy,
  actions,
}: {
  entityId: string;
  statement: StatementView;
  highlight: boolean;
  busy: boolean;
  actions: StatementActions;
}) {
  const candidate = s.candidate;
  return (
    <TableRow aria-current={highlight ? "true" : undefined} className="align-top">
      <TableCell className="whitespace-nowrap">{s.date}</TableCell>
      <TableCell>{s.accountName}</TableCell>
      <TableCell>
        {s.content}
        {s.duplicateOf !== undefined && s.duplicateOf.length > 0 && (
          <span className={badgeClass}>重複の疑い</span>
        )}
        {s.changed !== null && (
          <div className="mt-1 grid gap-1 text-xs">
            <span className="w-fit rounded-md border border-amber-500/60 px-1.5 py-0.5">
              変更あり
            </span>
            <ul className="list-disc pl-4 text-muted-foreground">
              {changedFields(s.changed).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatYen(s.amount)}</TableCell>
      <TableCell>{STATUS_LABELS[s.status]}</TableCell>
      <TableCell>{candidate === null ? "未作成" : METHOD_LABELS[candidate.method]}</TableCell>
      <TableCell className="text-right tabular-nums">{candidate?.confidence ?? ""}</TableCell>
      <TableCell className="max-w-64 text-sm text-muted-foreground">{candidate?.reason}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2">
          {s.status === "unprocessed" && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => actions.onReview(s)}
              >
                確認する
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => actions.onExclude(s)}
              >
                除外
              </Button>
            </>
          )}
          {s.status === "excluded" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => actions.onUnexclude(s)}
            >
              除外を取り消す
            </Button>
          )}
          {s.changed !== null && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => actions.onAcknowledge(s)}
            >
              確認した
            </Button>
          )}
          {s.status === "registered" &&
            s.links.map((l) => (
              <Link
                key={`${l.journalId}-${l.kind}`}
                to="/e/$entityId/journals/$journalId"
                params={{ entityId, journalId: l.journalId }}
                className="text-sm text-primary underline underline-offset-4"
              >
                仕訳を開く
              </Link>
            ))}
          {s.status === "registered" && s.links.some((l) => l.kind === "matched") && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => actions.onUnlink(s)}>
              結びつきを外す
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * 明細の一覧（H:§4.1。FR-012）: 日付・口座・内容・金額・状態・候補の判定・確信度・根拠と、状態ごとの操作。
 * `highlightId` の行に印を付ける（仕訳の詳細の「元の明細」から開いたとき）
 */
export function StatementList({
  entityId,
  statements,
  highlightId,
  busyId,
  actions,
}: {
  entityId: string;
  statements: StatementView[];
  highlightId: string | undefined;
  /** 操作中の明細（操作のボタンを止める） */
  busyId: string | undefined;
  actions: StatementActions;
}) {
  return (
    <Table aria-label="明細の一覧">
      <TableHeader>
        <TableRow>
          <TableHead>日付</TableHead>
          <TableHead>口座</TableHead>
          <TableHead>内容</TableHead>
          <TableHead className="text-right">金額</TableHead>
          <TableHead>状態</TableHead>
          <TableHead>判定</TableHead>
          <TableHead className="text-right">確信度</TableHead>
          <TableHead>根拠</TableHead>
          <TableHead>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {statements.map((s) => (
          <Row
            key={s.id}
            entityId={entityId}
            statement={s}
            highlight={s.id === highlightId}
            busy={busyId === s.id}
            actions={actions}
          />
        ))}
      </TableBody>
    </Table>
  );
}
