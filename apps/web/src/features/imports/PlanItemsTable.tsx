import {
  type ColumnFiltersState,
  columnFilteringFeature,
  createFilteredRowModel,
  filterFn_equals,
  type TableOptions,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { ImportDecision, ImportPlanItem } from "@trebuchet/schema";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { DECISION_LABELS, REASON_LABELS, WARNING_LABELS } from "./labels";

const planFeatures = tableFeatures({
  columnFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { equals: filterFn_equals },
});
type PlanColumns = TableOptions<typeof planFeatures, ImportPlanItem>["columns"];

/** 個別の指定。include は対象外を含める、exclude は新規を外す */
export type ItemSelection = { include: readonly string[]; exclude: readonly string[] };

type Toggle = { label: "含める" | "外す"; next: ItemSelection };

/** 仕訳ごとの操作。含めた仕訳は外す、前年の決算整理と個別に外した仕訳は含める、新規は外す */
function toggleOf(item: ImportPlanItem, { include, exclude }: ItemSelection): Toggle | undefined {
  const id = item.freeeJournalId;
  const without = (ids: readonly string[]) => ids.filter((x) => x !== id);
  if (include.includes(id)) return { label: "外す", next: { include: without(include), exclude } };
  if (item.reason === "USER_EXCLUDED" || exclude.includes(id))
    return { label: "含める", next: { include, exclude: without(exclude) } };
  if (item.reason === "PRIOR_YEAR_CLOSING")
    return { label: "含める", next: { include: [...include, id], exclude } };
  if (item.decision === "new")
    return { label: "外す", next: { include, exclude: [...exclude, id] } };
  return undefined;
}

const DECISION_CLASSES: Record<ImportDecision, string> = {
  new: "text-foreground",
  already: "text-muted-foreground",
  excluded: "text-muted-foreground",
  rejected: "font-semibold text-destructive",
};

const amountOf = (item: ImportPlanItem) =>
  item.draft?.lines.filter((l) => l.side === "debit").reduce((sum, l) => sum + l.amount, 0);

/** 仕訳ごとの判定（002/FR-003）。判定で絞り込み、対象外の仕訳を個別に含めたり、新規を外したりする */
export function PlanItemsTable({
  items,
  selection,
  onSelectionChange,
  disabled,
}: {
  items: readonly ImportPlanItem[];
  selection: ItemSelection;
  onSelectionChange: (selection: ItemSelection) => void;
  disabled: boolean;
}) {
  const filterId = useId();
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const columns = useMemo<PlanColumns>(
    () => [
      { id: "date", accessorKey: "date", header: "日付" },
      {
        id: "journalNo",
        header: "仕訳番号",
        accessorFn: (item) => item.freeeJournalNo ?? item.freeeJournalId,
      },
      {
        id: "decision",
        accessorKey: "decision",
        header: "判定",
        filterFn: "equals",
        cell: ({ row }) => (
          <span className={DECISION_CLASSES[row.original.decision]}>
            {DECISION_LABELS[row.original.decision]}
          </span>
        ),
      },
      {
        id: "reason",
        header: "理由",
        cell: ({ row }) => (row.original.reason ? REASON_LABELS[row.original.reason] : ""),
      },
      {
        id: "warnings",
        header: "警告",
        cell: ({ row }) =>
          row.original.warnings.length > 0 && (
            <ul className="text-amber-700">
              {row.original.warnings.map((w) => (
                <li key={w}>{WARNING_LABELS[w]}</li>
              ))}
            </ul>
          ),
      },
      {
        id: "amount",
        header: () => <span className="block text-right">金額</span>,
        cell: ({ row }) => {
          const amount = amountOf(row.original);
          return (
            <span className="block text-right tabular-nums">
              {amount === undefined ? "" : formatYen(amount)}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">操作</span>,
        cell: ({ row }) => {
          const toggle = toggleOf(row.original, selection);
          if (!toggle) return null;
          const no = row.original.freeeJournalNo ?? row.original.freeeJournalId;
          return (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onSelectionChange(toggle.next)}
            >
              {toggle.label}
              <span className="sr-only">（{no}）</span>
            </Button>
          );
        },
      },
    ],
    [selection, onSelectionChange, disabled],
  );
  const table = useTable({
    features: planFeatures,
    columns,
    data: items,
    getRowId: (item) => item.freeeJournalId,
    state: { columnFilters },
    onColumnFiltersChange: setColumnFilters,
  });
  const filter = String(columnFilters.find((f) => f.id === "decision")?.value ?? "all");

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Label htmlFor={filterId}>判定で絞り込む</Label>
        <NativeSelect
          id={filterId}
          className="h-8 w-40"
          value={filter}
          onChange={(e) => {
            const value = e.currentTarget.value;
            table.getColumn("decision")?.setFilterValue(value === "all" ? undefined : value);
          }}
        >
          <option value="all">すべて（{items.length}件）</option>
          {(Object.keys(DECISION_LABELS) as ImportDecision[]).map((d) => (
            <option key={d} value={d}>
              {DECISION_LABELS[d]}（{items.filter((i) => i.decision === d).length}件）
            </option>
          ))}
        </NativeSelect>
      </div>
      <Table aria-label="仕訳ごとの判定">
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  <table.FlexRender header={header} />
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className={cn(row.original.decision === "rejected" && "bg-destructive/5")}
            >
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
