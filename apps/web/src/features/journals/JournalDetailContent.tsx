import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { JournalCorrection, JournalInput } from "@trebuchet/schema";
import { useState } from "react";
import { Loading } from "@/components/loading";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { subAccountsQuery } from "@/features/accounts/api";
import { JournalOrigin } from "@/features/invoicing/JournalOrigin";
import {
  type HistoryEntry,
  type Journal,
  type JournalDetail,
  journalHistoryQuery,
  journalQuery,
  postJournalVoid,
  putJournal,
} from "@/features/journals/api";
import { JournalForm } from "@/features/journals/JournalForm";
import { JOURNAL_REASONS } from "@/features/journals/reasons";
import { useJournalMasters } from "@/features/journals/use-journal-masters";
import { fiscalPeriodsQuery } from "@/features/periods/api";
import { periodOf } from "@/features/periods/current";
import { JournalReceipts } from "@/features/receipts/JournalReceipts";
import { JournalStatements } from "@/features/statements/JournalStatements";
import { SIDE_LABELS } from "@/lib/accounts";
import { isApiError } from "@/lib/api";
import { formatDateTime, formatYen } from "@/lib/format";
import { invalidateLedger } from "@/lib/queries";
import { linkClass } from "@/lib/styles";

const ACTION_LABELS = { create: "登録", correct: "訂正", void: "取消" } as const;

type Names = {
  accounts: Map<string, string>;
  partners: Map<string, string>;
  tags: Map<string, string>;
  taxCategories: Map<string, string>;
};

const namesOf = <T extends { name: string }>(
  items: readonly T[] | undefined,
  key: (t: T) => string,
) => new Map(items?.map((t) => [key(t), t.name]));

/** 訂正の入力を、理由の入力を待ってから送るための保留中の入力 */
type PendingCorrection = {
  input: JournalInput;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export function JournalDetailContent({
  entityId,
  journalId,
  embedded = false,
  onCorrectionDirtyChange,
}: {
  entityId: string;
  journalId: string;
  embedded?: boolean | undefined;
  /** 訂正のフォームに未保存の変更があるかが変わったとき呼ぶ（Sheet を閉じる前の確認用） */
  onCorrectionDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const Heading = embedded ? "h3" : "h1";
  const queryClient = useQueryClient();
  const detail = useQuery(journalQuery(entityId, journalId));
  const history = useQuery(journalHistoryQuery(entityId, journalId));
  const {
    accounts,
    partners,
    tags,
    taxSettings,
    taxCategories,
    queries: masterQueries,
    loadError,
  } = useJournalMasters(entityId);
  const periods = useQuery(fiscalPeriodsQuery(entityId));
  const error = detail.error ?? history.error ?? loadError ?? periods.error;

  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<PendingCorrection>();
  const [voiding, setVoiding] = useState(false);
  const [closedYear, setClosedYear] = useState<number>();

  const invalidate = () => invalidateLedger(queryClient, entityId);
  const correct = useMutation({
    mutationFn: (json: JournalCorrection) => putJournal(entityId, journalId, json),
    onSuccess: invalidate,
  });
  const voidJournal = useMutation({
    mutationFn: (json: { reason: string; version: number }) =>
      postJournalVoid(entityId, journalId, json),
    onSuccess: invalidate,
  });

  const journal = detail.data?.journal;
  const period = journal && periods.data ? periodOf(periods.data, journal.date) : undefined;
  const closedFiscalYear = period?.status === "closed" ? period.fiscalYear : closedYear;
  const names: Names = {
    accounts: namesOf(accounts.data, (a) => a.id),
    partners: namesOf(partners.data, (p) => p.id),
    tags: namesOf(tags.data, (t) => t.id),
    taxCategories: namesOf(taxCategories.data, (c) => c.code),
  };

  /** 締め済みの年度の仕訳を、訂正仕訳で直すよう案内された（001/FR-019a） */
  const showClosed = (e: unknown) => {
    if (!isApiError(e, "PERIOD_CLOSED")) return false;
    const year = e.details?.fiscalYear;
    setClosedYear(typeof year === "number" ? year : (period?.fiscalYear ?? 0));
    setEditing(false);
    return true;
  };

  const confirmCorrection = async (reason: string) => {
    if (!pending || !journal) return;
    try {
      await correct.mutateAsync({ ...pending.input, reason, version: journal.version });
      pending.resolve();
      setPending(undefined);
      setEditing(false);
    } catch (e) {
      // 理由の誤りはダイアログに表示し、それ以外はフォームの該当の項目に表示する
      if (isApiError(e, "REASON_REQUIRED")) throw e;
      setPending(undefined);
      if (showClosed(e)) pending.resolve();
      else pending.reject(e);
    }
  };

  const confirmVoid = async (reason: string) => {
    if (!journal) return;
    try {
      await voidJournal.mutateAsync({ reason, version: journal.version });
      setVoiding(false);
    } catch (e) {
      if (!showClosed(e)) throw e;
      setVoiding(false);
    }
  };

  const loading = [detail, history, ...masterQueries, periods].some((q) => q.isPending);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <Heading className="text-xl font-semibold">
          {journal ? `仕訳 No.${journal.journalNo}` : "仕訳"}
        </Heading>
        {journal?.status === "voided" && (
          <span className="rounded-md border px-2 py-0.5 text-sm text-muted-foreground">
            取消済み
          </span>
        )}
        {!embedded && (
          <Link
            to="/e/$entityId/journals"
            params={{ entityId }}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            仕訳の一覧へ
          </Link>
        )}
        {journal && (
          <Link
            to="/e/$entityId/journals/new"
            params={{ entityId }}
            search={{ from: journal.id }}
            className="text-sm text-primary underline underline-offset-4"
          >
            複製して入力
          </Link>
        )}
      </div>
      <ApiErrorMessage error={error} />
      {loading && !error && <Loading />}

      {detail.data && journal && !loading && !error && (
        <>
          <References entityId={entityId} detail={detail.data} />
          <JournalOrigin entityId={entityId} journalId={journalId} />
          <JournalStatements entityId={entityId} statements={detail.data.statements ?? []} />
          <JournalReceipts entityId={entityId} receipts={detail.data.receipts ?? []} />
          {closedFiscalYear !== undefined && journal.status === "active" && (
            <div className="grid gap-2 rounded-md border border-amber-500/60 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p>
                {closedFiscalYear}
                年度は締め済みです。この仕訳は訂正・取消できません。当年度の日付で訂正仕訳を起票してください。
              </p>
              <Link
                to="/e/$entityId/journals/new"
                params={{ entityId }}
                search={{ correctsJournalId: journal.id }}
                className="w-fit font-medium underline underline-offset-4"
              >
                当年度に訂正仕訳を起票
              </Link>
            </div>
          )}

          {editing &&
          accounts.data &&
          partners.data &&
          tags.data &&
          taxSettings.data &&
          taxCategories.data ? (
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle>仕訳の訂正</CardTitle>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  訂正をやめる
                </Button>
              </CardHeader>
              <CardContent>
                <JournalForm
                  entityId={entityId}
                  accounts={accounts.data}
                  partners={partners.data}
                  tags={tags.data}
                  taxSettings={taxSettings.data}
                  taxCategories={taxCategories.data}
                  defaultDate={journal.date}
                  journal={journal}
                  onDirtyChange={onCorrectionDirtyChange}
                  submitLabel="訂正を保存"
                  onSubmit={(input) =>
                    new Promise<void>((resolve, reject) => setPending({ input, resolve, reject }))
                  }
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle>
                  <span className="tabular-nums">{journal.date}</span>
                </CardTitle>
                {journal.status === "active" && closedFiscalYear === undefined && (
                  <div className="flex gap-2">
                    <Button onClick={() => setEditing(true)}>訂正する</Button>
                    <Button variant="outline" onClick={() => setVoiding(true)}>
                      取り消す
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="grid gap-3">
                {journal.memo !== null && <p className="text-sm">{journal.memo}</p>}
                <JournalLines entityId={entityId} journal={journal} names={names} />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>変更履歴</CardTitle>
            </CardHeader>
            <CardContent>
              <ol aria-label="変更履歴" className="grid gap-3">
                {history.data?.map((h) => (
                  <HistoryItem key={`${h.occurredAt}-${h.action}`} entry={h} names={names} />
                ))}
              </ol>
            </CardContent>
          </Card>
        </>
      )}

      <ReasonDialog
        presets={JOURNAL_REASONS}
        open={pending !== undefined}
        title="訂正の理由"
        description="訂正の理由は変更履歴に残ります。"
        confirmLabel="訂正を確定"
        onConfirm={confirmCorrection}
        onCancel={() => {
          pending?.resolve();
          setPending(undefined);
        }}
      />
      <ReasonDialog
        presets={JOURNAL_REASONS}
        open={voiding}
        title="取消の理由"
        description="取り消した仕訳は帳簿から除かれますが、内容と理由は変更履歴に残ります。"
        confirmLabel="取消を確定"
        onConfirm={confirmVoid}
        onCancel={() => setVoiding(false)}
      />
    </div>
  );
}

/** 訂正元の仕訳と、この仕訳を訂正した訂正仕訳へのリンク（FR-019a） */
function References({ entityId, detail }: { entityId: string; detail: JournalDetail }) {
  const { correctsJournal, correctingJournals } = detail;
  if (correctsJournal === null && correctingJournals.length === 0) return null;
  return (
    <div className="grid gap-1 text-sm">
      {correctsJournal && (
        <p>
          この仕訳は{" "}
          <Link
            to="/e/$entityId/journals/$journalId"
            params={{ entityId, journalId: correctsJournal.id }}
            className={linkClass}
          >
            訂正元の仕訳 No.{correctsJournal.journalNo}
          </Link>
          （{correctsJournal.date}）の訂正仕訳です。
        </p>
      )}
      {correctingJournals.length > 0 && (
        <div className="flex flex-wrap gap-x-3">
          <span>この仕訳の訂正仕訳:</span>
          {correctingJournals.map((c) => (
            <span key={c.id}>
              <Link
                to="/e/$entityId/journals/$journalId"
                params={{ entityId, journalId: c.id }}
                className={linkClass}
              >
                訂正仕訳 No.{c.journalNo}（{c.date}）
              </Link>
              {c.status === "voided" && "（取消）"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function JournalLines({
  entityId,
  journal,
  names,
}: {
  entityId: string;
  journal: Journal;
  names: Names;
}) {
  return (
    <Table aria-label="仕訳の内容">
      <TableHeader>
        <TableRow>
          <TableHead className="w-14">貸借</TableHead>
          <TableHead>勘定科目</TableHead>
          <TableHead className="text-right">金額</TableHead>
          <TableHead>税区分</TableHead>
          <TableHead>取引先</TableHead>
          <TableHead>摘要</TableHead>
          <TableHead>タグ</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {journal.lines.map((l) => (
          <TableRow key={l.id} className="align-top">
            <TableCell>{SIDE_LABELS[l.side]}</TableCell>
            <TableCell>
              {names.accounts.get(l.accountId) ?? "（不明な科目）"}
              {l.subAccountId !== null && (
                <SubAccountName
                  entityId={entityId}
                  accountId={l.accountId}
                  subAccountId={l.subAccountId}
                />
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatYen(l.amount)}</TableCell>
            <TableCell>
              {names.taxCategories.get(l.taxCategory) ?? l.taxCategory}
              {l.taxAmount > 0 && (
                <span className="text-muted-foreground">（税 {formatYen(l.taxAmount)}）</span>
              )}
            </TableCell>
            <TableCell>{l.partnerId === null ? "" : names.partners.get(l.partnerId)}</TableCell>
            <TableCell>{l.description}</TableCell>
            <TableCell>{l.tagIds.map((t) => names.tags.get(t) ?? t).join("、")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SubAccountName({
  entityId,
  accountId,
  subAccountId,
}: {
  entityId: string;
  accountId: string;
  subAccountId: string;
}) {
  const subAccounts = useQuery(subAccountsQuery(entityId, accountId));
  const name = subAccounts.data?.find((s) => s.id === subAccountId)?.name;
  return name === undefined ? null : <span className="text-muted-foreground"> / {name}</span>;
}

type HistoryJournal = NonNullable<HistoryEntry["after"]>;

const lineText = (l: HistoryJournal["lines"][number], names: Names) =>
  [
    SIDE_LABELS[l.side],
    names.accounts.get(l.accountId) ?? "（不明な科目）",
    formatYen(l.amount),
    names.taxCategories.get(l.taxCategory) ?? l.taxCategory,
    l.partnerId === null ? undefined : names.partners.get(l.partnerId),
    l.description ?? undefined,
    l.tagIds.length > 0 ? l.tagIds.map((t) => names.tags.get(t) ?? t).join("・") : undefined,
  ]
    .filter((v) => v !== undefined)
    .join(" ");

/** 訂正の前後で変わった項目（FR-020） */
function Changes({
  before,
  after,
  names,
}: {
  before: HistoryJournal;
  after: HistoryJournal;
  names: Names;
}) {
  const beforeLines = before.lines.map((l) => lineText(l, names));
  const afterLines = after.lines.map((l) => lineText(l, names));
  const linesChanged = beforeLines.join("\n") !== afterLines.join("\n");
  return (
    <div className="grid gap-1 text-sm">
      {before.date !== after.date && (
        <p>
          日付: {before.date} → {after.date}
        </p>
      )}
      {before.memo !== after.memo && (
        <p>
          メモ: {before.memo ?? "（なし）"} → {after.memo ?? "（なし）"}
        </p>
      )}
      {linesChanged && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="font-medium">変更前</p>
            {beforeLines.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行の順は変わらない
              <p key={i}>{t}</p>
            ))}
          </div>
          <div>
            <p className="font-medium">変更後</p>
            {afterLines.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行の順は変わらない
              <p key={i}>{t}</p>
            ))}
          </div>
        </div>
      )}
      {!linesChanged && before.date === after.date && before.memo === after.memo && (
        <p className="text-muted-foreground">内容の変更はありません</p>
      )}
    </div>
  );
}

function HistoryItem({ entry, names }: { entry: HistoryEntry; names: Names }) {
  return (
    <li className="grid gap-1 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-medium">{ACTION_LABELS[entry.action]}</span>
        <time dateTime={entry.occurredAt} className="text-sm text-muted-foreground tabular-nums">
          {formatDateTime(entry.occurredAt)}
        </time>
      </div>
      {entry.reason !== null && <p className="text-sm">理由: {entry.reason}</p>}
      {entry.action === "correct" && entry.before && entry.after && (
        <Changes before={entry.before} after={entry.after} names={names} />
      )}
    </li>
  );
}
