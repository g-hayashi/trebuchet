import type { ReceiptCategory, ReceiptLinkState, ReceiptQueryInput } from "@trebuchet/schema";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { parseWholeYen } from "@/lib/format";
import type { ReceiptSearch } from "./api";
import { CATEGORY_LABELS, CATEGORY_OPTIONS, LINK_FILTER_LABELS } from "./labels";

/** URL の検索パラメーターに入れる検索条件（ページの指定を除く） */
export type ReceiptSearchInput = Omit<ReceiptQueryInput, "cursor" | "limit">;

const LINK_OPTIONS: ReceiptLinkState[] = ["none", "linked", "journal_voided"];

/** 金額の条件の入力。空欄は指定なし、0 以上の整数でなければ null */
const parseAmount = (raw: string): number | undefined | null =>
  raw.trim() === "" ? undefined : parseWholeYen(raw, { min: 0 });

const AMOUNT_MESSAGE = "0 以上の整数で入力してください";

/** 証憑の検索の条件のフォーム（FR-008）。条件は URL の検索パラメーターに入れる */
export function ReceiptSearchForm({
  search,
  onSearch,
  onClear,
}: {
  search: ReceiptSearch;
  onSearch: (next: ReceiptSearchInput) => void;
  onClear: () => void;
}) {
  const [amountErrors, setAmountErrors] = useState<{ min?: boolean; max?: boolean }>({});

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (name: string) => {
      const v = String(data.get(name) ?? "").trim();
      return v === "" ? undefined : v;
    };
    const amountMin = parseAmount(String(data.get("amountMin") ?? ""));
    const amountMax = parseAmount(String(data.get("amountMax") ?? ""));
    setAmountErrors({ min: amountMin === null, max: amountMax === null });
    if (amountMin === null || amountMax === null) return;
    const category = text("category") as ReceiptCategory | undefined;
    const link = text("link") as ReceiptLinkState | undefined;
    const next: ReceiptSearchInput = {
      dateFrom: text("dateFrom"),
      dateTo: text("dateTo"),
      amountMin,
      amountMax,
      partner: text("partner"),
      category,
      link,
      missing: data.get("missing") === "on" ? true : undefined,
      includeDeleted: data.get("includeDeleted") === "on" ? true : undefined,
    };
    onSearch(
      Object.fromEntries(
        Object.entries(next).filter(([, v]) => v !== undefined),
      ) as ReceiptSearchInput,
    );
  };

  const searchKey = JSON.stringify(search);
  const field = "grid content-start gap-1";
  const label = "text-sm font-medium";

  return (
    <Card>
      <CardContent className="pt-6">
        {/* biome-ignore lint/a11y/noRedundantRoles: search 要素の暗黙のロールに未対応の支援技術・ブラウザがあるため明示する */}
        <search role="search" aria-label="証憑の検索">
          <form noValidate onSubmit={submit} className="grid gap-4">
            {/* 条件が URL で変わったら（クリア・戻る）入力欄を作り直して URL の値に合わせる */}
            <div key={searchKey} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className={field}>
                <label htmlFor="receipt-search-date-from" className={label}>
                  取引年月日（から）
                </label>
                <Input
                  id="receipt-search-date-from"
                  name="dateFrom"
                  type="date"
                  defaultValue={search.dateFrom}
                />
              </div>
              <div className={field}>
                <label htmlFor="receipt-search-date-to" className={label}>
                  取引年月日（まで）
                </label>
                <Input
                  id="receipt-search-date-to"
                  name="dateTo"
                  type="date"
                  defaultValue={search.dateTo}
                />
              </div>
              <div className={field}>
                <label htmlFor="receipt-search-amount-min" className={label}>
                  金額（以上）
                </label>
                <Input
                  id="receipt-search-amount-min"
                  name="amountMin"
                  inputMode="numeric"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  defaultValue={search.amountMin}
                  aria-invalid={amountErrors.min ? true : undefined}
                  aria-describedby="receipt-search-amount-min-error"
                />
                <FieldError
                  id="receipt-search-amount-min-error"
                  message={amountErrors.min ? AMOUNT_MESSAGE : undefined}
                />
              </div>
              <div className={field}>
                <label htmlFor="receipt-search-amount-max" className={label}>
                  金額（以下）
                </label>
                <Input
                  id="receipt-search-amount-max"
                  name="amountMax"
                  inputMode="numeric"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  defaultValue={search.amountMax}
                  aria-invalid={amountErrors.max ? true : undefined}
                  aria-describedby="receipt-search-amount-max-error"
                />
                <FieldError
                  id="receipt-search-amount-max-error"
                  message={amountErrors.max ? AMOUNT_MESSAGE : undefined}
                />
              </div>
              <div className={field}>
                <label htmlFor="receipt-search-partner" className={label}>
                  取引先
                </label>
                <Input
                  id="receipt-search-partner"
                  name="partner"
                  autoComplete="off"
                  defaultValue={search.partner}
                />
              </div>
              <div className={field}>
                <label htmlFor="receipt-search-category" className={label}>
                  区分
                </label>
                <NativeSelect
                  id="receipt-search-category"
                  name="category"
                  defaultValue={search.category ?? ""}
                >
                  <option value="">すべて</option>
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className={field}>
                <label htmlFor="receipt-search-link" className={label}>
                  結びつき
                </label>
                <NativeSelect id="receipt-search-link" name="link" defaultValue={search.link ?? ""}>
                  <option value="">すべて</option>
                  {LINK_OPTIONS.map((l) => (
                    <option key={l} value={l}>
                      {LINK_FILTER_LABELS[l]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div key={searchKey} className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="missing"
                    defaultChecked={search.missing}
                    className="size-4"
                  />
                  未入力があるものだけ
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="includeDeleted"
                    defaultChecked={search.includeDeleted}
                    className="size-4"
                  />
                  削除済みも表示
                </label>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setAmountErrors({});
                    onClear();
                  }}
                >
                  条件をクリア
                </Button>
                <Button type="submit">検索</Button>
              </div>
            </div>
          </form>
        </search>
      </CardContent>
    </Card>
  );
}
