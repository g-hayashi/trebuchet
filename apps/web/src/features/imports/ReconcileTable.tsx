import type { ReconciliationRow } from "@trebuchet/schema";
import { Fragment, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatSignedYen, formatYen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { REASON_LABELS, RECONCILIATION_CAUSE_LABELS } from "./labels";

type Figure = keyof ReconciliationRow["book"];

const FIGURES: { key: Figure; label: string; signed: boolean }[] = [
  { key: "opening", label: "期首残高", signed: true },
  { key: "debit", label: "借方合計", signed: false },
  { key: "credit", label: "貸方合計", signed: false },
  { key: "closing", label: "期末残高", signed: true },
];

const amount = (value: number, signed: boolean) =>
  signed ? formatSignedYen(value) : formatYen(value);

/** 照合の表（002/FR-021〜023）。帳簿と元帳の4つの値を並べ、不一致の行は開いて差額と原因の候補を見る */
export function ReconcileTable({ rows }: { rows: readonly ReconciliationRow[] }) {
  const id = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (accountId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(accountId)) next.add(accountId);
      return next;
    });

  return (
    <Table aria-label="照合の結果">
      <TableHeader>
        <TableRow>
          <TableHead rowSpan={2}>科目</TableHead>
          {FIGURES.map((f) => (
            <TableHead key={f.key} colSpan={2} className="text-center">
              {f.label}
            </TableHead>
          ))}
          <TableHead rowSpan={2}>結果</TableHead>
        </TableRow>
        <TableRow>
          {FIGURES.map((f) => (
            <Fragment key={f.key}>
              <TableHead className="text-right">帳簿</TableHead>
              <TableHead className="text-right">freee</TableHead>
            </Fragment>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const expanded = open.has(row.accountId);
          const detailId = `${id}-${row.accountId}`;
          return (
            <Fragment key={row.accountId}>
              <TableRow
                data-matched={row.matched}
                className={cn(!row.matched && "bg-destructive/5 hover:bg-destructive/10")}
              >
                <TableHead scope="row" className="font-normal text-foreground">
                  <span className="tabular-nums text-muted-foreground">{row.accountCode}</span>{" "}
                  <span className="font-medium">{row.accountName}</span>
                  <span className="block text-xs text-muted-foreground">
                    freee: {row.sourceNames.join("・")}
                  </span>
                </TableHead>
                {FIGURES.map((f) => (
                  <Fragment key={f.key}>
                    <TableCell className="text-right tabular-nums">
                      {amount(row.book[f.key], f.signed)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        row.difference[f.key] !== 0 && "font-medium text-destructive",
                      )}
                    >
                      {amount(row.freee[f.key], f.signed)}
                    </TableCell>
                  </Fragment>
                ))}
                <TableCell className="whitespace-nowrap">
                  {row.matched ? (
                    <span className="text-muted-foreground">一致</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-destructive">不一致</span>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`${row.accountName}の詳細を開く`}
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        onClick={() => toggle(row.accountId)}
                      >
                        {expanded ? "閉じる" : "詳細"}
                      </Button>
                    </span>
                  )}
                </TableCell>
              </TableRow>
              {!row.matched && expanded && (
                <TableRow id={detailId} className="bg-destructive/5 hover:bg-destructive/5">
                  <TableCell colSpan={FIGURES.length * 2 + 2}>
                    <MismatchDetail row={row} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function MismatchDetail({ row }: { row: ReconciliationRow }) {
  return (
    <div className="grid gap-3 py-1 text-sm">
      <div className="grid gap-1">
        <h3 className="font-medium">差額（帳簿 − freee）</h3>
        <ul aria-label={`${row.accountName}の差額`} className="flex flex-wrap gap-x-6 gap-y-1">
          {FIGURES.map((f) => (
            <li key={f.key} className="flex gap-2">
              <span className="text-muted-foreground">{f.label}</span>
              <span
                className={cn(
                  "tabular-nums",
                  row.difference[f.key] !== 0 && "font-medium text-destructive",
                )}
              >
                {formatSignedYen(row.difference[f.key])}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-1">
        <h3 className="font-medium">差の原因の候補</h3>
        {row.candidates.length === 0 ? (
          <p className="text-muted-foreground">
            候補は見つかりませんでした。対応表で、この科目に対応づけた freee
            の科目を確かめてください。
          </p>
        ) : (
          <Table aria-label={`${row.accountName}の差の原因の候補`}>
            <TableHeader>
              <TableRow>
                <TableHead>freee の仕訳番号</TableHead>
                <TableHead>日付</TableHead>
                <TableHead className="text-right">借方</TableHead>
                <TableHead className="text-right">貸方</TableHead>
                <TableHead>原因</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {row.candidates.map((c, index) => (
                <TableRow
                  // 仕訳番号のない行が重なることがあるため、順番も使う
                  // biome-ignore lint/suspicious/noArrayIndexKey: 候補は並べ替えない
                  key={`${c.freeeJournalNo ?? ""}-${c.date}-${index}`}
                >
                  <TableCell className="tabular-nums">{c.freeeJournalNo ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{c.date}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.debit > 0 ? formatYen(c.debit) : ""}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.credit > 0 ? formatYen(c.credit) : ""}
                  </TableCell>
                  <TableCell>
                    {RECONCILIATION_CAUSE_LABELS[c.cause]}
                    {c.reason && (
                      <span className="ml-2 text-muted-foreground">
                        （{REASON_LABELS[c.reason]}）
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
