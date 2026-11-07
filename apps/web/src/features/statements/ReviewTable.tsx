import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JournalInput } from "@trebuchet/schema";
import { Fragment, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accountsQuery } from "@/features/accounts/api";
import { taxCategoriesQuery } from "@/features/entities/api";
import { homeKeys } from "@/features/home/api";
import { formatYen } from "@/lib/format";
import { invalidateLedger } from "@/lib/queries";
import {
  type ApproveBody,
  postApproveBulk,
  postExcludeBulk,
  type StatementView,
  statementAccountsQuery,
  statementKeys,
  statementSettingsQuery,
} from "./api";
import { CandidateEditor } from "./CandidateEditor";
import { METHOD_LABELS } from "./labels";
import { applyCounterEdit, type CounterEdit, counterLineIndex } from "./review-draft";

/** 候補のうち、承認の入力になるもの。`draft`＝仕訳の案、`match`＝既存の仕訳あり、`none`＝案なし */
type Proposal = "draft" | "match" | "none";

const proposalOf = (s: StatementView): Proposal => {
  const c = s.candidate;
  if (c === null || c.method === "none") return "none";
  if (c.method === "match") return c.match === undefined ? "none" : "match";
  return c.draft === null ? "none" : "draft";
};

/** 行を選べるのは、仕訳の案がある行だけ。既存の仕訳がある行（match）と候補のない行は選べない（007/R17） */
const selectable = (s: StatementView) => proposalOf(s) === "draft";

type BulkItem = {
  statementId: string;
  draft?: JournalInput | undefined;
  match?: ApproveBody["match"];
};

/** 処理の結果の知らせ。できなかった行は、明細の内容と理由を行ごとに出す */
type Outcome = { summary: string; failed: { label: string; message: string }[] };

const badgeClass = "ml-2 rounded-md border border-amber-500/60 px-1.5 py-0.5 text-xs";

/** 出金（負の金額）と入金（正の金額）の合計を別々に求める（相殺しない）。どちらも 0 以上の絶対値 */
const sumsOf = (statements: StatementView[]) => {
  let outflow = 0;
  let inflow = 0;
  for (const s of statements) {
    if (s.amount < 0) outflow -= s.amount;
    else inflow += s.amount;
  }
  return { outflow, inflow };
};

/**
 * 明細の確認の表（007/R17。011 FR-021）: 未処理の明細を一覧で出し、利用者が行を選んで承認・除外する。
 * - **最初はどの行も選ばない**。「すべて選択」「確信度の高い行を選択」は、仕訳の案があり、既存の仕訳がない行だけを選ぶ。
 * - 承認・除外の前に、確認のダイアログで件数と、出金・入金それぞれの合計を示す。しきい値で自動では承認しない。
 * - 相手の行がちょうど 1 行の案は、その場で科目・税区分を選び直せる（選び直した行だけ `draft` を送る）。それ以外は「詳細で編集」。
 * - 既存の仕訳がある行（match）は選べず、行ごとに「既存の仕訳と結びつける」か「詳細」で決める。
 * - 画面の主な操作（variant=default）は「選択した N 件を承認」だけ（「詳細」の確認を開いている間は、そちらが主になる）
 */
export function ReviewTable({
  entityId,
  statements,
  emptyMessage,
  toolbar,
}: {
  entityId: string;
  /** 未処理の明細（呼び出し側が絞り込む） */
  statements: StatementView[];
  /** 明細がないときの文言（省略で何も出さない） */
  emptyMessage?: string | undefined;
  /** 選択のボタンと同じ行の先頭に置く部品（状態・口座の絞り込み）。明細が 0 件でも出す */
  toolbar?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const accounts = useQuery(accountsQuery(entityId));
  const taxCategories = useQuery(taxCategoriesQuery(entityId));
  const statementAccounts = useQuery(statementAccountsQuery(entityId));
  const settings = useQuery(statementSettingsQuery(entityId));
  const threshold = settings.data?.bulkThreshold;
  const supportError = [accounts, taxCategories, statementAccounts, settings].find(
    (q) => q.error,
  )?.error;
  // 表は、科目・税区分・口座の対応・しきい値を読み終えてから出す（選び直しの欄と「確信度が低い」の印が最初からそろう）
  const loading = [accounts, taxCategories, statementAccounts, settings].some((q) => q.isPending);

  const [picked, setPicked] = useState<string[]>([]);
  const [edits, setEdits] = useState<Record<string, CounterEdit>>({});
  const [confirming, setConfirming] = useState<"approve" | "exclude">();
  const [detailId, setDetailId] = useState<string>();
  const [outcome, setOutcome] = useState<Outcome>();

  const selected = statements.filter((s) => selectable(s) && picked.includes(s.id));
  const detail = statements.find((s) => s.id === detailId);

  const accountOf = (s: StatementView) =>
    statementAccounts.data?.find((a) => a.name === s.accountName);
  const accountName = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? "（不明）";
  /** 相手の行を選び直せる行の、案の中の位置。選び直せない行は undefined */
  const counterIndexOf = (s: StatementView) =>
    s.candidate?.draft ? counterLineIndex(s.candidate.draft, accountOf(s)) : undefined;
  /** 選び直した科目・税区分を入れた案。選び直していない行は undefined（候補のまま承認する） */
  const draftFor = (s: StatementView): JournalInput | undefined => {
    const edit = edits[s.id];
    const index = counterIndexOf(s);
    const original = s.candidate?.draft;
    if (edit === undefined || index === undefined || !original) return undefined;
    const next = applyCounterEdit(original, index, edit);
    return JSON.stringify(next) === JSON.stringify(original) ? undefined : next;
  };

  const labelsOf = (rows: StatementView[]) =>
    Object.fromEntries(rows.map((s) => [s.id, `${s.date} ${s.content}`]));

  const approve = useMutation({
    mutationFn: ({ items }: { items: BulkItem[]; labels: Record<string, string> }) =>
      postApproveBulk(entityId, items),
    onSuccess: async (result, { labels }) => {
      setOutcome({
        summary: `${result.approved.length} 件を承認しました。`,
        failed: result.failed.map((f) => ({
          label: labels[f.statementId] ?? f.statementId,
          message: f.message,
        })),
      });
      setPicked((ids) => ids.filter((id) => !result.approved.includes(id)));
      await invalidateLedger(queryClient, entityId);
    },
  });
  const exclude = useMutation({
    mutationFn: ({ ids }: { ids: string[]; labels: Record<string, string> }) =>
      postExcludeBulk(entityId, ids),
    onSuccess: async (result, { labels }) => {
      setOutcome({
        summary: `${result.excluded.length} 件を除外しました。`,
        failed: result.failed.map((f) => ({
          label: labels[f.statementId] ?? f.statementId,
          message: f.message,
        })),
      });
      setPicked((ids) => ids.filter((id) => !result.excluded.includes(id)));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: statementKeys.all(entityId) }),
        queryClient.invalidateQueries({ queryKey: homeKeys.all(entityId) }),
      ]);
    },
  });
  const busy = approve.isPending || exclude.isPending;

  const approveRows = (rows: StatementView[], itemOf: (s: StatementView) => BulkItem) => {
    setOutcome(undefined);
    approve.mutate({ items: rows.map(itemOf), labels: labelsOf(rows) });
  };
  const draftItem = (s: StatementView): BulkItem => {
    const draft = draftFor(s);
    return draft === undefined ? { statementId: s.id } : { statementId: s.id, draft };
  };
  const excludeRows = (rows: StatementView[]) => {
    setOutcome(undefined);
    exclude.mutate({ ids: rows.map((s) => s.id), labels: labelsOf(rows) });
  };

  const toggle = (id: string, on: boolean) =>
    setPicked((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  const selectWhere = (keep: (s: StatementView) => boolean) =>
    setPicked(statements.filter((s) => selectable(s) && keep(s)).map((s) => s.id));

  const confirmingRows = selected;
  const { outflow, inflow } = sumsOf(confirmingRows);
  /** 選択のボタンと表を出せる（明細があり、読み込みが済んだ。読み込みの失敗でも出す） */
  const ready = statements.length > 0 && (!loading || supportError !== undefined);

  return (
    <section aria-label="明細の確認" className="grid gap-4">
      <h2 className="text-lg font-semibold">明細の確認</h2>
      <ApiErrorMessage error={supportError ?? approve.error ?? exclude.error} />

      {outcome && (
        <div className="grid gap-2 text-sm">
          <p role="status">{outcome.summary}</p>
          {outcome.failed.length > 0 && (
            <>
              <p className="font-medium">できなかった明細（そのまま残っています）</p>
              <ul aria-label="できなかった明細" className="grid gap-1">
                {outcome.failed.map((f) => (
                  <li
                    key={`${f.label}-${f.message}`}
                    className="rounded-md border border-destructive/50 px-3 py-1.5"
                  >
                    {f.label}: {f.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {statements.length === 0 && emptyMessage !== undefined && (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      )}
      {statements.length > 0 && loading && !supportError && (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      )}

      {(toolbar !== undefined || ready) && (
        <div className="flex flex-wrap items-end gap-3">
          {toolbar}
          {ready && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => selectWhere(() => true)}>
                すべて選択
              </Button>
              <Button
                variant="outline"
                disabled={busy || threshold === undefined}
                onClick={() =>
                  selectWhere((s) => (s.candidate?.confidence ?? 0) >= (threshold ?? 101))
                }
              >
                確信度の高い行を選択
              </Button>
              <Button
                variant="outline"
                disabled={busy || picked.length === 0}
                onClick={() => setPicked([])}
              >
                選択を解除
              </Button>
              <Button
                variant={detail === undefined ? "default" : "outline"}
                disabled={busy || selected.length === 0}
                onClick={() => setConfirming("approve")}
              >
                選択した {selected.length} 件を承認
              </Button>
              <Button
                variant="outline"
                disabled={busy || selected.length === 0}
                onClick={() => setConfirming("exclude")}
              >
                選択した {selected.length} 件を除外
              </Button>
            </>
          )}
        </div>
      )}

      {ready && (
        <>
          <Table aria-label="未処理の明細">
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="sr-only">選択</span>
                </TableHead>
                <TableHead>日付</TableHead>
                <TableHead>口座・内容</TableHead>
                <TableHead className="text-right">金額</TableHead>
                <TableHead>相手の科目</TableHead>
                <TableHead>税区分</TableHead>
                <TableHead>推定の出どころ</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statements.map((s) => {
                const c = s.candidate;
                const proposal = proposalOf(s);
                const index = counterIndexOf(s);
                const edit = edits[s.id];
                const counter = index === undefined ? undefined : c?.draft?.lines[index];
                const low =
                  threshold !== undefined &&
                  proposal === "draft" &&
                  c?.confidence != null &&
                  c.confidence < threshold;
                const setEdit = (patch: CounterEdit) =>
                  setEdits((all) => ({ ...all, [s.id]: { ...all[s.id], ...patch } }));
                return (
                  <Fragment key={s.id}>
                    <TableRow className="align-top">
                      <TableCell>
                        <input
                          type="checkbox"
                          className="size-4"
                          aria-label={`${s.content} を選択`}
                          disabled={!selectable(s) || busy}
                          checked={selected.some((x) => x.id === s.id)}
                          onChange={(e) => toggle(s.id, e.target.checked)}
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{s.date}</TableCell>
                      <TableCell>
                        <div className="text-xs text-muted-foreground">{s.accountName}</div>
                        <div>
                          {s.content}
                          {s.duplicateOf !== undefined && s.duplicateOf.length > 0 && (
                            <span className={badgeClass}>重複の疑い</span>
                          )}
                          {s.changed !== null && <span className={badgeClass}>変更あり</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatYen(s.amount)}
                      </TableCell>
                      <TableCell>
                        {counter !== undefined && accounts.data ? (
                          <NativeSelect
                            aria-label={`${s.content} の相手の科目`}
                            value={edit?.accountId ?? counter.accountId}
                            disabled={busy}
                            onChange={(e) => setEdit({ accountId: e.target.value })}
                          >
                            {accounts.data
                              .filter((a) => a.isActive || a.id === counter.accountId)
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                          </NativeSelect>
                        ) : proposal === "draft" && c?.draft ? (
                          <div className="grid gap-1 text-sm">
                            <span>
                              {[
                                ...new Set(c.draft.lines.map((l) => accountName(l.accountId))),
                              ].join("、")}
                            </span>
                            <span className="text-xs text-muted-foreground">詳細で編集</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {counter !== undefined ? (
                          <NativeSelect
                            aria-label={`${s.content} の税区分`}
                            value={edit?.taxCategory ?? counter.taxCategory ?? ""}
                            disabled={busy}
                            onChange={(e) => setEdit({ taxCategory: e.target.value })}
                          >
                            <option value="">未指定</option>
                            {taxCategories.data?.map((t) => (
                              <option key={t.code} value={t.code}>
                                {t.name}
                              </option>
                            ))}
                          </NativeSelect>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-64 text-sm">
                        <div>{c === null ? "未作成" : METHOD_LABELS[c.method]}</div>
                        {c?.confidence != null && (
                          <div className="tabular-nums">
                            確信度 {c.confidence}
                            {low && (
                              <span className="ml-2 rounded-md border border-amber-500/60 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900">
                                確信度が低い
                              </span>
                            )}
                          </div>
                        )}
                        {proposal === "match" && (
                          <div className="mt-1 w-fit rounded-md border border-amber-500/60 px-1.5 py-0.5 text-xs">
                            既存の仕訳あり
                          </div>
                        )}
                        {c !== null && c.method !== "none" && (
                          <div className="mt-1 text-xs text-muted-foreground">{c.reason}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          {proposal === "draft" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => approveRows([s], draftItem)}
                            >
                              登録
                            </Button>
                          )}
                          {proposal === "match" && c?.match !== undefined && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              title="同じ取引の仕訳がすでにあるときに選びます。新しい仕訳は作らず、その仕訳に明細を結びつけます。"
                              onClick={() =>
                                approveRows([s], (row) => ({
                                  statementId: row.id,
                                  ...(row.candidate?.match === undefined
                                    ? {}
                                    : { match: row.candidate.match }),
                                }))
                              }
                            >
                              既存の仕訳と結びつける
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            title="帳簿に入れない明細にします（私用など）。仕訳は作りません。あとから取り消せます。"
                            onClick={() => excludeRows([s])}
                          >
                            除外
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => {
                              setOutcome(undefined);
                              setDetailId(s.id);
                            }}
                          >
                            詳細
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {/* 「詳細」の確認は、その行のすぐ下に開く（画面の一番下だと気づきにくい） */}
                    {detail?.id === s.id && (
                      <TableRow>
                        <TableCell colSpan={8}>
                          <CandidateEditor
                            key={detail.id}
                            entityId={entityId}
                            statement={detail}
                            onClose={() => setDetailId(undefined)}
                            onApproved={(message) => {
                              setDetailId(undefined);
                              setOutcome({ summary: message, failed: [] });
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </>
      )}

      <Dialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              選択した {confirmingRows.length} 件を{confirming === "exclude" ? "除外" : "承認"}
              しますか
            </DialogTitle>
            <DialogDescription>
              {confirmingRows.length} 件。
              {outflow > 0 && <span>出金 {formatYen(outflow)} 円</span>}
              {outflow > 0 && inflow > 0 && "、"}
              {inflow > 0 && <span>入金 {formatYen(inflow)} 円</span>}
              {(outflow > 0 || inflow > 0) && "。"}
              {confirming === "exclude"
                ? "除外した明細は、帳簿に入りません（状態を「除外」にして、あとから取り消せます）。"
                : "承認すると、案のとおり仕訳が登録されます（選び直した科目・税区分は、その内容で登録します）。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(undefined)}>
              戻る
            </Button>
            <Button
              onClick={() => {
                const kind = confirming;
                setConfirming(undefined);
                if (kind === "exclude") excludeRows(confirmingRows);
                else approveRows(confirmingRows, draftItem);
              }}
            >
              {confirming === "exclude" ? "除外する" : "承認する"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
