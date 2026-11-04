import { defaultTaxCategory } from "@trebuchet/schema";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { useWatch } from "react-hook-form";
import { Combobox } from "@/components/ui/combobox";
import { FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import type { Account } from "@/features/accounts/api";
import { AiSuggestionPanel } from "@/features/ai-assist/AiSuggestionPanel";
import type { TaxCategory, TaxSetting } from "@/features/entities/api";
import type { Partner, Tag } from "@/features/masters/api";
import { matchesAccount } from "@/lib/account-search";
import { parseYenInput } from "@/lib/format";
import { CreateFiscalPeriodLink } from "./CreateFiscalPeriodLink";
import type { JournalFormControl } from "./JournalForm";
import type { SuggestionStatus } from "./JournalSuggestions";

/**
 * 摘要の Enter の行き先。履歴の候補が出ていれば先頭の使えるボタンへ焦点を移し、なければ登録する
 */
function settleEnter(root: HTMLElement | null, status: SuggestionStatus) {
  const form = root?.querySelector<HTMLElement>("#quick-memo")?.closest("form");
  const button =
    status === "found"
      ? form?.querySelector<HTMLElement>('section[aria-label="履歴の候補"] button:not(:disabled)')
      : null;
  if (button) button.focus();
  else form?.requestSubmit();
}

/** 詳細入力と同じフォームの値を使うため、切替でも未完成の入力を保つ。 */
export function QuickEntryForm({
  form,
  accounts,
  partners,
  tags,
  taxSettings,
  taxCategories,
  focusAfterSave,
  entityId,
  suggestPeriod,
  suggestionStatus = "idle",
}: {
  form: JournalFormControl;
  accounts: Account[];
  partners: Partner[];
  tags: Tag[];
  taxSettings: TaxSetting[];
  taxCategories: TaxCategory[];
  focusAfterSave: boolean;
  entityId: string;
  /** サーバーが会計期間の作成を提案したとき、日付の下にリンクを出す */
  suggestPeriod: boolean;
  /** 摘要の履歴の候補の状態。摘要の Enter で、登録の前に候補を見せるかを決める */
  suggestionStatus?: SuggestionStatus | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const values = useWatch({ control: form.control });
  const errors = form.formState.errors;
  const focus = (id: string) => root.current?.querySelector<HTMLElement>(`#quick-${id}`)?.focus();
  /** 履歴の候補の読み込みを待って Enter を処理する（候補が出たら焦点を移し、なければ登録する） */
  const waitingForSuggestions = useRef(false);
  useEffect(() => {
    if (!waitingForSuggestions.current || suggestionStatus === "pending") return;
    waitingForSuggestions.current = false;
    settleEnter(root.current, suggestionStatus);
  }, [suggestionStatus]);
  useEffect(() => {
    if (focusAfterSave) root.current?.querySelector<HTMLElement>("#quick-account-0")?.focus();
  }, [focusAfterSave]);
  const activeAccounts = accounts.filter((account) => account.isActive);
  const activePartners = partners.filter((partner) => partner.isActive);
  function next(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    // 開いた combobox は確定処理自身がフォーカスを動かす。
    if (
      target.getAttribute("role") === "combobox" &&
      target.getAttribute("aria-expanded") === "true"
    )
      return;
    const fields = Array.from(
      root.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select") ?? [],
    ).filter(
      (field) => !field.disabled && (!field.closest("details") || field.closest("details")?.open),
    );
    const index = fields.indexOf(target as HTMLInputElement);
    if (index < 0) return;
    event.preventDefault();
    const following = fields[index + 1];
    if (following) {
      following.focus();
      return;
    }
    // 摘要は主な欄の最後。履歴の候補が出ている（読み込み中を含む）なら、登録の前に候補を見せる。
    if (target.id === "quick-memo" && (target as HTMLInputElement).value.trim() !== "") {
      if (suggestionStatus === "pending") {
        waitingForSuggestions.current = true;
        return;
      }
      if (suggestionStatus === "found") {
        settleEnter(root.current, "found");
        return;
      }
    }
    target.closest("form")?.requestSubmit();
  }
  return (
    <div ref={root} className="grid gap-4">
      <div className="grid gap-1 sm:max-w-48">
        <label htmlFor="quick-date" className="text-sm font-medium">
          日付
        </label>
        <Input
          id="quick-date"
          type="date"
          autoFocus={!focusAfterSave}
          onKeyDown={next}
          {...form.register("date")}
          aria-invalid={!!errors.date || undefined}
          aria-describedby="quick-date-error"
        />
        <FieldError id="quick-date-error" message={errors.date?.message} />
        {suggestPeriod && <CreateFiscalPeriodLink entityId={entityId} />}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {(["借方", "貸方"] as const).map((side, index) => (
          <div key={side} className="grid gap-1">
            <label htmlFor={`quick-account-${index}`} className="text-sm font-medium">
              {side}科目
            </label>
            <Combobox
              onKeyDown={next}
              id={`quick-account-${index}`}
              options={activeAccounts}
              value={
                accounts.find((account) => account.id === values.lines?.[index]?.accountId) ?? null
              }
              onChange={(account) =>
                form.setValue(`lines.${index}.accountId`, account?.id ?? "", { shouldDirty: true })
              }
              onCommit={() => focus(index === 0 ? "account-1" : "amount")}
              match={matchesAccount}
              getKey={(account) => account.id}
              getLabel={(account) => `${account.code} ${account.name}`}
              emptyMessage="該当する科目がありません"
              aria-invalid={!!errors.lines?.[index]?.accountId || undefined}
              aria-describedby={`quick-account-${index}-error`}
            />
            <FieldError
              id={`quick-account-${index}-error`}
              message={errors.lines?.[index]?.accountId?.message}
            />
          </div>
        ))}
      </div>
      <div className="grid gap-1 sm:max-w-64">
        <label htmlFor="quick-amount" className="text-sm font-medium">
          金額
        </label>
        <Input
          id="quick-amount"
          onKeyDown={next}
          inputMode="numeric"
          autoComplete="off"
          className="text-right tabular-nums"
          {...form.register("lines.0.amount", {
            setValueAs: (value: unknown) =>
              typeof value === "string" ? parseYenInput(value) : value,
            onChange: () =>
              form.setValue("lines.1.amount", form.getValues("lines.0.amount"), {
                shouldDirty: true,
              }),
            onBlur: () => {},
          })}
          aria-invalid={!!errors.lines?.[0]?.amount || undefined}
          aria-describedby="quick-amount-error"
        />
        <FieldError
          id="quick-amount-error"
          message={errors.lines?.[0]?.amount?.message ?? errors.lines?.[1]?.amount?.message}
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor="quick-memo" className="text-sm font-medium">
          摘要
        </label>
        <Input
          id="quick-memo"
          onKeyDown={next}
          onInput={() => {
            waitingForSuggestions.current = false;
          }}
          {...form.register("memo", { setValueAs: (value) => (value === "" ? undefined : value) })}
          aria-invalid={!!errors.memo || undefined}
          aria-describedby="quick-memo-error"
        />
        <FieldError id="quick-memo-error" message={errors.memo?.message} />
      </div>
      <AiSuggestionPanel
        scene="journal_entry"
        form={form}
        entityId={entityId}
        accounts={accounts}
        taxCategories={taxCategories}
      />
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">任意項目</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {(["借方", "貸方"] as const).map((side, index) => {
            const auto = defaultTaxCategory(
              values.date ?? "",
              accounts.find((account) => account.id === values.lines?.[index]?.accountId),
              taxSettings,
            );
            return (
              <div key={side} className="grid content-start gap-3">
                <div className="grid gap-1">
                  <label htmlFor={`quick-partner-${index}`} className="text-sm">
                    {side}取引先
                  </label>
                  <Combobox
                    onKeyDown={next}
                    id={`quick-partner-${index}`}
                    options={activePartners}
                    value={
                      partners.find((partner) => partner.id === values.lines?.[index]?.partnerId) ??
                      null
                    }
                    onChange={(partner) =>
                      form.setValue(`lines.${index}.partnerId`, partner?.id, { shouldDirty: true })
                    }
                    onCommit={() => focus(`tax-${index}`)}
                    match={(partner, query) =>
                      partner.name
                        .normalize("NFKC")
                        .toLowerCase()
                        .includes(query.normalize("NFKC").toLowerCase().trim())
                    }
                    getKey={(partner) => partner.id}
                    getLabel={(partner) => partner.name}
                    emptyMessage="該当する取引先がありません"
                    aria-describedby={`quick-partner-${index}-error`}
                    aria-invalid={!!errors.lines?.[index]?.partnerId || undefined}
                  />
                  <FieldError
                    id={`quick-partner-${index}-error`}
                    message={errors.lines?.[index]?.partnerId?.message}
                  />
                </div>
                <div className="grid gap-1">
                  <label htmlFor={`quick-tax-${index}`} className="text-sm">
                    {side}税区分
                  </label>
                  <NativeSelect
                    onKeyDown={next}
                    id={`quick-tax-${index}`}
                    aria-describedby={`quick-tax-${index}-error`}
                    aria-invalid={!!errors.lines?.[index]?.taxCategory || undefined}
                    {...form.register(`lines.${index}.taxCategory`, {
                      setValueAs: (value) => (value === "" ? undefined : value),
                    })}
                  >
                    <option value="">
                      自動（{taxCategories.find((tax) => tax.code === auto)?.name ?? auto}）
                    </option>
                    {taxCategories.map((tax) => (
                      <option key={tax.code} value={tax.code}>
                        {tax.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <FieldError
                    id={`quick-tax-${index}-error`}
                    message={errors.lines?.[index]?.taxCategory?.message}
                  />
                </div>
              </div>
            );
          })}
          <div className="grid gap-1">
            <label htmlFor="quick-tags" className="text-sm">
              タグ
            </label>
            <NativeSelect
              onKeyDown={next}
              id="quick-tags"
              multiple
              disabled={!tags.length}
              className="h-auto py-1"
              aria-describedby="quick-tags-error"
              {...form.register("lines.0.tagIds", {
                onChange: () =>
                  form.setValue("lines.1.tagIds", form.getValues("lines.0.tagIds"), {
                    shouldDirty: true,
                  }),
              })}
            >
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </NativeSelect>
            <FieldError
              id="quick-tags-error"
              message={errors.lines?.[0]?.tagIds?.message ?? errors.lines?.[1]?.tagIds?.message}
            />
          </div>
        </div>
      </details>
    </div>
  );
}
