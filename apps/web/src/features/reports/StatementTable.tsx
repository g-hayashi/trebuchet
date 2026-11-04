import type { Figure } from "@trebuchet/schema";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { AccountLink } from "./AccountLink";
import { Amount } from "./ReportTable";

/** 決算書の行。heading は区分の見出し、total は区分の計、grand は合計・差引金額。accountId があれば科目名を元帳へのリンクにする */
export type StatementLine =
  | { kind: "heading"; key: string; name: string }
  | {
      kind: "row" | "total" | "grand";
      key: string;
      name: string;
      figure: Figure;
      accountId?: string | undefined;
    };

/** 科目名のリンクの行き先（FR-039）。同じ期間の総勘定元帳 */
export type LedgerTarget = { entityId: string; from: string; to: string };

/** 損益計算書・貸借対照表の表。compare なら前年・増減の列を出す（FR-030） */
export function StatementTable({
  label,
  compare,
  lines,
  ledger,
}: {
  label: string;
  compare: boolean;
  lines: readonly StatementLine[];
  ledger?: LedgerTarget | undefined;
}) {
  const columns = compare ? 4 : 2;
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead>勘定科目</TableHead>
          <TableHead className="text-right">金額</TableHead>
          {compare && <TableHead className="text-right">前年</TableHead>}
          {compare && <TableHead className="text-right">増減</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((line) =>
          line.kind === "heading" ? (
            <TableRow key={line.key} className="bg-muted/30">
              <TableCell colSpan={columns} className="font-medium">
                {line.name}
              </TableCell>
            </TableRow>
          ) : (
            <TableRow
              key={line.key}
              className={cn(
                line.kind === "total" && "font-medium",
                line.kind === "grand" && "border-t-2 font-semibold",
              )}
            >
              <TableCell className={cn(line.kind === "row" && "pl-6")}>
                {ledger && line.accountId !== undefined ? (
                  <AccountLink
                    entityId={ledger.entityId}
                    accountId={line.accountId}
                    name={line.name}
                    from={ledger.from}
                    to={ledger.to}
                  />
                ) : (
                  line.name
                )}
              </TableCell>
              <TableCell>
                <Amount value={line.figure.amount} />
              </TableCell>
              {compare && (
                <TableCell>
                  <Amount value={line.figure.previous ?? 0} />
                </TableCell>
              )}
              {compare && (
                <TableCell>
                  <Amount value={line.figure.change ?? 0} />
                </TableCell>
              )}
            </TableRow>
          ),
        )}
      </TableBody>
    </Table>
  );
}
