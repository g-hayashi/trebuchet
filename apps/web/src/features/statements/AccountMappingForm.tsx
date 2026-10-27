import { useQuery } from "@tanstack/react-query";
import {
  STATEMENT_ACCOUNT_KINDS,
  STATEMENT_ACCOUNT_USAGES,
  type StatementAccountKind,
  type StatementAccountSuggestion,
  type StatementAccountUsage,
} from "@trebuchet/schema";
import { useId } from "react";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { accountsQuery, subAccountsQuery } from "@/features/accounts/api";
import type { AccountDraft } from "./account-draft";
import { KIND_LABELS, USAGE_LABELS } from "./labels";

/**
 * 取込元の口座（明細の口座名）の対応（FR-003、007 US3）: 用途・種類・科目・補助科目。
 * 値は親（取込の画面）が持ち、確定のときに commit の `accounts` でまとめて送る。保存のボタンはない。
 * 案（`suggestion`）があれば、推定であることと手がかりの語を示す。
 * `private`（帳簿の外の口座）は科目を持たないので、科目と補助科目を出さない
 */
export function AccountMappingForm({
  entityId,
  name,
  suggestion,
  value,
  onChange,
}: {
  entityId: string;
  /** 明細の口座名 */
  name: string;
  suggestion: StatementAccountSuggestion | null;
  value: AccountDraft;
  onChange: (next: AccountDraft) => void;
}) {
  const id = useId();
  const accounts = useQuery(accountsQuery(entityId));
  const subAccounts = useQuery({
    ...subAccountsQuery(entityId, value.accountId),
    enabled: value.accountId !== "" && value.usage !== "private",
  });
  const isPrivate = value.usage === "private";

  return (
    <fieldset
      aria-label={`${name}の対応`}
      className="grid gap-3 rounded-md border px-3 py-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <legend className="px-1 text-sm font-medium">{name}</legend>
      {suggestion && (
        <p className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-4">
          {`推定: ${KIND_LABELS[suggestion.kind]}${
            suggestion.cues.length > 0 ? `（手がかり: ${suggestion.cues.join("、")}）` : ""
          }`}
        </p>
      )}
      <div className="grid content-start gap-1">
        <Label htmlFor={`${id}-usage`}>{name}の用途</Label>
        <NativeSelect
          id={`${id}-usage`}
          value={value.usage}
          onChange={(e) =>
            onChange({ ...value, usage: e.target.value as StatementAccountUsage | "" })
          }
        >
          <option value="">選んでください</option>
          {STATEMENT_ACCOUNT_USAGES.map((u) => (
            <option key={u} value={u}>
              {USAGE_LABELS[u]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid content-start gap-1">
        <Label htmlFor={`${id}-kind`}>{name}の種類</Label>
        <NativeSelect
          id={`${id}-kind`}
          value={value.kind}
          onChange={(e) =>
            onChange({ ...value, kind: e.target.value as StatementAccountKind | "" })
          }
        >
          <option value="">選んでください</option>
          {STATEMENT_ACCOUNT_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {!isPrivate && (
        <>
          <div className="grid content-start gap-1">
            <Label htmlFor={`${id}-account`}>{name}の科目</Label>
            <NativeSelect
              id={`${id}-account`}
              value={value.accountId}
              onChange={(e) => onChange({ ...value, accountId: e.target.value, subAccountId: "" })}
            >
              <option value="">選んでください</option>
              {accounts.data
                ?.filter((a) => a.isActive)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </NativeSelect>
          </div>
          <div className="grid content-start gap-1">
            <Label htmlFor={`${id}-sub`}>{name}の補助科目</Label>
            <NativeSelect
              id={`${id}-sub`}
              value={value.subAccountId}
              disabled={value.accountId === ""}
              onChange={(e) => onChange({ ...value, subAccountId: e.target.value })}
            >
              <option value="">なし</option>
              {subAccounts.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </>
      )}
    </fieldset>
  );
}
