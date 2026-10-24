import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BillingTermsInput, YEN_LIMIT } from "@trebuchet/schema";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { parseYenInput } from "@/lib/format";
import { type Partner, queryKeys } from "@/lib/queries";
import {
  type BillingTermsRow,
  deleteBillingTerms,
  invoicingKeys,
  patchPartnerHonorific,
  putBillingTerms,
} from "./api";

type Honorific = "様" | "御中" | "";

type Values = {
  billingType: "hourly" | "monthly";
  amount: string;
  dueMonthsAfter: string;
  dueDay: string;
  defaultItemName: string;
  billingName: string;
  honorific: Honorific;
};

const valuesOf = (partner: Partner, terms: BillingTermsRow | null): Values => ({
  billingType: terms?.billingType ?? "hourly",
  amount: String((terms?.billingType === "monthly" ? terms.monthlyAmount : terms?.unitPrice) ?? ""),
  dueMonthsAfter: String(terms?.dueMonthsAfter ?? 1),
  dueDay: String(terms?.dueDay ?? 31),
  defaultItemName: terms?.defaultItemName ?? "",
  billingName: terms?.billingName ?? "",
  honorific: partner.honorific ?? "",
});

/** 支払期限の月の選択肢（0〜12 か月後） */
const MONTH_OPTIONS = Array.from({ length: 13 }, (_, n) => ({
  value: String(n),
  label: n === 0 ? "当月" : n === 1 ? "翌月" : `${n} か月後`,
}));

/** 支払期限の日の選択肢（1〜28 と末日 = 31。29・30 は選べない。R8） */
const DAY_OPTIONS = [
  ...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 日` })),
  { value: "31", label: "末日" },
];

type Errors = { amount?: string; defaultItemName?: string; form?: string };

function toInput(
  values: Values,
): { input: BillingTermsInput; errors?: undefined } | { input?: undefined; errors: Errors } {
  const errors: Errors = {};
  const amount = parseYenInput(values.amount);
  const label = values.billingType === "hourly" ? "単価" : "月額";
  if (amount === undefined || !Number.isInteger(amount) || amount < 1 || amount >= YEN_LIMIT) {
    errors.amount = `${label}は 1 円以上の整数で入力してください`;
  }
  const defaultItemName = values.defaultItemName.trim();
  if (defaultItemName === "") errors.defaultItemName = "既定の品名を入力してください";
  if (errors.amount || errors.defaultItemName || amount === undefined) return { errors };

  const billingName = values.billingName.trim();
  const parsed = BillingTermsInput.safeParse({
    billingType: values.billingType,
    ...(values.billingType === "hourly" ? { unitPrice: amount } : { monthlyAmount: amount }),
    dueMonthsAfter: Number(values.dueMonthsAfter),
    dueDay: Number(values.dueDay),
    defaultItemName,
    ...(billingName === "" ? {} : { billingName }),
  });
  if (parsed.success) return { input: parsed.data };
  return { errors: { form: parsed.error.issues[0]?.message ?? "入力が正しくありません" } };
}

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
      queryClient.invalidateQueries({ queryKey: queryKeys.partners(entityId) }),
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
  const text = (key: "amount" | "defaultItemName" | "billingName") => ({
    value: values[key],
    onChange: (e: { target: { value: string } }) => set(key)(e.target.value),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setNotice("");
    save.reset();
    const result = toInput(values);
    setErrors(result.errors ?? {});
    if (result.input) save.mutate(result.input);
  };

  const amountLabel = values.billingType === "hourly" ? "時間単価（円）" : "月額（円）";

  return (
    <form
      noValidate
      aria-label={`請求の条件（${partner.name}）`}
      className="grid gap-4 md:grid-cols-2"
      onSubmit={onSubmit}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${id}-type`}>請求の型</Label>
        <NativeSelect
          id={`${id}-type`}
          value={values.billingType}
          onChange={(e) => set("billingType")(e.target.value as Values["billingType"])}
        >
          <option value="hourly">時間単価型（工数 × 単価）</option>
          <option value="monthly">月額定額型</option>
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-amount`}>{amountLabel}</Label>
        <Input
          id={`${id}-amount`}
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={errors.amount ? true : undefined}
          aria-describedby={`${id}-amount-error`}
          {...text("amount")}
        />
        <FieldError id={`${id}-amount-error`} message={errors.amount} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-months`}>支払期限（月）</Label>
        <NativeSelect
          id={`${id}-months`}
          value={values.dueMonthsAfter}
          onChange={(e) => set("dueMonthsAfter")(e.target.value)}
        >
          {MONTH_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-day`}>支払期限（日）</Label>
        <NativeSelect
          id={`${id}-day`}
          value={values.dueDay}
          onChange={(e) => set("dueDay")(e.target.value)}
        >
          {DAY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-item`}>既定の品名</Label>
        <Input
          id={`${id}-item`}
          autoComplete="off"
          aria-invalid={errors.defaultItemName ? true : undefined}
          aria-describedby={`${id}-item-error`}
          {...text("defaultItemName")}
        />
        <FieldError id={`${id}-item-error`} message={errors.defaultItemName} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>宛名（空なら取引先名）</Label>
        <Input id={`${id}-name`} autoComplete="off" {...text("billingName")} />
      </div>
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
