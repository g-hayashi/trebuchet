import { Link } from "@tanstack/react-router";
import type { ImportPlanItem, ImportWarning } from "@trebuchet/schema";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatYen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WARNING_LABELS } from "./labels";

/** 参照の snapshot_json（packages/domain の canonicalSnapshot）の形 */
type SnapshotLine = {
  side: "debit" | "credit";
  account: string;
  subAccount: string | null;
  amount: number;
  tax: string;
  taxAmount: number | null;
  partner: string | null;
  tags: string[];
  description: string | null;
};
type Snapshot = { date: string; memo: string | null; lines: SnapshotLine[] };

const SIDE_LABELS = { debit: "借方", credit: "貸方" } as const;

/** 正準 JSON（文字列、または解析済みのオブジェクト）を読む。形が違えば undefined */
function parseSnapshot(value: unknown): Snapshot | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { date, lines } = parsed as { date?: unknown; lines?: unknown };
  if (typeof date !== "string" || !Array.isArray(lines)) return undefined;
  return parsed as Snapshot;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

type Entry = {
  warning: ImportWarning;
  label: string;
  journalId: string | undefined;
  journalNo: number | undefined;
  before: Snapshot | undefined;
  after: Snapshot | undefined;
};

/** freee 側の変更・削除（FR-029, FR-030）。帳簿の仕訳は変えず、比べた内容と帳簿の仕訳へのリンクを示す */
export function FreeeChangesPanel({
  entityId,
  warnings,
  items,
}: {
  entityId: string;
  warnings: readonly ImportWarning[];
  items: readonly ImportPlanItem[];
}) {
  const entryOf = (warning: ImportWarning): Entry => {
    const d = warning.details;
    const id = warning.freeeJournalId;
    const freeeNo =
      str(d?.freeeJournalNo) ?? items.find((i) => i.freeeJournalId === id)?.freeeJournalNo;
    return {
      warning,
      label: freeeNo ?? id ?? "—",
      journalId: str(d?.journalId),
      journalNo: num(d?.journalNo),
      before: parseSnapshot(d?.before),
      after: parseSnapshot(d?.after),
    };
  };
  const changed = warnings.filter((w) => w.code === "FREEE_CHANGED").map(entryOf);
  const deleted = warnings.filter((w) => w.code === "FREEE_DELETED").map(entryOf);
  if (changed.length === 0 && deleted.length === 0) return null;

  return (
    <Card>
      <section aria-label="freee 側の変更・削除" className="grid gap-6">
        <CardHeader>
          <CardTitle>freee 側の変更・削除</CardTitle>
          <CardDescription>
            前回の取込の後に freee
            側で変わった仕訳です。帳簿の仕訳は変わりません。必要なら、帳簿の仕訳を開いて自分で訂正・取消してください。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {changed.length > 0 && (
            <EntryList entityId={entityId} title={WARNING_LABELS.FREEE_CHANGED} entries={changed}>
              {(e) => (
                <div className="grid gap-3 lg:grid-cols-2">
                  <SnapshotTable name={`${e.label} の変更前`} title="変更前" snapshot={e.before} />
                  <SnapshotTable
                    name={`${e.label} の変更後`}
                    title="変更後"
                    snapshot={e.after}
                    compareWith={e.before}
                  />
                </div>
              )}
            </EntryList>
          )}
          {deleted.length > 0 && (
            <EntryList entityId={entityId} title={WARNING_LABELS.FREEE_DELETED} entries={deleted}>
              {(e) => (
                <SnapshotTable
                  name={`${e.label} の取込のときの内容`}
                  title="取込のときの内容"
                  snapshot={e.before}
                />
              )}
            </EntryList>
          )}
        </CardContent>
      </section>
    </Card>
  );
}

function EntryList({
  entityId,
  title,
  entries,
  children,
}: {
  entityId: string;
  title: string;
  entries: Entry[];
  children: (entry: Entry) => ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-medium">
        {title}（{entries.length}件）
      </h3>
      <ul aria-label={title} className="grid gap-3">
        {entries.map((e, index) => (
          <li
            // 同じ仕訳に同じコードの警告が重なることがあるため、順番も使う
            // biome-ignore lint/suspicious/noArrayIndexKey: 警告は並べ替えない
            key={`${e.warning.freeeJournalId ?? ""}-${index}`}
            className="grid gap-2 rounded-md border border-amber-500/50 px-3 py-2 text-sm"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium">freee の仕訳 {e.label}</span>
              {(e.before ?? e.after) && (
                <span className="tabular-nums text-muted-foreground">
                  {(e.after ?? e.before)?.date}
                </span>
              )}
              <span>{e.warning.message}</span>
              {e.journalId && (
                <Link
                  to="/e/$entityId/journals/$journalId"
                  params={{ entityId, journalId: e.journalId }}
                  className="underline underline-offset-2"
                >
                  {e.journalNo === undefined ? "帳簿の仕訳" : `帳簿の仕訳 No.${e.journalNo}`}
                </Link>
              )}
            </div>
            {children(e)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SnapshotTable({
  name,
  title,
  snapshot,
  compareWith,
}: {
  name: string;
  title: string;
  snapshot: Snapshot | undefined;
  compareWith?: Snapshot | undefined;
}) {
  if (!snapshot) {
    return <p className="text-muted-foreground">{title}: 内容を表示できません。</p>;
  }
  const differs = (line: SnapshotLine, index: number) =>
    compareWith !== undefined && JSON.stringify(compareWith.lines[index]) !== JSON.stringify(line);
  return (
    <Table aria-label={name}>
      <caption className="pb-1 text-left text-xs text-muted-foreground">
        {title}: <span className="tabular-nums">{snapshot.date}</span>
        {snapshot.memo && `・${snapshot.memo}`}
      </caption>
      <TableHeader>
        <TableRow>
          <TableHead>貸借</TableHead>
          <TableHead>科目</TableHead>
          <TableHead className="text-right">金額</TableHead>
          <TableHead>税区分</TableHead>
          <TableHead>取引先</TableHead>
          <TableHead>摘要</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {snapshot.lines.map((line, index) => (
          <TableRow
            // 行の順は freee の仕訳行の順で固定
            // biome-ignore lint/suspicious/noArrayIndexKey: 行は並べ替えない
            key={index}
            className={cn(differs(line, index) && "bg-amber-500/10 font-medium")}
          >
            <TableCell>{SIDE_LABELS[line.side] ?? line.side}</TableCell>
            <TableCell>
              {line.account}
              {line.subAccount && ` ／ ${line.subAccount}`}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatYen(line.amount)}</TableCell>
            <TableCell>{line.tax}</TableCell>
            <TableCell>{line.partner ?? ""}</TableCell>
            <TableCell>
              {line.description ?? ""}
              {line.tags.length > 0 && (
                <span className="ml-1 text-muted-foreground">
                  {line.tags.map((t) => `#${t}`).join(" ")}
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
