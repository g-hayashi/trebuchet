import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InvoiceDetail } from "@trebuchet/schema";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { formatYen, parseYenInput } from "@/lib/format";
import { accountsQuery, queryKeys, subAccountsQuery } from "@/lib/queries";
import { invoiceKeys, postPayment } from "./api";

/** 画面の端末の今日（`YYYY-MM-DD`）。入金日の初期値だけに使う */
const localToday = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * 入金の消し込み（FR-017〜019）。入金日、入金額、入金先の科目・補助科目。入金額が残額より少ないとき、
 * 差額を「振込手数料」（支払手数料）として扱って残額を 0 にできる。検査は server（金額の超過など）が行う
 */
export function PaymentForm({
  entityId,
  invoice,
}: {
  entityId: string;
  invoice: Pick<InvoiceDetail, "id" | "remaining">;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [receivedOn, setReceivedOn] = useState(localToday);
  const [amount, setAmount] = useState(String(invoice.remaining));
  const [accountId, setAccountId] = useState("");
  const [subAccountId, setSubAccountId] = useState("");
  const [treatAsFee, setTreatAsFee] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  const accounts = useQuery(accountsQuery(entityId));
  const subAccounts = useQuery({
    ...subAccountsQuery(entityId, accountId),
    enabled: accountId !== "",
  });
  // 入金先は資産の科目（預金・現金など）。使用停止のものは選べない
  const depositAccounts = useMemo(
    () =>
      (accounts.data ?? [])
        .filter((a) => a.category === "asset" && a.isActive)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [accounts.data],
  );

  const amountValue = parseYenInput(amount);
  const amountValid =
    amountValue !== undefined && Number.isInteger(amountValue) && amountValue >= 1;
  const fee =
    treatAsFee && amountValid && amountValue < invoice.remaining
      ? invoice.remaining - amountValue
      : undefined;

  const pay = useMutation({
    mutationFn: () =>
      postPayment(entityId, invoice.id, {
        receivedOn,
        amount: amountValue ?? 0,
        depositAccountId: accountId,
        ...(subAccountId === "" ? {} : { depositSubAccountId: subAccountId }),
        ...(treatAsFee ? { treatDifferenceAsFee: true } : {}),
      }),
    onSuccess: async (result) => {
      setNotice("消し込みました。");
      setAmount(String(result.invoice.remaining));
      setTreatAsFee(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: invoiceKeys.invoices(entityId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.journals(entityId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.reports(entityId) }),
      ]);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setNotice("");
    pay.reset();
    if (receivedOn === "") return setFormError("入金日を入力してください");
    if (!amountValid) return setFormError("入金額は 1 円以上の整数で入力してください");
    if (accountId === "") return setFormError("入金先の科目を選んでください");
    if (treatAsFee && fee === undefined) {
      return setFormError(
        "手数料にできる差額がありません（入金額が残額より少ないときだけ使えます）",
      );
    }
    setFormError("");
    pay.mutate();
  };

  return (
    <form
      noValidate
      aria-label="入金の消し込み"
      className="grid gap-4 rounded-md border p-4"
      onSubmit={onSubmit}
    >
      <h2 className="text-base font-semibold">入金を消し込む</h2>
      <p className="text-sm tabular-nums">{`消し込める残額 ${formatYen(invoice.remaining)} 円`}</p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-date`}>入金日</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-amount`}>入金額</Label>
          <Input
            id={`${id}-amount`}
            inputMode="numeric"
            autoComplete="off"
            className="text-right tabular-nums"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-account`}>入金先の科目</Label>
          <NativeSelect
            id={`${id}-account`}
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setSubAccountId("");
            }}
          >
            <option value="">選択してください</option>
            {depositAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-sub`}>補助科目</Label>
          <NativeSelect
            id={`${id}-sub`}
            value={subAccountId}
            disabled={!subAccounts.data || subAccounts.data.length === 0}
            onChange={(e) => setSubAccountId(e.target.value)}
          >
            <option value="">（なし）</option>
            {subAccounts.data
              ?.filter((s) => s.isActive)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </NativeSelect>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id={`${id}-fee`}
          type="checkbox"
          checked={treatAsFee}
          onChange={(e) => setTreatAsFee(e.target.checked)}
        />
        <Label htmlFor={`${id}-fee`}>差額を振込手数料として扱う</Label>
        {fee !== undefined && (
          <span className="text-sm tabular-nums">{`振込手数料 ${formatYen(fee)} 円`}</span>
        )}
      </div>
      <FieldError id={`${id}-form-error`} message={formError} />
      <ApiErrorMessage error={pay.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pay.isPending}>
          消し込む
        </Button>
        <SaveNotice message={notice} />
      </div>
    </form>
  );
}
