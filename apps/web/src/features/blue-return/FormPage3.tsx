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
import { formatRatioAsPercent } from "./ratio";
import "./print.css";

/** 償却の方法の表示名（方法は少額の特例だけ。R7） */
const METHOD_LABELS: Record<BlueReturn["page3"]["depreciation"][number]["method"], string> = {
  small_asset_28_2: "少額減価償却資産の特例（措置法28条の2）",
};

/**
 * 決算書の3ページ。減価償却費の計算の表（FR-023）。値は API が作った決算書のとおりに表示する
 * （計算しない）。売上先の部分は US5 で足す
 */
export function FormPage3({ depreciation }: { depreciation: BlueReturn["page3"]["depreciation"] }) {
  return (
    <section className="print-page grid gap-2" aria-label="決算書 3ページ">
      <h2 className="text-sm font-semibold">減価償却費の計算</h2>
      {depreciation.length === 0 ? (
        <p className="text-sm text-muted-foreground">減価償却資産はありません。</p>
      ) : (
        <Table aria-label="決算書 3ページ 減価償却費の計算">
          <TableHeader>
            <TableRow>
              <TableHead>減価償却資産の名称等</TableHead>
              <TableHead>面積又は数量</TableHead>
              <TableHead>取得年月</TableHead>
              <TableHead className="text-right">取得価額</TableHead>
              <TableHead className="text-right">償却の基礎になる金額</TableHead>
              <TableHead>償却方法</TableHead>
              <TableHead className="text-right">耐用年数</TableHead>
              <TableHead className="text-right">本年分の普通償却費</TableHead>
              <TableHead className="text-right">本年分の償却費合計</TableHead>
              <TableHead className="text-right">事業専用割合</TableHead>
              <TableHead className="text-right">本年分の必要経費算入額</TableHead>
              <TableHead className="text-right">未償却残高</TableHead>
              <TableHead>摘要</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {depreciation.map((d) => (
              <TableRow key={d.assetId}>
                <TableCell>{d.name}</TableCell>
                <TableCell>{d.quantity ?? ""}</TableCell>
                <TableCell>{d.acquiredOn.slice(0, 7)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatSignedYen(d.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatSignedYen(d.base)}</TableCell>
                <TableCell>{METHOD_LABELS[d.method]}</TableCell>
                <TableCell className="text-right tabular-nums">{d.usefulLifeYears ?? ""}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatSignedYen(d.ordinary)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatSignedYen(d.total)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatRatioAsPercent(d.businessRatio)}%
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatSignedYen(d.deductible)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatSignedYen(d.closingBookValue)}
                </TableCell>
                <TableCell>{d.note ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
