import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { thisYear } from "@/lib/dates";
import type { PasteSource } from "./api";

/**
 * MF ME の「入出金」の表の貼り付け（R2）。日付は `MM/DD(曜)` で年を持たないので、対象の年を添える
 * （既定は今年）。「プレビュー」で `onPreview` に渡す。何も保存しない
 */
export function PasteImport({
  pending,
  onPreview,
}: {
  pending: boolean;
  onPreview: (source: PasteSource) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [year, setYear] = useState(String(thisYear()));
  const [errors, setErrors] = useState<{ text?: string; year?: string }>({});

  const submit = () => {
    const next: typeof errors = {};
    const yearNumber = Number(year);
    if (text.trim() === "") next.text = "貼り付けのテキストを入力してください";
    if (!Number.isInteger(yearNumber) || yearNumber < 1900 || yearNumber > 9999) {
      next.year = "対象の年を 4 桁で入力してください";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onPreview({ kind: "paste", text, year: yearNumber });
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor={`${id}-text`}>貼り付けのテキスト</Label>
        <textarea
          id={`${id}-text`}
          rows={8}
          spellCheck={false}
          aria-invalid={errors.text ? true : undefined}
          aria-describedby={`${id}-text-error`}
          className="min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
          placeholder="MF ME の入出金の表をコピーして貼り付けます（見出しの行つきでも、なしでも構いません）"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <FieldError id={`${id}-text-error`} message={errors.text} />
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-year`}>対象の年</Label>
          <Input
            id={`${id}-year`}
            type="number"
            inputMode="numeric"
            className="w-28"
            aria-invalid={errors.year ? true : undefined}
            aria-describedby={`${id}-year-error`}
            value={year}
            onChange={(e) => setYear(e.target.value)}
          />
          <FieldError id={`${id}-year-error`} message={errors.year} />
        </div>
        <Button type="submit" disabled={pending}>
          プレビュー
        </Button>
      </div>
    </form>
  );
}
