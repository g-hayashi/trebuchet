import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Loading } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { putStatementSettings, statementKeys, statementSettingsQuery } from "./api";

const RANGE_MESSAGE = "0〜100 の整数で入力してください";

/** 0〜100 の整数の文字列だけを数にする（小数・符号・空欄・全角は不可） */
const parsePercent = (raw: string): number | undefined => {
  const text = raw.trim();
  if (!/^\d{1,3}$/.test(text)) return undefined;
  const value = Number(text);
  return value <= 100 ? value : undefined;
};

type FormValues = { bulk: string; external: string };

function Fields({
  entityId,
  initial,
}: {
  entityId: string;
  initial: { bulkThreshold: number; externalThreshold: number };
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<FormValues>({
    bulk: String(initial.bulkThreshold),
    external: String(initial.externalThreshold),
  });
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const [notice, setNotice] = useState("");

  const save = useMutation({
    mutationFn: (input: { bulkThreshold: number; externalThreshold: number }) =>
      putStatementSettings(entityId, input),
    onSuccess: (saved) => {
      queryClient.setQueryData(statementKeys.settings(entityId), saved);
      setNotice("保存しました。");
    },
  });

  const submit = () => {
    setNotice("");
    save.reset();
    const bulk = parsePercent(values.bulk);
    const external = parsePercent(values.external);
    setErrors({
      ...(bulk === undefined ? { bulk: RANGE_MESSAGE } : {}),
      ...(external === undefined ? { external: RANGE_MESSAGE } : {}),
    });
    if (bulk === undefined || external === undefined) return;
    save.mutate({ bulkThreshold: bulk, externalThreshold: external });
  };

  const field = (key: keyof FormValues, label: string, hint: string) => (
    <div className="grid content-start gap-1">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input
        id={`${id}-${key}`}
        inputMode="numeric"
        autoComplete="off"
        className="max-w-32 text-right tabular-nums"
        value={values[key]}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={`${id}-${key}-error`}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
      <FieldError id={`${id}-${key}-error`} message={errors[key]} />
    </div>
  );

  return (
    <form
      noValidate
      aria-label="明細の設定"
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {field(
        "bulk",
        "確信度の高い行のしきい値",
        "確信度がこの値以上の行を、確認の画面の「確信度の高い行を選択」で選びます（0〜100）。選ぶだけで、承認は行を選んでから行います。",
      )}
      {field(
        "external",
        "外部の AI へ送るしきい値",
        "確信度がこの値未満のとき、外部の AI へ送ることがあります（0〜100）。",
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          保存
        </Button>
        {notice && <SaveNotice message={notice} />}
      </div>
      <ApiErrorMessage error={save.error} />
    </form>
  );
}

/** 明細の設定（H:§6.3。006/FR-018・027）: 「確信度の高い行を選択」と外部へ送るしきい値。事業体ごと */
export function StatementSettingsForm({ entityId }: { entityId: string }) {
  const settings = useQuery(statementSettingsQuery(entityId));
  return (
    <div className="grid gap-3">
      <ApiErrorMessage error={settings.error} />
      {settings.isPending && <Loading />}
      {settings.data && <Fields key={entityId} entityId={entityId} initial={settings.data} />}
    </div>
  );
}
