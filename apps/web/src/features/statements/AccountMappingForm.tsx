import { useQuery } from "@tanstack/react-query";
import {
  STATEMENT_ACCOUNT_KINDS,
  STATEMENT_ACCOUNT_USAGES,
  type StatementAccountInput,
  type StatementAccountKind,
  type StatementAccountUsage,
} from "@trebuchet/schema";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { accountsQuery, subAccountsQuery } from "@/features/accounts/api";
import { KIND_LABELS, USAGE_LABELS } from "./labels";

/**
 * 取込元の口座（MF ME の保有金融機関）の対応（FR-003、R4）: 用途・種類・科目・補助科目。
 * `private`（帳簿の外の口座）は科目を持たないので、科目と補助科目を出さない
 */
export function AccountMappingForm({
  entityId,
  name,
  saving,
  error,
  onSave,
}: {
  entityId: string;
  /** 保有金融機関の名前 */
  name: string;
  saving: boolean;
  error: unknown;
  onSave: (name: string, input: StatementAccountInput) => void;
}) {
  const id = useId();
  const [usage, setUsage] = useState<StatementAccountUsage>("business");
  const [kind, setKind] = useState<StatementAccountKind>("bank");
  const [accountId, setAccountId] = useState("");
  const [subAccountId, setSubAccountId] = useState("");
  const [accountError, setAccountError] = useState<string | undefined>();

  const accounts = useQuery(accountsQuery(entityId));
  const subAccounts = useQuery({
    ...subAccountsQuery(entityId, accountId),
    enabled: accountId !== "",
  });
  const isPrivate = usage === "private";

  const submit = () => {
    if (isPrivate) {
      setAccountError(undefined);
      onSave(name, { usage, kind });
      return;
    }
    if (accountId === "") {
      setAccountError("科目を選んでください");
      return;
    }
    setAccountError(undefined);
    onSave(name, {
      usage,
      kind,
      accountId,
      ...(subAccountId === "" ? {} : { subAccountId }),
    });
  };

  return (
    <fieldset
      aria-label={`${name}の対応`}
      className="grid gap-3 rounded-md border px-3 py-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <legend className="px-1 text-sm font-medium">{name}</legend>
      <div className="grid content-start gap-1">
        <Label htmlFor={`${id}-usage`}>{name}の用途</Label>
        <NativeSelect
          id={`${id}-usage`}
          value={usage}
          onChange={(e) => {
            setUsage(e.target.value as StatementAccountUsage);
            setAccountError(undefined);
          }}
        >
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
          value={kind}
          onChange={(e) => setKind(e.target.value as StatementAccountKind)}
        >
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
              value={accountId}
              aria-invalid={accountError ? true : undefined}
              aria-describedby={`${id}-account-error`}
              onChange={(e) => {
                setAccountId(e.target.value);
                setSubAccountId("");
                setAccountError(undefined);
              }}
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
            <FieldError id={`${id}-account-error`} message={accountError} />
          </div>
          <div className="grid content-start gap-1">
            <Label htmlFor={`${id}-sub`}>{name}の補助科目</Label>
            <NativeSelect
              id={`${id}-sub`}
              value={subAccountId}
              disabled={accountId === ""}
              onChange={(e) => setSubAccountId(e.target.value)}
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
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
        <Button type="button" disabled={saving} onClick={submit} aria-label={`${name}の対応を保存`}>
          対応を保存
        </Button>
      </div>
      <ApiErrorMessage error={error} className="sm:col-span-2 lg:col-span-4" />
    </fieldset>
  );
}
