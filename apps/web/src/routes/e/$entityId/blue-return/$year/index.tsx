import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { blueReturnCsvUrl, blueReturnQuery } from "@/features/blue-return/api";
import { FormPage1 } from "@/features/blue-return/FormPage1";
import { WarningList } from "@/features/blue-return/WarningList";
import { formatSignedYen } from "@/lib/format";

export const Route = createFileRoute("/e/$entityId/blue-return/$year/")({
  component: BlueReturnPage,
});

/** 第一表に転記する値の1項目。回答がなく金額が null のときは「要件の回答が必要」 */
function TransferValue({ label, amount }: { label: string; amount: number | null }) {
  return (
    <div className="grid gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">
        {amount === null ? (
          <span className="text-base font-medium text-destructive">要件の回答が必要</span>
        ) : (
          formatSignedYen(amount)
        )}
      </dd>
    </div>
  );
}

/** 青色申告決算書（一般用）。1ページ（損益計算書）と、第一表に転記する値（FR-001〜004, FR-008） */
function BlueReturnPage() {
  const { entityId, year } = Route.useParams();
  const { data, error } = useQuery(blueReturnQuery(entityId, year));
  // 使わない欄を空欄で表示する切り替え。保存しない（FR-008）
  const [blankUnused, setBlankUnused] = useState(false);

  return (
    <main className="blue-return-print grid gap-4">
      <div className="no-print">
        <Link to="/e/$entityId/blue-return" params={{ entityId }} className="text-sm underline">
          年度の一覧
        </Link>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">青色申告決算書 {year}年分</h1>
        {data && (
          <div className="no-print flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => window.print()}>
              印刷
            </Button>
            <a
              href={blueReturnCsvUrl(entityId, year, blankUnused)}
              download
              className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium shadow-xs hover:bg-muted"
            >
              CSV をダウンロード
            </a>
          </div>
        )}
      </div>
      <ApiErrorMessage error={error} />
      {data && (
        <>
          <p className="flex flex-wrap items-center gap-3 text-sm">
            <span
              className={
                data.status === "open"
                  ? "rounded-md border border-amber-500/60 bg-amber-50 px-2 py-0.5 text-amber-900"
                  : "rounded-md border px-2 py-0.5"
              }
            >
              {data.status === "open" ? "締め前（暫定）" : "締め済み"}
            </span>
            <span className="text-muted-foreground">{data.formYear}年分の様式</span>
          </p>
          <section
            aria-label="第一表に転記する値"
            className="rounded-lg border-2 border-foreground p-4"
          >
            <h2 className="mb-3 text-sm font-semibold">
              確定申告書 第一表（事業所得）に転記する値
            </h2>
            <dl className="grid gap-4 sm:grid-cols-2">
              <TransferValue label="所得金額（欄45）" amount={data.transfer.businessIncome} />
              <TransferValue
                label="青色申告特別控除額（欄44）"
                amount={data.transfer.blueDeduction}
              />
            </dl>
            {(data.transfer.businessIncome === null || data.transfer.blueDeduction === null) && (
              <Link
                to="/e/$entityId/blue-return/$year/deduction"
                params={{ entityId, year }}
                className="no-print mt-3 inline-block text-sm underline"
              >
                要件を回答する
              </Link>
            )}
          </section>
          <p className="no-print text-sm">
            <Link
              to="/e/$entityId/blue-return/$year/home-use"
              params={{ entityId, year }}
              className="underline"
            >
              家事按分・地代家賃の内訳
            </Link>
          </p>
          <WarningList entityId={entityId} year={year} warnings={data.warnings} />
          <label className="no-print flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={blankUnused}
              onChange={(e) => setBlankUnused(e.target.checked)}
            />
            使わない欄を空欄で表示
          </label>
          <FormPage1 lines={data.page1.lines} blankUnused={blankUnused} />
        </>
      )}
    </main>
  );
}
