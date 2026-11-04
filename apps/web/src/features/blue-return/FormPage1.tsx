import type { BlueReturn } from "@trebuchet/schema";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatSignedYen } from "@/lib/format";
import { cn } from "@/lib/utils";
import "./print.css";

/** 決算書の1ページ（損益計算書）。使わない欄の金額は常に空欄にする（FR-045） */
export function FormPage1({ lines }: { lines: BlueReturn["page1"]["lines"] }) {
  return (
    <section className="print-page" aria-label="決算書 1ページ（損益計算書）">
      <Table aria-label="決算書 1ページ">
        <TableHeader>
          <TableRow>
            <TableHead className="w-16 text-right">欄</TableHead>
            <TableHead>項目</TableHead>
            <TableHead className="text-right">金額</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => (
            <TableRow key={line.no} className={cn(line.no >= 43 && "font-medium")}>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {line.no}
              </TableCell>
              <TableCell>{line.label}</TableCell>
              <TableCell className="text-right tabular-nums">
                {line.kind === "unused"
                  ? ""
                  : line.amount === null
                    ? "未回答"
                    : formatSignedYen(line.amount)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
