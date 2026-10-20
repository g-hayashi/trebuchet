import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BlueReturn } from "@trebuchet/schema";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
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
import { blueReturnKeys, putClosingNote } from "./api";
import { formatRatioAsPercent } from "./ratio";
import "./print.css";

type Page3 = BlueReturn["page3"];

/** 償却の方法の表示名（方法は少額の特例だけ。R7） */
const METHOD_LABELS: Record<Page3["depreciation"][number]["method"], string> = {
  small_asset_28_2: "少額減価償却資産の特例（措置法28条の2）",
};

/**
 * 売上先の明細（FR-025〜026）。個別の行、上記以外の売上先の計（雑収入・取引先なしを含む）、合計。
 * 取引先が付いていない売上があるときは、件数と金額を知らせる。値は API のとおりに表示する（計算しない）
 */
function SalesPartnersTable({ salesPartners }: { salesPartners: Page3["salesPartners"] }) {
  const { rows, others, total, withoutPartner } = salesPartners;
  return (
    <>
      <h2 className="text-sm font-semibold">売上（収入）金額の明細（主な売上先）</h2>
      <Table aria-label="決算書 3ページ 売上先">
        <TableHeader>
          <TableRow>
            <TableHead>売上先の名称</TableHead>
            <TableHead className="text-right">売上（収入）金額</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.partnerId ?? r.name}>
              <TableCell>{r.name}</TableCell>
              <TableCell className="text-right tabular-nums">{formatSignedYen(r.amount)}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell>上記以外の売上先の計</TableCell>
            <TableCell className="text-right tabular-nums">{formatSignedYen(others)}</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>合計</TableCell>
            <TableCell className="text-right tabular-nums">{formatSignedYen(total)}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
      {withoutPartner !== null && (
        <p className="text-sm text-amber-900 dark:text-amber-100">
          取引先が付いていない売上: {withoutPartner.count} 件、
          {formatSignedYen(withoutPartner.amount)} 円
        </p>
      )}
    </>
  );
}

/** 本年中における特殊事情のメモの入力と保存（FR-027） */
function SpecialCircumstancesForm({
  entityId,
  year,
  saved,
}: {
  entityId: string;
  year: string;
  saved: string | null;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState(saved ?? "");
  const save = useMutation({
    mutationFn: () => putClosingNote(entityId, year, "special_circumstances", body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: blueReturnKeys.year(entityId, year) }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <>
      <form noValidate onSubmit={submit} className="no-print grid gap-2 sm:max-w-xl">
        <label htmlFor="special-circumstances-note" className="text-sm font-medium">
          本年中における特殊事情
        </label>
        <textarea
          id="special-circumstances-note"
          rows={3}
          maxLength={5000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <ApiErrorMessage error={save.error} />
        <div>
          <Button type="submit" variant="outline" disabled={save.isPending}>
            特殊事情を保存
          </Button>
        </div>
      </form>
      {/* 出力（印刷）にも含める。画面では入力欄に入っている */}
      {saved !== null && (
        <div
          role="note"
          aria-label="保存した特殊事情"
          className="hidden whitespace-pre-wrap print:block"
        >
          {saved}
        </div>
      )}
    </>
  );
}

/**
 * 決算書の3ページ。売上先の明細（FR-025〜026）、減価償却費の計算の表（FR-023）、本年中における
 * 特殊事情のメモ（FR-027）。値は API が作った決算書のとおりに表示する（計算しない）
 */
export function FormPage3({
  entityId,
  year,
  page3,
}: {
  entityId: string;
  year: string;
  page3: Page3;
}) {
  const { depreciation } = page3;
  return (
    <section className="print-page grid gap-2" aria-label="決算書 3ページ">
      <SalesPartnersTable salesPartners={page3.salesPartners} />
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
      <SpecialCircumstancesForm
        entityId={entityId}
        year={year}
        saved={page3.specialCircumstances}
      />
    </section>
  );
}
