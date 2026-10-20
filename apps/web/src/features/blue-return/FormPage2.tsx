import type { BlueReturn } from "@trebuchet/schema";
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
import "./print.css";

type Page2 = BlueReturn["page2"];

/** 控除の区分の表示名（区分と上限額は API が決める。画面は結果を表示する） */
const TIER_LABELS: Record<NonNullable<Page2["deduction"]>["tier"], string> = {
  max: "最大",
  standard: "標準",
  basic: "基本",
};

/**
 * 決算書の2ページ。月別の売上・雑収入、地代家賃の内訳、青色申告特別控除の計算（FR-017、FR-024、FR-010）。
 * 値は API が作った決算書のとおりに表示する（計算しない）。地代家賃の内訳の編集は家事按分の画面で行う
 */
export function FormPage2({ page2 }: { page2: Page2 }) {
  const { monthly, rentDetails, deduction } = page2;
  return (
    <section className="print-page grid gap-3" aria-label="決算書 2ページ">
      <h2 className="text-sm font-semibold">月別売上（収入）金額</h2>
      <Table aria-label="決算書 2ページ 月別売上">
        <TableHeader>
          <TableRow>
            <TableHead>月</TableHead>
            <TableHead className="text-right">売上（収入）金額</TableHead>
            <TableHead className="text-right">雑収入</TableHead>
            <TableHead className="text-right">計</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {monthly.months.map((m) => (
            <TableRow key={m.month}>
              <TableCell>{m.month}月</TableCell>
              <TableCell className="text-right tabular-nums">{formatSignedYen(m.sales)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatSignedYen(m.otherIncome)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatSignedYen(m.total)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>合計</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatSignedYen(monthly.total.sales)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatSignedYen(monthly.total.otherIncome)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatSignedYen(monthly.total.total)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>

      <h2 className="text-sm font-semibold">地代家賃の内訳</h2>
      {rentDetails.length === 0 ? (
        <p className="text-sm text-muted-foreground">地代家賃の内訳はありません。</p>
      ) : (
        <Table aria-label="決算書 2ページ 地代家賃の内訳">
          <TableHeader>
            <TableRow>
              <TableHead>支払先</TableHead>
              <TableHead>貸借物件</TableHead>
              <TableHead className="text-right">本年中の賃借料</TableHead>
              <TableHead className="text-right">必要経費算入額</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rentDetails.map((r, i) => (
              // 同じ支払先・物件の行があり得るので位置を鍵にする（並びは API が決める）
              // biome-ignore lint/suspicious/noArrayIndexKey: 並びが固定の表
              <TableRow key={i}>
                <TableCell>{r.payee}</TableCell>
                <TableCell>{r.property}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatSignedYen(r.annualRent)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatSignedYen(r.deductibleAmount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <section aria-label="青色申告特別控除の計算" className="grid gap-2 text-sm">
        <h2 className="text-sm font-semibold">青色申告特別控除の計算</h2>
        {deduction === null ? (
          <p className="font-medium text-destructive">要件の回答が必要</p>
        ) : (
          <>
            <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">区分</dt>
              <dd className="text-right">{TIER_LABELS[deduction.tier]}</dd>
              <dt className="text-muted-foreground">上限額（円）</dt>
              <dd className="text-right tabular-nums">{formatSignedYen(deduction.cap)}</dd>
              <dt className="font-medium">控除額（円）</dt>
              <dd className="text-right font-medium tabular-nums">
                {formatSignedYen(deduction.amount)}
              </dd>
            </dl>
            {deduction.unmet.length > 0 && (
              <div>
                <p className="text-muted-foreground">満たしていない要件</p>
                <ul aria-label="満たさない要件" className="list-disc pl-5">
                  {deduction.unmet.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>
    </section>
  );
}
