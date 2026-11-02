import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type InvoiceSettings, InvoiceSettingsInput } from "@trebuchet/schema";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { invoicingKeys, putInvoiceSettings } from "./api";

const SEQ_ERROR = "次の通し番号は 1 以上の整数で入力してください";

type Values = {
  issuerName: string;
  tradeName: string;
  address: string;
  contact: string;
  bankAccount: string;
  registrationNumber: string;
  taxDisplay: "separate" | "inclusive_only";
  nextSeq: string;
};

const valuesOf = (settings: InvoiceSettings | null, minimumNextSeq: number): Values => ({
  issuerName: settings?.issuerName ?? "",
  tradeName: settings?.tradeName ?? "",
  address: settings?.address ?? "",
  contact: settings?.contact ?? "",
  bankAccount: settings?.bankAccount ?? "",
  registrationNumber: settings?.registrationNumber ?? "",
  taxDisplay: settings?.taxDisplay ?? "inclusive_only",
  nextSeq: String(settings?.nextSeq ?? minimumNextSeq),
});

type Errors = Partial<Record<"nextSeq" | "registrationNumber" | "form", string>>;

/** 入力欄の文字列を API の入力にする。形が正しくなければ欄ごとのメッセージを返す */
function toInput(
  values: Values,
): { input: InvoiceSettingsInput; errors?: undefined } | { input?: undefined; errors: Errors } {
  const seq = values.nextSeq.trim();
  if (!/^\d+$/.test(seq) || Number(seq) < 1) return { errors: { nextSeq: SEQ_ERROR } };
  const tradeName = values.tradeName.trim();
  const registrationNumber = values.registrationNumber.trim();
  const parsed = InvoiceSettingsInput.safeParse({
    issuerName: values.issuerName,
    ...(tradeName === "" ? {} : { tradeName }),
    address: values.address,
    contact: values.contact,
    bankAccount: values.bankAccount,
    ...(registrationNumber === "" ? {} : { registrationNumber }),
    taxDisplay: values.taxDisplay,
    nextSeq: Number(seq),
  });
  if (parsed.success) return { input: parsed.data };
  const errors: Errors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] === "registrationNumber" ? "registrationNumber" : "form";
    errors[field] ??= issue.message;
  }
  return { errors };
}

/**
 * 発行者の設定（FR-003）と次の通し番号（FR-004）の編集。
 * 氏名・住所・連絡先・振込先は空でも保存できるが、空のままでは請求書を発行できない
 */
export function IssuerSettingsForm({
  entityId,
  settings,
  minimumNextSeq,
}: {
  entityId: string;
  settings: InvoiceSettings | null;
  minimumNextSeq: number;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(() => valuesOf(settings, minimumNextSeq));
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState("");

  const save = useMutation({
    mutationFn: (input: InvoiceSettingsInput) => putInvoiceSettings(entityId, input),
    onSuccess: async () => {
      setNotice("保存しました。");
      await queryClient.invalidateQueries({ queryKey: invoicingKeys.settings(entityId) });
    },
  });

  const set =
    <K extends keyof Values>(key: K) =>
    (value: Values[K]) => {
      setNotice("");
      setValues((prev) => ({ ...prev, [key]: value }));
    };
  const text = (key: Exclude<keyof Values, "taxDisplay">) => (e: { target: { value: string } }) =>
    set(key)(e.target.value);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setNotice("");
    save.reset();
    const result = toInput(values);
    setErrors(result.errors ?? {});
    if (result.input) save.mutate(result.input);
  };

  return (
    <form noValidate className="grid gap-4 md:max-w-2xl" onSubmit={onSubmit}>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-issuer`}>氏名</Label>
        <Input
          id={`${id}-issuer`}
          autoComplete="off"
          value={values.issuerName}
          onChange={text("issuerName")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-trade`}>屋号</Label>
        <Input
          id={`${id}-trade`}
          autoComplete="off"
          value={values.tradeName}
          onChange={text("tradeName")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-address`}>住所</Label>
        <Input
          id={`${id}-address`}
          autoComplete="off"
          value={values.address}
          onChange={text("address")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-contact`}>連絡先</Label>
        <Input
          id={`${id}-contact`}
          autoComplete="off"
          value={values.contact}
          onChange={text("contact")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-bank`}>振込先</Label>
        <textarea
          id={`${id}-bank`}
          rows={3}
          className="flex w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={values.bankAccount}
          onChange={text("bankAccount")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-registration`}>登録番号</Label>
        <Input
          id={`${id}-registration`}
          autoComplete="off"
          placeholder="T1234567890123"
          aria-invalid={errors.registrationNumber ? true : undefined}
          aria-describedby={`${id}-registration-error`}
          value={values.registrationNumber}
          onChange={text("registrationNumber")}
        />
        <FieldError id={`${id}-registration-error`} message={errors.registrationNumber} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-tax-display`}>税率ごとの内訳表示</Label>
        <NativeSelect
          id={`${id}-tax-display`}
          value={values.taxDisplay}
          onChange={(e) => set("taxDisplay")(e.target.value as Values["taxDisplay"])}
        >
          <option value="inclusive_only">表示しない</option>
          <option value="separate">表示する</option>
        </NativeSelect>
        <p className="text-sm text-muted-foreground">
          請求額は変わりません。加算は請求条件や案で税抜入力を選びます。
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-seq`}>次の通し番号</Label>
        <Input
          id={`${id}-seq`}
          type="number"
          inputMode="numeric"
          aria-invalid={errors.nextSeq ? true : undefined}
          aria-describedby={`${id}-seq-help ${id}-seq-error`}
          value={values.nextSeq}
          onChange={text("nextSeq")}
        />
        <p id={`${id}-seq-help`} className="text-sm text-muted-foreground">
          {minimumNextSeq}{" "}
          以上にします。発行済みの請求書の番号（取消したものを含む）は再び使いません。
        </p>
        <FieldError id={`${id}-seq-error`} message={errors.nextSeq} />
      </div>
      <FieldError id={`${id}-form-error`} message={errors.form} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          保存
        </Button>
        <SaveNotice message={notice} />
      </div>
      <ApiErrorMessage error={save.error} />
    </form>
  );
}
