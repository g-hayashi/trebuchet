import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  InvoiceInput,
  type InvoiceItemInput,
  type InvoicePriceMode,
  itemAmountOf,
  MAX_INVOICE_ITEMS,
  YEN_LIMIT,
} from "@trebuchet/schema";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { ApiError } from "@/lib/api";
import { formatYen, parseHalfStep, parseWholeYen, parseYenInput } from "@/lib/format";
import { invalidateLedger } from "@/lib/queries";
import { type InvoiceDraftView, invoiceCalculationQuery, postInvoice } from "./api";

type Row = {
  key: number;
  name: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  amount: string;
  taxCategory: InvoiceItemInput["taxCategory"];
  taxRate: 10 | 8 | null;
  taxRateEdited: boolean;
};

/** 0.5 の倍数の正の数。そうでなければ null（空欄も null） */
const parseQuantity = (raw: string) => parseHalfStep(raw, { min: 0.5 });

/** 正の整数（円）。そうでなければ null */
const parsePositiveYen = (raw: string) => parseWholeYen(raw, { min: 1 });

/** 数量と単価が両方そろった行の金額は `itemAmountOf`（server と同じ式）で決まる */
const computedAmount = (row: Row) => {
  const quantity = parseQuantity(row.quantity);
  const unitPrice = parsePositiveYen(row.unitPrice);
  return quantity !== null && unitPrice !== null ? itemAmountOf(quantity, unitPrice) : undefined;
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
    taxRate: item.taxRate ?? null,
    taxRateEdited: false,
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
    if (row.quantity.trim() !== "" && quantity === null)
      return { error: `${line}の数量は 0.5 単位の正の数で入力してください` };
    const unitPrice = parsePositiveYen(row.unitPrice);
    if (row.unitPrice.trim() !== "" && (unitPrice === null || unitPrice >= YEN_LIMIT))
      return { error: `${line}の単価は 1 円以上、1 兆円未満の整数で入力してください` };
    const amount = amountOf(row);
    if (!Number.isInteger(amount) || amount <= 0 || amount >= YEN_LIMIT)
      return { error: `${line}の金額は 1 円以上、1 兆円未満の整数で入力してください` };
    items.push({
      name,
      ...(quantity === null ? {} : { quantity }),
      ...(row.unit.trim() === "" ? {} : { unit: row.unit.trim() }),
      ...(unitPrice === null ? {} : { unitPrice }),
      amount,
      taxRate: row.taxRate,
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
  existing,
  primary = true,
}: {
  entityId: string;
  draft: InvoiceDraftView;
  partnerName: string;
  /** 「発行する」を主な操作（variant=default）にするか。案が複数あるときは先頭の未発行の案だけ true（ui-shell §7） */
  primary?: boolean | undefined;
  /** 同じ取引先・対象月の発行済み（未取消）の請求書。あれば「追加で作る」を選ぶまで発行できない（011 FR-033） */
  existing?: { id: string; invoiceNo: string } | undefined;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => rowsOf(draft));
  const [priceMode, setPriceMode] = useState<InvoicePriceMode>(draft.priceMode ?? "inclusive");
  const [nextKey, setNextKey] = useState(draft.items.length);
  const [issueDate, setIssueDate] = useState(draft.issueDate);
  const [salesDate, setSalesDate] = useState(draft.salesDate);
  const [confirmed, setConfirmed] = useState(false);
  const [duplicateSeen, setDuplicateSeen] = useState(false);

  const issue = useMutation({
    mutationFn: (items: InvoiceItemInput[]) =>
      postInvoice(entityId, {
        partnerId: draft.partnerId,
        targetMonth: draft.targetMonth,
        issueDate,
        salesDate,
        priceMode,
        items,
        ...(confirmed ? { confirmDuplicate: true } : {}),
      }),
    // 案を作った後に同じ月の請求書ができていたとき（409）も、確認のチェックを出す
    onError: (e) => {
      if (isCode(e, "INVOICE_DUPLICATE_MONTH")) setDuplicateSeen(true);
    },
    onSuccess: () => invalidateLedger(queryClient, entityId),
  });

  const duplicate =
    existing !== undefined ||
    duplicateSeen ||
    draft.warnings.some((w) => w.code === "INVOICE_DUPLICATE_MONTH");
  const built = buildItems(rows);
  const validInput = InvoiceInput.omit({ partnerId: true }).safeParse({
    targetMonth: draft.targetMonth,
    issueDate,
    salesDate,
    priceMode,
    items: built.items,
  });
  const firstIssue = validInput.success ? undefined : validInput.error.issues[0];
  const inputError =
    built.error ??
    (firstIssue === undefined
      ? undefined
      : firstIssue.path[0] === "items"
        ? `${Number(firstIssue.path[1]) + 1} 行目の${firstIssue.path[2] === "name" ? "品名は200文字以内" : firstIssue.path[2] === "unit" ? "単位は20文字以内" : "明細を正しい値"}で入力してください`
        : `${firstIssue.path[0] === "issueDate" ? "発行日" : "売上の計上日"}を正しい日付で入力してください`);
  const calculation = useQuery({
    ...invoiceCalculationQuery(entityId, {
      priceMode,
      items: rows.map((row) => ({ amount: amountOf(row), taxRate: row.taxRate })),
    }),
    enabled: validInput.success && issue.data === undefined,
  });
  const ready = validInput.success && calculation.isSuccess && !calculation.isFetching;
  const total = calculation.data?.total;
  const hasZero = rows.some((row) => amountOf(row) <= 0);
  const issued = issue.data?.invoice;

  const update = (key: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || issue.isPending || issued !== undefined || (duplicate && !confirmed)) return;
    issue.reset();
    if (built.items !== undefined) issue.mutate(built.items);
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
        <fieldset disabled={issued !== undefined || issue.isPending} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-mode`}>金額の入力方法</Label>
            <NativeSelect
              id={`${id}-mode`}
              value={priceMode}
              onChange={(e) => {
                const mode = e.target.value as InvoicePriceMode;
                setPriceMode(mode);
                if (mode === "exclusive")
                  setRows((prev) =>
                    prev.map((row) =>
                      row.taxRate === null && !row.taxRateEdited
                        ? { ...row, taxRate: 10, taxCategory: undefined }
                        : row,
                    ),
                  );
              }}
            >
              <option value="inclusive">税込入力（消費税を加算しない）</option>
              <option value="exclusive">税抜入力（消費税を加算する）</option>
            </NativeSelect>
            <p className="text-sm text-muted-foreground">
              {priceMode === "exclusive"
                ? "単価・金額は税抜で入力します。選んだ税率の消費税相当額を加算します。"
                : "単価・金額は税込で入力します。消費税は加算しません。"}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-2">
              <Label htmlFor={`${id}-issue`}>発行日</Label>
              <Input
                id={`${id}-issue`}
                type="date"
                aria-describedby={`${id}-form-error`}
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-sales`}>売上の計上日</Label>
              <Input
                id={`${id}-sales`}
                type="date"
                aria-describedby={`${id}-form-error`}
                value={salesDate}
                onChange={(e) => setSalesDate(e.target.value)}
              />
            </div>
            <p className="pb-2 text-sm">支払期限 {draft.dueDate}</p>
          </div>

          <div className="grid gap-2">
            <p className="text-sm font-medium">{`単価・金額（${priceMode === "exclusive" ? "税抜" : "税込"}）`}</p>
            {rows.map((row, i) => {
              const n = i + 1;
              const computed = computedAmount(row);
              return (
                <div key={row.key} className="grid grid-cols-12 items-end gap-2">
                  <Input
                    className="col-span-4"
                    aria-label={`品名 ${n}`}
                    aria-describedby={`${id}-row-error-${row.key}`}
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
                    aria-describedby={`${id}-row-error-${row.key}`}
                    value={row.quantity}
                    onChange={(e) => update(row.key, { quantity: e.target.value })}
                  />
                  <Input
                    className="col-span-1"
                    aria-label={`単位 ${n}`}
                    aria-describedby={`${id}-row-error-${row.key}`}
                    autoComplete="off"
                    value={row.unit}
                    onChange={(e) => update(row.key, { unit: e.target.value })}
                  />
                  <Input
                    className="col-span-2 text-right tabular-nums"
                    type="number"
                    min={0}
                    aria-label={`単価 ${n}`}
                    aria-describedby={`${id}-row-error-${row.key}`}
                    value={row.unitPrice}
                    onChange={(e) => update(row.key, { unitPrice: e.target.value })}
                  />
                  {computed === undefined ? (
                    <Input
                      className="col-span-2 text-right tabular-nums"
                      inputMode="numeric"
                      aria-label={`金額 ${n}`}
                      aria-describedby={`${id}-row-error-${row.key}`}
                      value={row.amount}
                      onChange={(e) => update(row.key, { amount: e.target.value })}
                    />
                  ) : (
                    <Input
                      className="col-span-2 text-right tabular-nums"
                      readOnly
                      aria-label={`金額 ${n}`}
                      aria-describedby={`${id}-row-error-${row.key}`}
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
                  <div className="col-span-12 grid gap-1 sm:col-span-4">
                    <Label htmlFor={`${id}-rate-${row.key}`}>{`請求税率 ${n}`}</Label>
                    <NativeSelect
                      id={`${id}-rate-${row.key}`}
                      value={row.taxRate === null ? "none" : String(row.taxRate)}
                      onChange={(e) =>
                        update(row.key, {
                          taxRate:
                            e.target.value === "none" ? null : (Number(e.target.value) as 8 | 10),
                          taxCategory: undefined,
                          taxRateEdited: true,
                        })
                      }
                    >
                      <option value="10">10%</option>
                      <option value="8">8%</option>
                      <option value="none">加算なし</option>
                    </NativeSelect>
                  </div>
                  <div className="col-span-12">
                    <FieldError
                      id={`${id}-row-error-${row.key}`}
                      message={inputError?.startsWith(`${n} 行目`) ? inputError : undefined}
                    />
                  </div>
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
                      taxRate: 10,
                      taxRateEdited: false,
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

          {ready && calculation.data ? (
            <div className="grid justify-items-end gap-1 tabular-nums" aria-live="polite">
              <p>{`小計（${priceMode === "exclusive" ? "税抜" : "税込"}）${formatYen(calculation.data.subtotal)} 円`}</p>
              {priceMode === "exclusive" && (
                <p>{`加算する消費税相当額 ${formatYen(calculation.data.total - calculation.data.subtotal)} 円`}</p>
              )}
              <p className="text-base font-semibold">{`合計 ${formatYen(total ?? 0)} 円`}</p>
            </div>
          ) : (
            <p className="text-right text-sm text-muted-foreground">
              {validInput.success
                ? calculation.isError
                  ? "計算できません。入力を確認してください。"
                  : "請求額を計算中…"
                : "明細と日付を正しく入力してください。"}
            </p>
          )}
          {hasZero && (
            <p className="text-sm text-muted-foreground">
              金額が 0
              円の明細があります。金額を入力するか、明細を削除してください（発行できません）。
            </p>
          )}

          {duplicate && issued === undefined && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <span className="font-medium">
                {existing === undefined ? "発行済み" : `発行済み（${existing.invoiceNo}）`}
              </span>
              {existing !== undefined && (
                <Link
                  to="/e/$entityId/invoices/$invoiceId"
                  params={{ entityId, invoiceId: existing.id }}
                  className="underline underline-offset-4"
                >
                  取り消す
                </Link>
              )}
              <Button
                type="button"
                variant={confirmed ? "secondary" : "outline"}
                size="sm"
                aria-pressed={confirmed}
                onClick={() => setConfirmed((prev) => !prev)}
              >
                追加で作る
              </Button>
              <span className="text-muted-foreground">
                取り消すか、追加で作るかを選ぶと発行できます。
              </span>
            </div>
          )}
        </fieldset>

        <FieldError
          id={`${id}-form-error`}
          message={
            inputError !== undefined && !/^\d+ 行目/.test(inputError) ? inputError : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-3">
          {issued === undefined && (
            <Button
              type="submit"
              variant={primary ? "default" : "outline"}
              disabled={issue.isPending || !ready || hasZero || (duplicate && !confirmed)}
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
        <ApiErrorMessage error={calculation.error} />
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
