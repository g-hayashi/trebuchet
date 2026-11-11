import { Link } from "@tanstack/react-router";
import type { JournalBookOrder, JournalBookSort } from "@trebuchet/schema";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FiscalPeriod } from "@/features/periods/api";
import { presetRange, RANGE_PRESETS } from "@/lib/dates";
import { type ReportKind, reportCsvUrl } from "./api";
import type { DateRange } from "./periods";

type PeriodPickerProps = {
  periods: readonly FiscalPeriod[];
  range: DateRange;
  onChange: (range: DateRange) => void;
  /**
   * 期間が 1 つの会計期間の中に収まる必要があるか（既定 true。試算表・元帳・損益計算書）。
   * true のとき、収まらないプリセットは押せない（API が OUT_OF_PERIOD・VALIDATION を返す）。仕訳帳は false
   */
  withinPeriod?: boolean | undefined;
};

const NO_PERIOD_REASON = "この期間を含む会計期間がありません";

/** from〜to が 1 つの会計期間の中に収まるか（server の resolvePeriod と同じ条件） */
const fitsInPeriod = (periods: readonly FiscalPeriod[], from: string, to: string) =>
  periods.some((p) => p.startDate <= from && to <= p.endDate);

/** 期間の選択。会計期間を選ぶとすぐに、開始日・終了日は「表示」で反映する */
export function PeriodPicker(props: PeriodPickerProps) {
  // URL の期間が変わったら入力欄を作り直す
  return <PeriodForm key={`${props.range.from}_${props.range.to}`} {...props} />;
}

function PeriodForm({ periods, range, onChange, withinPeriod = true }: PeriodPickerProps) {
  const id = useId();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const selected = periods.find((p) => p.startDate === range.from && p.endDate === range.to);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (from !== "" && to !== "") onChange({ from, to });
  };

  return (
    <div className="grid gap-2">
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
      <fieldset className="flex min-w-0 flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">期間のプリセット</legend>
        <span id={`${id}-preset-reason`} hidden>
          {NO_PERIOD_REASON}
        </span>
        {RANGE_PRESETS.map((preset) => {
          const target = presetRange(preset.id);
          const blocked = withinPeriod && !fitsInPeriod(periods, target.from, target.to);
          return (
            <Button
              key={preset.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={blocked}
              title={blocked ? NO_PERIOD_REASON : undefined}
              aria-describedby={blocked ? `${id}-preset-reason` : undefined}
              onClick={() => onChange(target)}
            >
              {preset.label}
            </Button>
          );
        })}
      </fieldset>
    </div>
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

/** 前年の値が 0 である理由と、前年の仕訳を取り込む入口への案内（FR-041）。比較の欄の近くに置く */
export function PreviousYearNotice({ entityId, reason }: { entityId: string; reason: string }) {
  return (
    <div
      role="note"
      aria-label="前年の案内"
      className="max-w-xl rounded-md border bg-muted/30 p-3 text-sm"
    >
      <p>{reason}前年の列はすべて 0 です。freee から前年の仕訳帳と元帳を取り込むと比べられます。</p>
      <Link
        to="/e/$entityId/periods"
        params={{ entityId }}
        activeOptions={{ exact: true }}
        className="underline"
      >
        会計期間と移行
      </Link>
    </div>
  );
}

const SORT_LABELS: Record<JournalBookSort, string> = { date: "取引日", created: "登録日" };
const ORDER_LABELS: Record<JournalBookOrder, string> = { asc: "昇順", desc: "降順" };

/** 仕訳帳の並べ替え（FR-038）: 取引日・登録日 × 昇順・降順 */
export function JournalBookSortControls({
  sort,
  order,
  onChange,
}: {
  sort: JournalBookSort;
  order: JournalBookOrder;
  onChange: (next: { sort: JournalBookSort; order: JournalBookOrder }) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-sort`}>並び</Label>
        <NativeSelect
          id={`${id}-sort`}
          className="w-32"
          value={sort}
          onChange={(e) => onChange({ sort: e.target.value as JournalBookSort, order })}
        >
          {Object.entries(SORT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-order`}>順序</Label>
        <NativeSelect
          id={`${id}-order`}
          className="w-28"
          value={order}
          onChange={(e) => onChange({ sort, order: e.target.value as JournalBookOrder })}
        >
          {Object.entries(ORDER_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}

/** 表示中と同じ条件の CSV のダウンロード（FR-032） */
export function CsvLink({
  entityId,
  kind,
  params,
}: {
  entityId: string;
  kind: ReportKind;
  params: Record<string, string | undefined>;
}) {
  return (
    <a
      href={reportCsvUrl(entityId, kind, params)}
      download
      className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium shadow-xs hover:bg-muted"
    >
      CSV をダウンロード
    </a>
  );
}
