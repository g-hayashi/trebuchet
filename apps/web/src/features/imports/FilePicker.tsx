import { type ChangeEvent, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FilePickerProps = {
  label: string;
  onChange: (file: File | undefined) => void;
  description?: string | undefined;
  disabled?: boolean | undefined;
  /** 選べるファイルの拡張子（既定は `.csv`） */
  accept?: string | undefined;
};

/** ファイル（既定は CSV）を1つ選ぶ。選んだファイル名を入力欄の下に表示する */
export function FilePicker({
  label,
  onChange,
  description,
  disabled,
  accept = ".csv",
}: FilePickerProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const statusId = `${id}-status`;
  const [fileName, setFileName] = useState<string>();

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    setFileName(file?.name);
    onChange(file);
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {description && (
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      )}
      <Input
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        aria-describedby={description ? `${descriptionId} ${statusId}` : statusId}
        onChange={handleChange}
        className="max-w-xl cursor-pointer"
      />
      <p id={statusId} aria-live="polite" className="text-sm text-muted-foreground">
        {fileName ? `選んだファイル: ${fileName}` : "ファイルが選ばれていません。"}
      </p>
    </div>
  );
}
