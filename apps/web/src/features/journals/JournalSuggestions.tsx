import { useQuery } from "@tanstack/react-query";
import type { JournalSuggestion } from "@trebuchet/schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import type { Account } from "@/features/accounts/api";
import type { TaxCategory } from "@/features/entities/api";
import type { Partner } from "@/features/masters/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { journalSuggestionsQuery } from "./api";
import type { JournalFormControl } from "./JournalForm";

/**
 * 摘要・取引先に対する履歴の候補の状態。`pending` は入力の待ち（300ms）か読み込み中、
 * `found` は候補が出ている、`empty` は 0 件か失敗、`idle` は探す条件がない
 */
export type SuggestionStatus = "idle" | "pending" | "found" | "empty";

type Search = { memo: string; partnerId: string | undefined };
const NO_SEARCH: Search = { memo: "", partnerId: undefined };

export function JournalSuggestions({
  form,
  entityId,
  accounts,
  partners,
  taxCategories,
  onStatusChange,
}: {
  form: JournalFormControl;
  entityId: string;
  accounts: Account[];
  partners: Partner[];
  taxCategories: TaxCategory[];
  onStatusChange?: ((status: SuggestionStatus) => void) | undefined;
}) {
  const memo = useWatch({ control: form.control, name: "memo" }) ?? "";
  const lines = useWatch({ control: form.control, name: "lines" });
  // 取引先は、最後に変えた行の取引先を使う（取引先が入っていない行に変えたときは、最初の取引先）。
  // 行の取引先が変わったことを、前の描画の値との比較で見つけ、描画の中で状態を直す
  const partnerIds = lines.map((line) => line.partnerId ?? null);
  const [seenPartnerIds, setSeenPartnerIds] = useState(partnerIds);
  const [partnerId, setPartnerId] = useState(() => lines.find((line) => line.partnerId)?.partnerId);
  if (
    partnerIds.length !== seenPartnerIds.length ||
    partnerIds.some((id, index) => id !== seenPartnerIds[index])
  ) {
    setSeenPartnerIds(partnerIds);
    const changed = partnerIds.findLastIndex((id, index) => id !== seenPartnerIds[index]);
    if (changed >= 0)
      setPartnerId(partnerIds[changed] ?? partnerIds.find((id) => id !== null) ?? undefined);
  }
  const memoText = memo.length <= 200 ? memo.trim() : "";
  const search = useMemo(() => ({ memo: memoText, partnerId }), [memoText, partnerId]);
  // 入力が 300ms 止まってから探す。最初は何も探さない（`NO_SEARCH`）
  const debounced = useDebouncedValue(search, 300, NO_SEARCH);
  const ready = search === debounced && Boolean(debounced.memo || debounced.partnerId);
  const result = useQuery({
    ...journalSuggestionsQuery(entityId, {
      ...(debounced.memo && { memo: debounced.memo }),
      ...(debounced.partnerId && { partnerId: debounced.partnerId }),
    }),
    enabled: ready,
  });
  // 順序・重複排除・最大件数は server の契約をそのまま使う。
  const suggestions = ready ? (result.data ?? []) : [];
  const error = ready ? result.error : undefined;
  const wanted = Boolean(memoText || partnerId);
  const status: SuggestionStatus = !wanted
    ? "idle"
    : !ready || result.isPending
      ? "pending"
      : suggestions.length > 0
        ? "found"
        : "empty";
  const reportStatus = useRef(onStatusChange);
  reportStatus.current = onStatusChange;
  useEffect(() => {
    reportStatus.current?.(status);
  }, [status]);
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
