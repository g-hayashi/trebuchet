import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ImportPreview } from "@trebuchet/schema";
import { useId } from "react";
import { fiscalPeriodsQuery } from "@/features/periods/api";
import { DECISION_LABELS } from "./labels";

type Year = ImportPreview["years"][number];

/** 取り込む年度の選択（002/FR-004a）。会計期間のない年度は選べない */
export function YearSelector({
  entityId,
  years,
  selected,
  onChange,
}: {
  entityId: string;
  years: readonly Year[];
  selected: readonly number[];
  onChange: (fiscalYears: number[]) => void;
}) {
  const id = useId();
  const missing = years.some((y) => !y.hasPeriod);
  const { data: periods } = useQuery({ ...fiscalPeriodsQuery(entityId), enabled: missing });
  const periodYears = periods?.map((p) => p.fiscalYear) ?? [];
  const firstYear = periodYears.length > 0 ? Math.min(...periodYears) : undefined;

  const toggle = (fiscalYear: number, checked: boolean) =>
    onChange(
      checked
        ? [...selected, fiscalYear].sort((a, b) => a - b)
        : selected.filter((y) => y !== fiscalYear),
    );

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm text-muted-foreground">
        ファイルに含まれる年度です。チェックを外した年度の仕訳は取り込みません。
      </legend>
      <ul className="grid gap-2">
        {years.map((y) => {
          const inputId = `${id}-${y.fiscalYear}`;
          const counts = (["new", "already", "excluded", "rejected"] as const)
            .map((d) => `${DECISION_LABELS[d]} ${y.counts[d]}件`)
            .join("・");
          return (
            <li key={y.fiscalYear} className="grid gap-0.5 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <input
                  id={inputId}
                  type="checkbox"
                  className="size-4"
                  disabled={!y.hasPeriod}
                  checked={y.hasPeriod && selected.includes(y.fiscalYear)}
                  onChange={(e) => toggle(y.fiscalYear, e.currentTarget.checked)}
                />
                <label htmlFor={inputId} className="font-medium">
                  {y.fiscalYear}年
                </label>
                <span className="text-muted-foreground tabular-nums">{counts}</span>
                {y.closed && <span className="text-destructive">締め済み（取り込めません）</span>}
              </div>
              {!y.hasPeriod && (
                <p className="pl-7 text-destructive">
                  {firstYear === undefined ? (
                    "会計期間がないため取り込めません。"
                  ) : y.fiscalYear < firstYear ? (
                    "事業体の開始年度より前のため取り込めません。"
                  ) : (
                    <>
                      会計期間がないため取り込めません。
                      <Link
                        to="/e/$entityId/periods"
                        params={{ entityId }}
                        className="underline underline-offset-2"
                      >
                        会計期間
                      </Link>
                      の画面で翌年度を作成してください。
                    </>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
