import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type InvoiceItemInput,
  isHalfStep,
  itemAmountOf,
  MAX_INVOICE_ITEMS,
} from "@trebuchet/schema";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { ApiError } from "@/lib/api";
import { formatYen, parseYenInput } from "@/lib/format";
import { queryKeys } from "@/lib/queries";
import { type InvoiceDraftView, invoiceKeys, postInvoice } from "./api";

type Row = {
  key: number;
  name: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  amount: string;
  taxCategory: InvoiceItemInput["taxCategory"];
};

/** 0.5 の倍数の正の数。そうでなければ undefined（空欄も undefined） */
const parseQuantity = (raw: string) => {
  const text = raw.trim();
  if (text === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 && isHalfStep(n) ? n : undefined;
};

/** 正の整数（円）。そうでなければ undefined */
const parsePositiveYen = (raw: string) => {
  const n = parseYenInput(raw);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};

/** 数量と単価が両方そろった行の金額は `itemAmountOf`（server と同じ式）で決まる */
const computedAmount = (row: Row) => {
  const quantity = parseQuantity(row.quantity);
  const unitPrice = parsePositiveYen(row.unitPrice);
  return quantity !== undefined && unitPrice !== undefined
    ? itemAmountOf(quantity, unitPrice)
    : undefined;
};

/** 行の金額（計算の行は式の値、それ以外は入力の値。不正は 0） */
const amountOf = (row: Row) => computedAmount(row) ?? parseYenInput(row.amount) ?? 0;

const rowsOf = (draft: InvoiceDraftView): Row[] =>
  draft.items.map((item, i) => ({
    key: i,
    name: item.name,
    quantity: item.quantity === undefined ? "" : String(item.quantity),
    unit: item.unit ?? "",
    unitPrice: item.unitPrice === undefined ? "" : String(item.unitPrice),
    amount: String(item.amount),
    taxCategory: item.taxCategory,
  }));

type Built =
  | { items: InvoiceItemInput[]; error?: undefined }
  | { items?: undefined; error: string };

/** 入力の行を API の明細にする。直せない入力は、その行のメッセージを返す */
function buildItems(rows: Row[]): Built {
  const items: InvoiceItemInput[] = [];
  for (const [i, row] of rows.entries()) {
    const line = `${i + 1} 行目`;
    const name = row.name.trim();
    if (name === "") return { error: `${line}の品名を入力してください` };
    const quantity = parseQuantity(row.quantity);
    if (row.quantity.trim() !== "" && quantity === undefined)
      return { error: `${line}の数量は 0.5 単位の正の数で入力してください` };
    const unitPrice = parsePositiveYen(row.unitPrice);
    if (row.unitPrice.trim() !== "" && unitPrice === undefined)
      return { error: `${line}の単価は正の整数で入力してください` };
    const amount = amountOf(row);
    if (!Number.isInteger(amount) || amount <= 0)
      return { error: `${line}の金額は正の整数で入力してください` };
    items.push({
      name,
      ...(quantity === undefined ? {} : { quantity }),
      ...(row.unit.trim() === "" ? {} : { unit: row.unit.trim() }),
      ...(unitPrice === undefined ? {} : { unitPrice }),
      amount,
      ...(row.taxCategory === undefined ? {} : { taxCategory: row.taxCategory }),
    });
  }
  return { items };
}

const isCode = (error: unknown, code: string) => error instanceof ApiError && error.code === code;

/**
 * 請求書の案 1 通の編集と発行（FR-006〜016）。明細は 1〜5 行。合計の再計算は表示だけで、
 * 数量 × 単価の行の金額は server と同じ式（`itemAmountOf`）。発行日と売上の計上日は変えられる（FR-009）
 */
export function InvoiceDraftEditor({
  entityId,
  draft,
  partnerName,
}: {
  entityId: string;
  draft: InvoiceDraftView;
  partnerName: string;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => rowsOf(draft));
  const [nextKey, setNextKey] = useState(draft.items.length);
  const [issueDate, setIssueDate] = useState(draft.issueDate);
  const [salesDate, setSalesDate] = useState(draft.salesDate);
  const [confirmed, setConfirmed] = useState(false);
  const [formError, setFormError] = useState("");
  const [duplicateSeen, setDuplicateSeen] = useState(false);

  const issue = useMutation({
    mutationFn: (items: InvoiceItemInput[]) =>
      postInvoice(entityId, {
        partnerId: draft.partnerId,
        targetMonth: draft.targetMonth,
        issueDate,
        salesDate,
        items,
        ...(confirmed ? { confirmDuplicate: true } : {}),
      }),
    // 案を作った後に同じ月の請求書ができていたとき（409）も、確認のチェックを出す
    onError: (e) => {
      if (isCode(e, "INVOICE_DUPLICATE_MONTH")) setDuplicateSeen(true);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: invoiceKeys.invoices(entityId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.journals(entityId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.reports(entityId) }),
      ]);
    },
  });

  const duplicate =
    duplicateSeen || draft.warnings.some((w) => w.code === "INVOICE_DUPLICATE_MONTH");
  const total = rows.reduce((sum, row) => sum + amountOf(row), 0);
  const hasZero = rows.some((row) => amountOf(row) <= 0);
  const issued = issue.data?.invoice;

  const update = (key: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setFormError("");
    issue.reset();
    const built = buildItems(rows);
    if (built.error !== undefined) {
      setFormError(built.error);
      return;
    }
    issue.mutate(built.items);
  };

  return (
    <section
      aria-label={`請求書の案（${partnerName}）`}
      className="grid gap-4 rounded-md border p-4"
    >
      <h2 className="text-lg font-semibold">
        {partnerName}
        <span className="ml-3 text-sm font-normal text-muted-foreground">
          {draft.targetMonth} 分
        </span>
      </h2>
      {draft.warnings.length > 0 && (
        <ul className="list-disc rounded-md border border-amber-500/60 bg-amber-50 py-2 pr-3 pl-7 text-sm text-amber-900">
          {draft.warnings.map((w) => (
            <li key={w.code}>{w.message}</li>
          ))}
        </ul>
      )}
      <form noValidate className="grid gap-4" onSubmit={onSubmit}>
        <fieldset disabled={issued !== undefined} className="grid gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-2">
              <Label htmlFor={`${id}-issue`}>発行日</Label>
              <Input
                id={`${id}-issue`}
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-sales`}>売上の計上日</Label>
              <Input
                id={`${id}-sales`}
                type="date"
                value={salesDate}
                onChange={(e) => setSalesDate(e.target.value)}
              />
            </div>
            <p className="pb-2 text-sm">支払期限 {draft.dueDate}</p>
          </div>

          <div className="grid gap-2">
            {rows.map((row, i) => {
              const n = i + 1;
              const computed = computedAmount(row);
              return (
                <div key={row.key} className="grid grid-cols-12 items-end gap-2">
                  <Input
                    className="col-span-4"
                    aria-label={`品名 ${n}`}
                    autoComplete="off"
                    value={row.name}
                    onChange={(e) => update(row.key, { name: e.target.value })}
                  />
                  <Input
                    className="col-span-2 text-right tabular-nums"
                    type="number"
                    step={0.5}
                    min={0}
                    aria-label={`数量 ${n}`}
                    value={row.quantity}
                    onChange={(e) => update(row.key, { quantity: e.target.value })}
                  />
                  <Input
                    className="col-span-1"
                    aria-label={`単位 ${n}`}
                    autoComplete="off"
                    value={row.unit}
                    onChange={(e) => update(row.key, { unit: e.target.value })}
                  />
                  <Input
                    className="col-span-2 text-right tabular-nums"
                    type="number"
                    min={0}
                    aria-label={`単価 ${n}`}
                    value={row.unitPrice}
                    onChange={(e) => update(row.key, { unitPrice: e.target.value })}
                  />
                  {computed === undefined ? (
                    <Input
                      className="col-span-2 text-right tabular-nums"
                      inputMode="numeric"
                      aria-label={`金額 ${n}`}
                      value={row.amount}
                      onChange={(e) => update(row.key, { amount: e.target.value })}
                    />
                  ) : (
                    <Input
                      className="col-span-2 text-right tabular-nums"
                      readOnly
                      aria-label={`金額 ${n}`}
                      value={formatYen(computed)}
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    className="col-span-1"
                    aria-label={`明細 ${n} を削除`}
                    disabled={rows.length <= 1}
                    onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                  >
                    削除
                  </Button>
                </div>
              );
            })}
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={rows.length >= MAX_INVOICE_ITEMS}
                onClick={() => {
                  setRows((prev) => [
                    ...prev,
                    {
                      key: nextKey,
                      name: "",
                      quantity: "",
                      unit: "",
                      unitPrice: "",
                      amount: "",
                      taxCategory: undefined,
                    },
                  ]);
                  setNextKey(nextKey + 1);
                }}
              >
                明細を追加
              </Button>
              <span className="ml-3 text-sm text-muted-foreground">
                最大 {MAX_INVOICE_ITEMS} 行
              </span>
            </div>
          </div>

          <p className="text-right text-base font-semibold tabular-nums">
            {`合計 ${formatYen(total)} 円`}
          </p>
          {hasZero && (
            <p className="text-sm text-muted-foreground">
              金額が 0
              円の明細があります。金額を入力するか、明細を削除してください（発行できません）。
            </p>
          )}

          {duplicate && (
            <div className="flex items-center gap-2">
              <input
                id={`${id}-confirm`}
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <Label htmlFor={`${id}-confirm`}>それでも発行する</Label>
            </div>
          )}
        </fieldset>

        <FieldError id={`${id}-form-error`} message={formError} />
        <div className="flex flex-wrap items-center gap-3">
          {issued === undefined && (
            <Button
              type="submit"
              disabled={issue.isPending || hasZero || (duplicate && !confirmed)}
            >
              発行する
            </Button>
          )}
          <SaveNotice message={issued ? `発行しました（請求書 ${issued.invoiceNo}）。` : ""} />
          {issued && (
            <Link
              to="/e/$entityId/invoices/$invoiceId"
              params={{ entityId, invoiceId: issued.id }}
              className="text-sm underline underline-offset-4"
            >
              {`請求書 ${issued.invoiceNo} を開く`}
            </Link>
          )}
        </div>
        <ApiErrorMessage error={issue.error} />
        {isCode(issue.error, "INVOICE_ISSUER_INCOMPLETE") && (
          <Link
            to="/e/$entityId/invoice-settings"
            params={{ entityId }}
            className="w-fit text-sm font-medium underline underline-offset-4"
          >
            請求の設定を開く
          </Link>
        )}
      </form>
    </section>
  );
}
