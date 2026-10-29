import type { StatementOrigin } from "@trebuchet/schema";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/form-error";
import { Label } from "@/components/ui/label";
import { FilePicker } from "@/features/imports/FilePicker";

/** 読み取りに渡す入力。貼り付けは UTF-8 のファイルにして、ファイルと同じ形で送る（007 contracts §2） */
export type StatementInputValue = { file: File; origin: StatementOrigin };

const PASTE_FILE_NAME = "paste.txt";

/**
 * 明細の入力（US1）: 銀行・カードの画面からコピーした表を貼り付けるか、CSV などのファイルを選ぶ。
 * 「読み取る」で `onRead` に渡す。何も保存しない
 */
export function StatementInput({
  pending,
  onRead,
}: {
  pending: boolean;
  onRead: (input: StatementInputValue) => void;
}) {
  const id = useId();
  const [origin, setOrigin] = useState<StatementOrigin>("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | undefined>();
  const [error, setError] = useState<string | undefined>();

  const submit = () => {
    if (origin === "paste") {
      if (text.trim() === "") return setError("貼り付けのテキストを入力してください");
      setError(undefined);
      onRead({
        origin,
        file: new File([text], PASTE_FILE_NAME, { type: "text/plain;charset=utf-8" }),
      });
      return;
    }
    if (file === undefined) return setError("ファイルを選んでください");
    setError(undefined);
    onRead({ origin, file });
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset className="flex flex-wrap items-center gap-4">
        <legend className="mb-1 text-sm font-medium">入力の方法</legend>
        {(
          [
            ["paste", "貼り付け"],
            ["file", "ファイル"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-origin`}
              value={value}
              checked={origin === value}
              onChange={() => {
                setOrigin(value);
                setError(undefined);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>

      {origin === "paste" ? (
        <div className="grid gap-1">
          <Label htmlFor={`${id}-text`}>貼り付けのテキスト</Label>
          <textarea
            id={`${id}-text`}
            rows={8}
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-error`}
            className="min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
            placeholder="銀行・カードの明細の表をコピーして貼り付けます（見出しの行つきでも、なしでも構いません）"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      ) : (
        <FilePicker
          label="明細のファイル"
          accept=".csv,.tsv,.txt"
          description="銀行・カードの明細の CSV（文字コードは自動で判定します）。"
          onChange={setFile}
        />
      )}
      <FieldError id={`${id}-error`} message={error} />

      <div>
        <Button type="submit" disabled={pending}>
          読み取る
        </Button>
      </div>
    </form>
  );
}
