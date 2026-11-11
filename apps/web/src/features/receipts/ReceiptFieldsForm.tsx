import {
  MASTER_NAME_MAX,
  type ReceiptDetail,
  type ReceiptReadingView,
  type ReceiptUpdateInput,
} from "@trebuchet/schema";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { isApiError } from "@/lib/api";
import { formatYen, parseWholeYen } from "@/lib/format";
import { RECEIPT_MEMO_MAX } from "@/lib/limits";
import { patchReceipt } from "./api";
import { useReceiptWrite } from "./use-receipt-write";

type Values = { transactionDate: string; amount: string; partnerName: string; memo: string };

const valuesOf = (r: ReceiptDetail): Values => ({
  transactionDate: r.transactionDate ?? "",
  amount: r.amount === null ? "" : formatYen(r.amount),
  partnerName: r.partnerName ?? "",
  memo: r.memo ?? "",
});

/**
 * 証憑の値の入力と訂正（US1: 未入力の値を埋める・メモを変える。理由は要らない。US5: 訂正）。
 * 変えた項目だけを `version` と一緒に送る。入力済みの値を変える（訂正）ときは server が
 * `REASON_REQUIRED` を返すので、理由を求めて同じ変更に `reason` を足して送り直す。
 * 理由が要るかの判定は server に任せる（web に業務ルールを持たない）
 */
export function ReceiptFieldsForm({
  entityId,
  receipt,
  reading,
  onNext,
}: {
  entityId: string;
  receipt: ReceiptDetail;
  /** 入力欄の初期値にする AI の候補（成功した読み取り。010 US4）。入力済みの欄は上書きしない */
  reading?: ReceiptReadingView | undefined;
  onNext?: (() => void) | undefined;
}) {
  const id = useId();
  const [values, setValues] = useState<Values>(() => valuesOf(receipt));
  // AI の候補を入れた欄（未保存）。直す・保存すると外れる
  const [suggested, setSuggested] = useState<ReadonlySet<keyof Values>>(new Set());
  const appliedReading = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (reading === undefined || appliedReading.current === reading.id) return;
    appliedReading.current = reading.id;
    const c = reading.candidates;
    const candidates: Partial<Values> = {};
    if (c.transactionDate !== null) candidates.transactionDate = c.transactionDate;
    if (c.amount !== null) candidates.amount = formatYen(c.amount);
    if (c.partnerName !== null) candidates.partnerName = c.partnerName;
    setValues((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(candidates) as (keyof Values)[]) {
        if (prev[key] === "") next[key] = candidates[key] ?? "";
      }
      return next;
    });
    setSuggested(
      new Set(
        (Object.keys(candidates) as (keyof Values)[]).filter(
          (key) => valuesOf(receipt)[key] === "",
        ),
      ),
    );
  }, [reading, receipt]);
  const [amountError, setAmountError] = useState<string | undefined>();
  const [message, setMessage] = useState<"saved" | "unchanged" | undefined>();
  // 理由を求められた入力（server が REASON_REQUIRED を返したとき）
  const [correction, setCorrection] = useState<ReceiptUpdateInput | undefined>();
  const nextAfterSave = useRef(false);

  // 保存したら詳細を置き換え、一覧・検索の結果にも反映する
  const mutation = useReceiptWrite(
    entityId,
    receipt.id,
    (input: ReceiptUpdateInput) => patchReceipt(entityId, receipt.id, input),
    {
      onUpdated: (updated) => {
        setValues(valuesOf(updated));
        setSuggested(new Set());
        setMessage("saved");
      },
      onInvalidated: () => {
        if (nextAfterSave.current) onNext?.();
      },
    },
  );

  const set = (key: keyof Values) => (value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSuggested((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setMessage(undefined);
  };

  /** AI の候補を入れた欄の印（未保存。保存するまで証憑の値ではない） */
  const suggestion = (key: keyof Values) =>
    suggested.has(key) && <p className="text-xs text-muted-foreground">AI の候補（未保存）</p>;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (mutation.isPending) return;
    nextAfterSave.current =
      (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "next";
    mutation.reset();
    setMessage(undefined);
    const input: ReceiptUpdateInput = { version: receipt.version };

    const yen = values.amount.trim() === "" ? null : parseWholeYen(values.amount, { min: 1 });
    if (values.amount.trim() !== "" && yen === null) {
      setAmountError("1 円以上の整数で入力してください");
      return;
    }
    setAmountError(undefined);

    const date = values.transactionDate === "" ? null : values.transactionDate;
    if (date !== receipt.transactionDate) input.transactionDate = date;
    if (yen !== receipt.amount) input.amount = yen;
    const partner = values.partnerName.trim() === "" ? null : values.partnerName.trim();
    if (partner !== receipt.partnerName) input.partnerName = partner;
    const memo = values.memo.trim() === "" ? null : values.memo.trim();
    if (memo !== receipt.memo) input.memo = memo;

    if (Object.keys(input).length === 1) {
      setMessage("unchanged");
      if (nextAfterSave.current) onNext?.();
      return;
    }
    // 理由が要るか（訂正か）は server が決める。422 REASON_REQUIRED を受けたら理由を求める
    mutation.mutate(input, {
      onError: (error) => {
        if (isApiError(error, "REASON_REQUIRED")) setCorrection(input);
      },
    });
  };

  const needsReason = isApiError(mutation.error, "REASON_REQUIRED");

  return (
    <>
      <form aria-label="証憑の値" noValidate onSubmit={submit} className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          未入力の値とメモを入力できます。入力済みの値（取引年月日・金額・取引先・区分）を変えるには理由が必要です。
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid content-start gap-1">
            <Label htmlFor={`${id}-date`}>取引年月日</Label>
            <Input
              id={`${id}-date`}
              type="date"
              value={values.transactionDate}
              onChange={(e) => set("transactionDate")(e.target.value)}
            />
            {suggestion("transactionDate")}
          </div>
          <div className="grid content-start gap-1">
            <Label htmlFor={`${id}-amount`}>金額</Label>
            <Input
              id={`${id}-amount`}
              inputMode="numeric"
              autoComplete="off"
              className="text-right tabular-nums"
              value={values.amount}
              aria-invalid={amountError ? true : undefined}
              aria-describedby={`${id}-amount-error`}
              onChange={(e) => {
                set("amount")(e.target.value);
                setAmountError(undefined);
              }}
            />
            <FieldError id={`${id}-amount-error`} message={amountError} />
            {suggestion("amount")}
          </div>
          <div className="grid content-start gap-1">
            <Label htmlFor={`${id}-partner`}>取引先</Label>
            <Input
              id={`${id}-partner`}
              autoComplete="off"
              maxLength={MASTER_NAME_MAX}
              value={values.partnerName}
              onChange={(e) => set("partnerName")(e.target.value)}
            />
            {suggestion("partnerName")}
          </div>
          <div className="grid content-start gap-1">
            <Label htmlFor={`${id}-memo`}>メモ</Label>
            <Input
              id={`${id}-memo`}
              autoComplete="off"
              maxLength={RECEIPT_MEMO_MAX}
              value={values.memo}
              onChange={(e) => set("memo")(e.target.value)}
            />
          </div>
        </div>
        {!needsReason && <ApiErrorMessage error={mutation.error} />}
        <div className="flex flex-wrap items-center gap-4">
          <Button
            type="submit"
            variant={onNext ? "outline" : "default"}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "保存中…" : "保存"}
          </Button>
          {onNext && (
            <Button
              type="submit"
              name="action"
              value="next"
              variant="outline"
              disabled={mutation.isPending}
              className="h-auto whitespace-normal"
            >
              次の未入力の証憑へ
            </Button>
          )}
          <SaveNotice
            message={
              message === "saved"
                ? "保存しました。"
                : message === "unchanged"
                  ? "変更がありません"
                  : ""
            }
          />
        </div>
      </form>
      {/* ダイアログの submit が親の form に伝わらないよう、form の外に置く */}
      <ReasonDialog
        open={correction !== undefined}
        title="入力済みの値の訂正"
        description="訂正しても、元の値・理由・日時は履歴に残ります。"
        confirmLabel="訂正を確定"
        onConfirm={async (reason) => {
          if (correction === undefined) return;
          await mutation.mutateAsync({ ...correction, reason });
          setCorrection(undefined);
        }}
        onCancel={() => {
          setCorrection(undefined);
          mutation.reset();
        }}
      />
    </>
  );
}
