import { useQuery } from "@tanstack/react-query";
import type { JournalSuggestion } from "@trebuchet/schema";
import { useEffect, useRef, useState } from "react";
import { useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import type { Account } from "@/features/accounts/api";
import type { TaxCategory } from "@/features/entities/api";
import type { Partner } from "@/features/masters/api";
import { journalSuggestionsQuery } from "./api";
import type { JournalFormControl } from "./JournalForm";

export function JournalSuggestions({
  form,
  entityId,
  accounts,
  partners,
  taxCategories,
}: {
  form: JournalFormControl;
  entityId: string;
  accounts: Account[];
  partners: Partner[];
  taxCategories: TaxCategory[];
}) {
  const memo = useWatch({ control: form.control, name: "memo" }) ?? "";
  const lines = useWatch({ control: form.control, name: "lines" });
  const partnerIds = JSON.stringify(lines.map((line) => line.partnerId ?? null));
  const previousPartners = useRef(partnerIds);
  const [partnerId, setPartnerId] = useState(() => lines.find((line) => line.partnerId)?.partnerId);
  useEffect(() => {
    const previous = JSON.parse(previousPartners.current) as (string | null)[];
    const current = JSON.parse(partnerIds) as (string | null)[];
    const changed = current
      .map((id, index) => (id !== previous[index] ? index : -1))
      .filter((index) => index >= 0)
      .at(-1);
    if (changed !== undefined)
      setPartnerId(current[changed] ?? current.find((id) => id !== null) ?? undefined);
    previousPartners.current = partnerIds;
  }, [partnerIds]);
  const search = JSON.stringify({ memo: memo.length <= 200 ? memo.trim() : "", partnerId });
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const query = (debounced ? JSON.parse(debounced) : { memo: "" }) as {
    memo: string;
    partnerId?: string | undefined;
  };
  const ready = search === debounced && Boolean(query.memo || query.partnerId);
  const result = useQuery({
    ...journalSuggestionsQuery(entityId, {
      ...(query.memo && { memo: query.memo }),
      ...(query.partnerId && { partnerId: query.partnerId }),
    }),
    enabled: ready,
  });
  // 順序・重複排除・最大件数は server の契約をそのまま使う。
  const suggestions = ready ? (result.data ?? []) : [];
  const error = ready ? result.error : undefined;
  const usable = (item: JournalSuggestion) =>
    lines.length === 2 &&
    lines.filter((line) => line.side === "debit").length === 1 &&
    lines.every(
      (line) =>
        !line.subAccountId ||
        line.accountId === (line.side === "debit" ? item.debitAccountId : item.creditAccountId),
    ) &&
    [item.debitAccountId, item.creditAccountId].every((id) =>
      accounts.some((account) => account.id === id && account.isActive),
    ) &&
    [item.debitPartnerId, item.creditPartnerId].every(
      (id) => id === null || partners.some((partner) => partner.id === id && partner.isActive),
    ) &&
    [item.debitTaxCategory, item.creditTaxCategory].every((code) =>
      taxCategories.some((tax) => tax.code === code),
    );
  function apply(item: JournalSuggestion) {
    if (!usable(item) || search !== debounced) return;
    lines.forEach((line, index) => {
      const debit = line.side === "debit";
      form.setValue(
        `lines.${index}.accountId`,
        debit ? item.debitAccountId : item.creditAccountId,
        { shouldDirty: true },
      );
      form.setValue(
        `lines.${index}.taxCategory`,
        debit ? item.debitTaxCategory : item.creditTaxCategory,
        { shouldDirty: true },
      );
      form.setValue(
        `lines.${index}.partnerId`,
        (debit ? item.debitPartnerId : item.creditPartnerId) ?? undefined,
        { shouldDirty: true },
      );
    });
  }
  if (!suggestions.length && !error) return null;
  return (
    <section aria-label="履歴の候補" className="grid gap-2 rounded-md border p-3">
      <h3 className="text-sm font-medium">履歴の候補</h3>
      <ApiErrorMessage error={error} />
      {error && (
        <Button variant="outline" onClick={() => void result.refetch()}>
          履歴候補を再試行
        </Button>
      )}
      {suggestions.map((item, index) => (
        <div key={item.sourceJournalId} className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {item.date} ·{" "}
            {accounts.find((account) => account.id === item.debitAccountId)?.name ?? "不明な科目"}{" "}
            ／{" "}
            {accounts.find((account) => account.id === item.creditAccountId)?.name ?? "不明な科目"}
          </span>
          <Button variant="outline" size="sm" disabled={!usable(item)} onClick={() => apply(item)}>
            候補{index + 1}を入れる
          </Button>
          {!usable(item) && (
            <span className="text-muted-foreground">
              科目・取引先が使用できない候補や、補助科目・複数行の情報が失われる入力には使えません。
            </span>
          )}
        </div>
      ))}
    </section>
  );
}
