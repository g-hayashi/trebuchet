import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BillingTermsInput } from "@trebuchet/schema";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { masterKeys, type Partner } from "@/features/masters/api";
import {
  type BillingTermsRow,
  deleteBillingTerms,
  invoicingKeys,
  patchPartnerHonorific,
  putBillingTerms,
} from "./api";
import {
  type BillingErrors,
  BillingTermsFields,
  type BillingValues,
  billingValuesOf,
  toBillingInput,
} from "./BillingTermsFields";

type Honorific = "様" | "御中" | "";

type Values = BillingValues & { honorific: Honorific };
type Errors = BillingErrors;

const valuesOf = (partner: Partner, terms: BillingTermsRow | null): Values => ({
  ...billingValuesOf(terms),
  honorific: partner.honorific ?? "",
});

/**
 * 取引先の請求の条件の編集（FR-001・FR-002）。型の切り替え（時間単価型・月額定額型）、
 * 支払期限（N か月後の 1〜28 日または末日）、既定の品名、宛名、請求書の敬称。
 * 敬称は 001 の取引先の列なので、変えたときは取引先を更新してから条件を保存する
 */
export function BillingTermsForm({
  entityId,
  partner,
  terms,
  onClose,
}: {
  entityId: string;
  partner: Partner;
  terms: BillingTermsRow | null;
  onClose: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(() => valuesOf(partner, terms));
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState("");

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: invoicingKeys.billingTerms(entityId) }),
      queryClient.invalidateQueries({ queryKey: masterKeys.partners(entityId) }),
    ]);

  const save = useMutation({
    mutationFn: async (input: BillingTermsInput) => {
      const honorific = values.honorific === "" ? null : values.honorific;
      if (honorific !== partner.honorific) {
        await patchPartnerHonorific(entityId, partner, honorific);
      }
      return putBillingTerms(entityId, partner.id, input);
    },
    onSuccess: async () => {
      setNotice("保存しました。");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteBillingTerms(entityId, partner.id),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  const set =
    <K extends keyof Values>(key: K) =>
    (value: Values[K]) => {
      setNotice("");
      setValues((prev) => ({ ...prev, [key]: value }));
    };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setNotice("");
    save.reset();
    const result = toBillingInput(values);
    setErrors(result.errors ?? {});
    if (result.input) save.mutate(result.input);
  };

  return (
    <form
      noValidate
      aria-label={`請求の条件（${partner.name}）`}
      className="grid gap-4 md:grid-cols-2"
      onSubmit={onSubmit}
    >
      <BillingTermsFields
        id={id}
        values={values}
        errors={errors}
        onChange={(k, v) => {
          setNotice("");
          setValues((prev) => ({ ...prev, [k]: v }));
        }}
      />
      <div className="grid gap-2">
        <Label htmlFor={`${id}-honorific`}>請求書の敬称</Label>
        <NativeSelect
          id={`${id}-honorific`}
          value={values.honorific}
          onChange={(e) => set("honorific")(e.target.value as Honorific)}
        >
          <option value="">なし（御中）</option>
          <option value="様">様</option>
          <option value="御中">御中</option>
        </NativeSelect>
      </div>
      <FieldError id={`${id}-form-error`} message={errors.form} />
      <div className="flex flex-wrap items-center gap-2 md:col-span-2">
        <Button type="submit" disabled={save.isPending}>
          保存
        </Button>
        {terms && (
          <Button
            type="button"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            条件を外す
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onClose}>
          閉じる
        </Button>
        <SaveNotice message={notice} />
      </div>
      <ApiErrorMessage error={save.error ?? remove.error} className="md:col-span-2" />
    </form>
  );
}
