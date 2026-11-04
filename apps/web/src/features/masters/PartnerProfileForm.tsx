import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PartnerProfileInput } from "@trebuchet/schema";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type BillingTermsRow, invoiceKeys, invoicingKeys } from "@/features/invoicing/api";
import {
  type BillingErrors,
  BillingTermsFields,
  type BillingValues,
  billingValuesOf,
  toBillingInput,
} from "@/features/invoicing/BillingTermsFields";
import { masterKeys, type Partner, postPartnerProfile, putPartnerProfile } from "./api";

type Honorific = "様" | "御中" | "";

/**
 * 取引先の登録・編集（011 FR-034・R15）。名前・敬称・メモと、請求の条件を 1 つの欄で入れる。
 * 条件は「請求の条件を設定する」を入れたときだけ送る（外せば条件を外す）。1 回の API で保存するので、
 * 取引先だけ登録されて条件が失敗することがない。保存したら取引先・請求の条件・工数を読み直す
 * （請求の条件のある取引先が工数の対象になる）
 */
export function PartnerProfileForm({
  entityId,
  partner,
  terms,
  onDone,
}: {
  entityId: string;
  /** 編集する取引先。null なら新しく登録する */
  partner: Partner | null;
  terms: BillingTermsRow | null;
  onDone: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(partner?.name ?? "");
  const [honorific, setHonorific] = useState<Honorific>(partner?.honorific ?? "");
  const [memo, setMemo] = useState(partner?.memo ?? "");
  const [stopped, setStopped] = useState(partner ? !partner.isActive : false);
  const [withTerms, setWithTerms] = useState(terms !== null);
  const [billing, setBilling] = useState<BillingValues>(() => billingValuesOf(terms));
  const [nameError, setNameError] = useState("");
  const [errors, setErrors] = useState<BillingErrors>({});

  const save = useMutation({
    mutationFn: (json: PartnerProfileInput) =>
      partner === null
        ? postPartnerProfile(entityId, json)
        : putPartnerProfile(entityId, partner.id, json),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: masterKeys.partners(entityId) }),
        queryClient.invalidateQueries({ queryKey: invoicingKeys.billingTerms(entityId) }),
        queryClient.invalidateQueries({ queryKey: invoiceKeys.workHoursAll(entityId) }),
      ]);
      onDone();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.reset();
    const trimmed = name.trim();
    setNameError(trimmed === "" ? "名称を入力してください" : "");
    const converted = withTerms ? toBillingInput(billing) : null;
    setErrors(converted?.errors ?? {});
    if (trimmed === "" || converted?.errors) return;
    save.mutate({
      partner: {
        name: trimmed,
        honorific: honorific === "" ? null : honorific,
        memo: memo.trim(),
        isActive: !stopped,
      },
      billingTerms: converted?.input ?? null,
    });
  };

  return (
    <form
      noValidate
      aria-label={partner === null ? "取引先を登録" : `取引先の編集（${partner.name}）`}
      className="grid gap-4"
      onSubmit={onSubmit}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>名称</Label>
        <Input
          id={`${id}-name`}
          autoComplete="off"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={`${id}-name-error`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <FieldError id={`${id}-name-error`} message={nameError} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-honorific`}>敬称</Label>
        <NativeSelect
          id={`${id}-honorific`}
          value={honorific}
          onChange={(e) => setHonorific(e.target.value as Honorific)}
        >
          <option value="">なし（御中）</option>
          <option value="様">様</option>
          <option value="御中">御中</option>
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-memo`}>メモ</Label>
        <Input
          id={`${id}-memo`}
          autoComplete="off"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
      </div>
      {partner !== null && (
        <div className="flex items-center gap-2">
          <input
            id={`${id}-stopped`}
            type="checkbox"
            checked={stopped}
            onChange={(e) => setStopped(e.target.checked)}
          />
          <Label htmlFor={`${id}-stopped`}>使用停止にする</Label>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          id={`${id}-with-terms`}
          type="checkbox"
          checked={withTerms}
          onChange={(e) => setWithTerms(e.target.checked)}
        />
        <Label htmlFor={`${id}-with-terms`}>請求の条件を設定する</Label>
      </div>
      {withTerms && (
        <fieldset className="grid gap-4 rounded-md border p-4 md:grid-cols-2">
          <legend className="px-1 text-sm font-medium">請求の条件</legend>
          <BillingTermsFields
            id={id}
            values={billing}
            errors={errors}
            onChange={(key, value) => setBilling((prev) => ({ ...prev, [key]: value }))}
          />
          <FieldError id={`${id}-form-error`} message={errors.form} />
        </fieldset>
      )}
      <ApiErrorMessage error={save.error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={save.isPending}>
          保存
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          閉じる
        </Button>
      </div>
    </form>
  );
}
