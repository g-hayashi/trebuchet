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
import "./print.css";

type Page4 = BlueReturn["page4"];
type BsSide = Page4["opening"]["assets"];

const CHECK_LABELS: Record<Page4["carryForwardCheck"], string> = {
  no_prior_year: "前の年度なし",
  matched: "一致",
  mismatched: "食い違い",
};

type Mismatch = { accountName: string; expected: number; actual: number; diff: number };

/** OPENING_MISMATCH の details を、金額の形が合うものだけ取り出す（details は型のない record） */
function mismatchOf(w: BlueReturn["warnings"][number]): Mismatch | undefined {
  const d = w.details;
  if (w.code !== "OPENING_MISMATCH" || d == null) return undefined;
  const { accountName, expected, actual, diff } = d as Record<string, unknown>;
  return typeof accountName === "string" &&
    typeof expected === "number" &&
    typeof actual === "number" &&
    typeof diff === "number"
    ? { accountName, expected, actual, diff }
    : undefined;
}

const amountCell = (amount: number | null) => (amount === null ? "" : formatSignedYen(amount));

/** 期首・期末の1つの側（資産、または負債・資本）の表。行は期首と期末で同じ並び */
function BsTable({
  name,
  totalLabel,
  opening,
  closing,
}: {
  name: string;
  totalLabel: string;
  opening: BsSide;
  closing: BsSide;
}) {
  return (
    <Table aria-label={`決算書 4ページ ${name}`}>
      <TableHeader>
        <TableRow>
          <TableHead>{name}の科目</TableHead>
          <TableHead className="text-right">期首</TableHead>
          <TableHead className="text-right">期末</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {closing.rows.map((row, i) => (
          // 行の並びは期首と期末で同じ。空欄の行があるので位置を鍵にする
          // biome-ignore lint/suspicious/noArrayIndexKey: 並びが固定の表
          <TableRow key={i}>
            <TableCell>{row.label}</TableCell>
            <TableCell className="text-right tabular-nums">
              {amountCell(opening.rows[i]?.amount ?? null)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{amountCell(row.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>{totalLabel}</TableCell>
          <TableCell className="text-right tabular-nums">
            {formatSignedYen(opening.total)}
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {formatSignedYen(closing.total)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

/** 期首と前期末の差の説明の入力と保存（FR-030）。説明を保存しても差額は変わらない */
function DifferenceNoteForm({
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
    mutationFn: () => putClosingNote(entityId, year, "opening_difference", body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: blueReturnKeys.year(entityId, year) }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form noValidate onSubmit={submit} className="no-print grid gap-2 sm:max-w-xl">
      <label htmlFor="opening-difference-note" className="text-sm font-medium">
        期首と前期末の差の説明
      </label>
      <textarea
        id="opening-difference-note"
        rows={3}
        maxLength={5000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <ApiErrorMessage error={save.error} />
      <div>
        <Button type="submit" variant="outline" disabled={save.isPending}>
          説明を保存
        </Button>
      </div>
    </form>
  );
}

/**
 * 決算書の4ページ。期首・期末の貸借対照表と、元入金の繰越の検査（FR-028〜030）。
 * 値は API が作った決算書のとおりに表示する（計算しない）
 */
export function FormPage4({
  entityId,
  year,
  page4,
  warnings,
}: {
  entityId: string;
  year: string;
  page4: Page4;
  warnings: BlueReturn["warnings"];
}) {
  const mismatchWarnings = warnings.filter((w) => w.code === "OPENING_MISMATCH");
  const mismatches = mismatchWarnings.flatMap((w) => mismatchOf(w) ?? []);
  const others = mismatchWarnings.filter((w) => mismatchOf(w) === undefined);
  const check = page4.carryForwardCheck;
  return (
    <section className="print-page grid gap-3" aria-label="決算書 4ページ">
      <h2 className="text-sm font-semibold">貸借対照表</h2>
      <BsTable
        name="資産"
        totalLabel="資産合計"
        opening={page4.opening.assets}
        closing={page4.closing.assets}
      />
      <BsTable
        name="負債・資本"
        totalLabel="負債・資本合計"
        opening={page4.opening.liabilityEquity}
        closing={page4.closing.liabilityEquity}
      />
      <section aria-label="元入金の繰越の検査" className="grid gap-2 text-sm">
        <p>
          元入金の繰越の検査:{" "}
          <span
            className={check === "mismatched" ? "font-semibold text-destructive" : "font-medium"}
          >
            {CHECK_LABELS[check]}
          </span>
        </p>
        {mismatches.length > 0 && (
          <Table aria-label="繰越の食い違い">
            <TableHeader>
              <TableRow>
                <TableHead>科目</TableHead>
                <TableHead className="text-right">前の年度の期末から求めた値</TableHead>
                <TableHead className="text-right">登録された期首の値</TableHead>
                <TableHead className="text-right">差額</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mismatches.map((m) => (
                <TableRow key={m.accountName}>
                  <TableCell>{m.accountName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatSignedYen(m.expected)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatSignedYen(m.actual)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatSignedYen(m.diff)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {others.map((w) => (
          <p key={w.message} className="text-destructive">
            {w.message}
          </p>
        ))}
        {/* 出力（印刷）にも差の説明を含める。画面では入力欄に入っている */}
        {page4.openingDifferenceNote !== null && (
          <div
            role="note"
            aria-label="保存した差の説明"
            className="hidden whitespace-pre-wrap print:block"
          >
            {page4.openingDifferenceNote}
          </div>
        )}
      </section>
      {check === "mismatched" && (
        <DifferenceNoteForm entityId={entityId} year={year} saved={page4.openingDifferenceNote} />
      )}
    </section>
  );
}
