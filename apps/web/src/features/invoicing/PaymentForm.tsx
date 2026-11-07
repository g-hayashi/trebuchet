import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InvoiceDetail } from "@trebuchet/schema";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { accountsQuery, subAccountsQuery } from "@/features/accounts/api";
import { today } from "@/lib/dates";
import { formatYen, parseWholeYen } from "@/lib/format";
import { invalidateLedger } from "@/lib/queries";
import { postPayment } from "./api";

/** 前回使った入金先の科目を覚えておく場所（事業体ごと。011 FR-035） */
export const depositAccountKey = (entityId: string) => `trebuchet.depositAccount.${entityId}`;

/**
 * 入金の消し込み（FR-017〜019）。入金日、入金額、源泉徴収税額（013）、入金先の科目・補助科目。
 * 入金額が残額より少ないとき、差額を「振込手数料」（支払手数料）として扱って残額を 0 にできる。
 * 検査は server（金額の超過など）が行う。
 * 源泉徴収税額の既定は請求書の源泉徴収の残り（`withholdingRemaining`。省略は 0）、入金額の既定は
 * 残額からそれを引いた額（013 FR-008）。0 のときは `withholdingAmount` を送らない。
 * 入金先の既定は、同じ事業体で前回消し込んだ科目（今も選べるときだけ）。消し込めたら `onPaid` を呼ぶ
 */
export function PaymentForm({
  entityId,
  invoice,
  onPaid,
}: {
  entityId: string;
  invoice: Pick<InvoiceDetail, "id" | "remaining"> & {
    withholdingRemaining?: number | undefined;
  };
  onPaid?: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [receivedOn, setReceivedOn] = useState(today);
  // 利用者が直すまでは null（請求書の値から導く既定を使う）。消し込んだ後も null に戻して、読み直した残りを既定にする
  const [amountInput, setAmountInput] = useState<string | null>(null);
  const [withholdingInput, setWithholdingInput] = useState<string | null>(null);
  const defaultWithholding = Math.min(invoice.withholdingRemaining ?? 0, invoice.remaining);
  const amount =
    amountInput ??
    String(
      invoice.remaining > defaultWithholding
        ? invoice.remaining - defaultWithholding
        : invoice.remaining,
    );
  const withholding = withholdingInput ?? String(defaultWithholding);
  const [picked, setPicked] = useState<string | null>(null);
  const [subAccountId, setSubAccountId] = useState("");
  const [treatAsFee, setTreatAsFee] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  const accounts = useQuery(accountsQuery(entityId));
  // 入金先は資産の科目（預金・現金など）。使用停止のものは選べない
  const depositAccounts = useMemo(
    () =>
      (accounts.data ?? [])
        .filter((a) => a.category === "asset" && a.isActive)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [accounts.data],
  );
  const remembered = localStorage.getItem(depositAccountKey(entityId));
  const accountId =
    picked ?? (depositAccounts.some((a) => a.id === remembered) ? (remembered ?? "") : "");
  const subAccounts = useQuery({
    ...subAccountsQuery(entityId, accountId),
    enabled: accountId !== "",
  });

  const amountValue = parseWholeYen(amount, { min: 1 });
  const amountValid = amountValue !== null;
  // 空欄は 0（源泉徴収なし）
  const withholdingValue = withholding.trim() === "" ? 0 : parseWholeYen(withholding, { min: 0 });
  const fee =
    treatAsFee &&
    amountValue !== null &&
    withholdingValue !== null &&
    amountValue + withholdingValue < invoice.remaining
      ? invoice.remaining - amountValue - withholdingValue
      : undefined;

  const pay = useMutation({
    mutationFn: () =>
      postPayment(entityId, invoice.id, {
        receivedOn,
        amount: amountValue ?? 0,
        depositAccountId: accountId,
        ...(subAccountId === "" ? {} : { depositSubAccountId: subAccountId }),
        ...(withholdingValue !== null && withholdingValue > 0
          ? { withholdingAmount: withholdingValue }
          : {}),
        ...(treatAsFee ? { treatDifferenceAsFee: true } : {}),
      }),
    onSuccess: async () => {
      localStorage.setItem(depositAccountKey(entityId), accountId);
      setNotice("消し込みました。");
      setAmountInput(null);
      setWithholdingInput(null);
      setTreatAsFee(false);
      await invalidateLedger(queryClient, entityId);
      onPaid?.();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setNotice("");
    pay.reset();
    if (receivedOn === "") return setFormError("入金日を入力してください");
    if (!amountValid) return setFormError("入金額は 1 円以上の整数で入力してください");
    if (withholdingValue === null) {
      return setFormError("源泉徴収税額は 0 円以上の整数で入力してください");
    }
    if (accountId === "") return setFormError("入金先の科目を選んでください");
    if (treatAsFee && fee === undefined) {
      return setFormError(
        "手数料にできる差額がありません（入金額と源泉徴収税額の合計が残額より少ないときだけ使えます）",
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
            onChange={(e) => setAmountInput(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-withholding`}>源泉徴収税額</Label>
          <Input
            id={`${id}-withholding`}
            inputMode="numeric"
            autoComplete="off"
            className="text-right tabular-nums"
            value={withholding}
            onChange={(e) => setWithholdingInput(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-account`}>入金先の科目</Label>
          <NativeSelect
            id={`${id}-account`}
            value={accountId}
            onChange={(e) => {
              setPicked(e.target.value);
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
        <Button type="submit" variant="outline" disabled={pay.isPending}>
          消し込む
        </Button>
        <SaveNotice message={notice} />
      </div>
    </form>
  );
}
