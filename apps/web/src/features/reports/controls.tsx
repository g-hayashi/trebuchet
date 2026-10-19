import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FiscalPeriod } from "@/lib/queries";
import type { DateRange } from "./periods";

type PeriodPickerProps = {
  periods: readonly FiscalPeriod[];
  range: DateRange;
  onChange: (range: DateRange) => void;
};

/** 期間の選択。会計期間を選ぶとすぐに、開始日・終了日は「表示」で反映する */
export function PeriodPicker(props: PeriodPickerProps) {
  // URL の期間が変わったら入力欄を作り直す
  return <PeriodForm key={`${props.range.from}_${props.range.to}`} {...props} />;
}

function PeriodForm({ periods, range, onChange }: PeriodPickerProps) {
  const id = useId();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const selected = periods.find((p) => p.startDate === range.from && p.endDate === range.to);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (from !== "" && to !== "") onChange({ from, to });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <FiscalPeriodSelect
        id={`${id}-period`}
        periods={periods}
        value={selected?.fiscalYear}
        onSelect={(p) => onChange({ from: p.startDate, to: p.endDate })}
      />
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-from`}>開始日</Label>
        <Input
          id={`${id}-from`}
          type="date"
          required
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-to`}>終了日</Label>
        <Input
          id={`${id}-to`}
          type="date"
          required
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <Button type="submit" variant="outline">
        表示
      </Button>
    </form>
  );
}

type AsOfPickerProps = {
  periods: readonly FiscalPeriod[];
  asOf: string;
  onChange: (asOf: string) => void;
};

/** 基準日の選択（貸借対照表）。会計期間を選ぶと、その終了日にする */
export function AsOfPicker(props: AsOfPickerProps) {
  return <AsOfForm key={props.asOf} {...props} />;
}

function AsOfForm({ periods, asOf, onChange }: AsOfPickerProps) {
  const id = useId();
  const [value, setValue] = useState(asOf);
  const selected = periods.find((p) => p.endDate === asOf);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value !== "") onChange(value);
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <FiscalPeriodSelect
        id={`${id}-period`}
        periods={periods}
        value={selected?.fiscalYear}
        onSelect={(p) => onChange(p.endDate)}
      />
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-as-of`}>基準日</Label>
        <Input
          id={`${id}-as-of`}
          type="date"
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <Button type="submit" variant="outline">
        表示
      </Button>
    </form>
  );
}

function FiscalPeriodSelect({
  id,
  periods,
  value,
  onSelect,
}: {
  id: string;
  periods: readonly FiscalPeriod[];
  value: number | undefined;
  onSelect: (period: FiscalPeriod) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>会計期間</Label>
      <NativeSelect
        id={id}
        className="w-36"
        value={value === undefined ? "" : String(value)}
        onChange={(e) => {
          const period = periods.find((p) => String(p.fiscalYear) === e.target.value);
          if (period) onSelect(period);
        }}
      >
        <option value="">日付で指定</option>
        {periods.map((p) => (
          <option key={p.id} value={String(p.fiscalYear)}>
            {p.fiscalYear}年度
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/** 前年比較の切替（FR-030） */
export function CompareToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      前年と比較
    </label>
  );
}

export type ReportKind =
  | "journal-book"
  | "general-ledger"
  | "trial-balance"
  | "profit-and-loss"
  | "balance-sheet";

/** 表示中と同じ条件の CSV のダウンロード（FR-032）。params のキーの順にクエリ文字列にする */
export function CsvLink({
  entityId,
  kind,
  params,
}: {
  entityId: string;
  kind: ReportKind;
  params: Record<string, string | undefined>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  query.set("format", "csv");
  return (
    <a
      href={`/api/entities/${entityId}/reports/${kind}?${query}`}
      download
      className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium shadow-xs hover:bg-muted"
    >
      CSV をダウンロード
    </a>
  );
}
