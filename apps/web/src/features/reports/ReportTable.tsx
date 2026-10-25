import { type RowData, type TableOptions, tableFeatures, useTable } from "@tanstack/react-table";
import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatSignedYen } from "@/lib/format";
import { cn } from "@/lib/utils";

const reportFeatures = tableFeatures({});
type ReportFeatures = typeof reportFeatures;
export type ReportColumns<T extends RowData> = TableOptions<ReportFeatures, T>["columns"];

/** 帳票の金額（3 桁区切り、マイナスは ▲、右寄せ）。blankZero なら 0 は空欄にする（元帳の借方・貸方） */
export function Amount({ value, blankZero = false }: { value: number; blankZero?: boolean }) {
  return (
    <span className="block text-right tabular-nums">
      {blankZero && value === 0 ? "" : formatSignedYen(value)}
    </span>
  );
}

/** 金額の列の見出し（右寄せ） */
export const amountHeader = (label: string) => () => (
  <span className="block text-right">{label}</span>
);

/** 金額の列の定義に使う。セルの値（数値）を Amount で表示する */
export const amountCell =
  (blankZero = false) =>
  (info: { getValue: () => unknown }) => (
    <Amount value={info.getValue() as number} blankZero={blankZero} />
  );

/**
 * TanStack Table で描く帳票の表。before は本体の先頭の行（前期繰越など）、footer は合計の行
 */
export function ReportTable<T extends RowData>({
  label,
  columns,
  data,
  getRowId,
  before,
  footer,
  rowClassName,
}: {
  label: string;
  columns: ReportColumns<T>;
  data: readonly T[];
  getRowId?: (row: T, index: number) => string;
  before?: ReactNode;
  footer?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
}) {
  const table = useTable({
    features: reportFeatures,
    columns,
    data,
    ...(getRowId && { getRowId }),
  });
  return (
    <Table aria-label={label}>
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
        {before}
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id} className={cn(rowClassName?.(row.original))}>
            {row.getAllCells().map((cell) => (
              <TableCell key={cell.id}>
                <table.FlexRender cell={cell} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
      {footer && <TableFooter>{footer}</TableFooter>}
    </Table>
  );
}
