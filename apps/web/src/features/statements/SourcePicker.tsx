import type { StatementSource } from "@trebuchet/schema";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// 取込元（列の対応の保存）の選択・表示（007 US2。H:§2.1・§3）

/**
 * 当てはまった取込元の表示（1 件が当てはまったとき、または 2 件以上から選んだとき）。
 * 列の画面は飛ばしてあり、「列の対応を直す」で列の画面に戻る。年のない日付（`needsYear`）のときは対象の年を直せる
 */
export function AppliedSource({
  source,
  needsYear,
  year,
  pending,
  onYearChange,
  onEditColumns,
}: {
  source: StatementSource;
  needsYear: boolean;
  year: number;
  pending: boolean;
  onYearChange: (year: number) => void;
  onEditColumns: () => void;
}) {
  const id = useId();
  // 入力の途中（空・桁の不足）の値も持てるよう、文字列で持つ。正しい年になったときだけ作り直す
  const [yearText, setYearText] = useState(String(year));
  return (
    <div className="grid gap-3">
      <p>
        <span className="text-sm text-muted-foreground">取込元: </span>
        <span className="font-medium">{source.name}</span>
      </p>
      <p className="text-sm text-muted-foreground">
        保存した列の対応を当てはめました。内容がちがうときは、列の対応を直せます。
      </p>
      <div className="flex flex-wrap items-end gap-4">
        {needsYear && (
          <div className="grid gap-1">
            <Label htmlFor={`${id}-year`}>対象の年</Label>
            <Input
              id={`${id}-year`}
              type="number"
              inputMode="numeric"
              className="w-28"
              value={yearText}
              onChange={(e) => {
                setYearText(e.target.value);
                const next = Number(e.target.value);
                if (Number.isInteger(next) && next >= 1900 && next <= 9999) onYearChange(next);
              }}
            />
          </div>
        )}
        <Button type="button" variant="outline" disabled={pending} onClick={onEditColumns}>
          列の対応を直す
        </Button>
      </div>
    </div>
  );
}

/** 見出しが同じ取込元が 2 件以上あるとき、どれを使うかを選ばせる（列は選ばせない） */
export function SourceChooser({
  sources,
  pending,
  onChoose,
  onSkip,
}: {
  sources: StatementSource[];
  pending: boolean;
  onChoose: (source: StatementSource) => void;
  onSkip: () => void;
}) {
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        見出しが同じ取込元が {sources.length} 件あります。使う取込元を選んでください。
      </p>
      <ul className="grid gap-2">
        {sources.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3">
            <span>{s.name}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              aria-label={`「${s.name}」を使う`}
              onClick={() => onChoose(s)}
            >
              使う
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button type="button" variant="outline" disabled={pending} onClick={onSkip}>
          どれも使わず列を選ぶ
        </Button>
      </div>
    </div>
  );
}

/** 列の画面で、既存の取込元を選ぶ（選ぶと、その取込元の署名で判定をやり直す）。選んだ取込元がなければ空 */
export function SourceSelect({
  sources,
  value,
  disabled,
  onChange,
}: {
  sources: StatementSource[];
  value: string | undefined;
  disabled: boolean;
  onChange: (id: string | undefined) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>既存の取込元を選ぶ</Label>
      <NativeSelect
        id={id}
        className="w-64"
        disabled={disabled}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      >
        <option value="">選ばない</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">
        保存した列の対応を、この表に当てはめます。見出しがちがえば、ちがいを示します。
      </p>
    </div>
  );
}

/** 選んだ取込元の見出しと、今回の表の見出しのちがい（足された列・なくなった列） */
export function HeaderDiff({ added, removed }: { added: string[]; removed: string[] }) {
  return (
    <div className="grid gap-1 rounded-md border border-amber-500/50 px-3 py-2 text-sm">
      <p className="font-medium">
        見出しが保存した取込元とちがいます。列の対応を確かめてください。
      </p>
      <ul aria-label="見出しの違い" className="list-disc pl-5">
        {added.length > 0 && <li>足された列: {added.join("、")}</li>}
        {removed.length > 0 && <li>なくなった列: {removed.join("、")}</li>}
        {added.length === 0 && removed.length === 0 && <li>列の順序・名前がちがいます</li>}
      </ul>
    </div>
  );
}
