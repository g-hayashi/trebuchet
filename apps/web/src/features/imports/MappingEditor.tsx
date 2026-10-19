import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountMapping, MappingRow, TaxCategoryCode, TaxMapping } from "@trebuchet/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AccountCreateForm } from "@/features/accounts/AccountCreateForm";
import { groupAccountsBySection } from "@/lib/accounts";
import { type Account, queryKeys, subAccountsQuery, type TaxCategory } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { saveImportMappings } from "./api";
import { MAPPING_STATUS_LABELS } from "./labels";

/** 科目の対応先（未定なら accountId がない）。補助科目は既存の ID か、取込で作る名前のどちらか */
export type AccountTarget = {
  accountId?: string | undefined;
  subAccountId?: string | undefined;
  subAccountName?: string | undefined;
};
export type AccountEdits = Record<string, AccountTarget>;
export type TaxEdits = Record<string, TaxCategoryCode | undefined>;

const targetOf = (row: MappingRow): AccountTarget => ({
  accountId: row.accountId,
  subAccountId: row.subAccountId,
  subAccountName: row.subAccountName,
});

/** 保存する行: 利用者が変えた行と、案のままの行（画面で確かめた案）。対応先のない行は送らない */
export function mappingsToSave(
  mappings: { accounts: readonly MappingRow[]; taxes: readonly MappingRow[] },
  accountEdits: AccountEdits,
  taxEdits: TaxEdits,
): { accounts: AccountMapping[]; taxes: TaxMapping[] } {
  const accounts: AccountMapping[] = [];
  for (const row of mappings.accounts) {
    const edited = Object.hasOwn(accountEdits, row.sourceName);
    if (!edited && row.status !== "proposed") continue;
    const t = edited ? (accountEdits[row.sourceName] ?? {}) : targetOf(row);
    if (t.accountId === undefined) continue;
    accounts.push({
      sourceName: row.sourceName,
      accountId: t.accountId,
      ...(t.subAccountId !== undefined && { subAccountId: t.subAccountId }),
      ...(t.subAccountName !== undefined && { subAccountName: t.subAccountName }),
    });
  }
  const taxes: TaxMapping[] = [];
  for (const row of mappings.taxes) {
    const edited = Object.hasOwn(taxEdits, row.sourceName);
    if (!edited && row.status !== "proposed") continue;
    const taxCategory = edited ? taxEdits[row.sourceName] : row.taxCategory;
    if (taxCategory !== undefined) taxes.push({ sourceName: row.sourceName, taxCategory });
  }
  return { accounts, taxes };
}

/**
 * 対応表（FR-007〜011）。freee の科目・口座・税区分の名前ごとに、帳簿の科目・補助科目・税区分を選ぶ。
 * 選んだ値は親が持ち、「対応表を保存」で PUT /import-mappings に送ってから onSaved を呼ぶ
 */
export function MappingEditor({
  entityId,
  mappings,
  accounts,
  taxCategories,
  accountEdits,
  taxEdits,
  onAccountEdit,
  onTaxEdit,
  onSaved,
}: {
  entityId: string;
  mappings: { accounts: readonly MappingRow[]; taxes: readonly MappingRow[] };
  accounts: readonly Account[];
  taxCategories: readonly TaxCategory[];
  accountEdits: AccountEdits;
  taxEdits: TaxEdits;
  onAccountEdit: (sourceName: string, target: AccountTarget) => void;
  onTaxEdit: (sourceName: string, taxCategory: TaxCategoryCode | undefined) => void;
  onSaved: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [creatingFor, setCreatingFor] = useState<string>();
  const toSave = mappingsToSave(mappings, accountEdits, taxEdits);
  const save = useMutation({
    mutationFn: () =>
      saveImportMappings(entityId, {
        ...(toSave.accounts.length > 0 && { accounts: toSave.accounts }),
        ...(toSave.taxes.length > 0 && { taxes: toSave.taxes }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.importMappings(entityId) });
      await onSaved();
    },
  });
  const nothingToSave = toSave.accounts.length === 0 && toSave.taxes.length === 0;

  return (
    <div className="grid gap-6">
      <Table aria-label="勘定科目の対応表">
        <TableHeader>
          <TableRow>
            <TableHead>freee の勘定科目・口座</TableHead>
            <TableHead className="w-24">状態</TableHead>
            <TableHead>帳簿の勘定科目</TableHead>
            <TableHead>補助科目</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">操作</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {mappings.accounts.map((row) => {
            const edited = Object.hasOwn(accountEdits, row.sourceName);
            const target = edited ? (accountEdits[row.sourceName] ?? {}) : targetOf(row);
            return (
              <AccountMappingRow
                key={row.sourceName}
                entityId={entityId}
                row={row}
                edited={edited}
                target={target}
                accounts={accounts}
                onChange={(t) => onAccountEdit(row.sourceName, t)}
                onCreate={() => setCreatingFor(row.sourceName)}
              />
            );
          })}
        </TableBody>
      </Table>

      <Table aria-label="税区分の対応表">
        <TableHeader>
          <TableRow>
            <TableHead>freee の税区分</TableHead>
            <TableHead className="w-24">状態</TableHead>
            <TableHead>帳簿の税区分</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {mappings.taxes.map((row) => {
            const edited = Object.hasOwn(taxEdits, row.sourceName);
            const value = edited ? taxEdits[row.sourceName] : row.taxCategory;
            const missing = value === undefined;
            return (
              <TableRow
                key={row.sourceName}
                data-status={edited ? "edited" : row.status}
                className={cn(missing && "bg-destructive/10 hover:bg-destructive/15")}
              >
                <TableHead scope="row" className="font-normal text-foreground">
                  {row.sourceName}
                </TableHead>
                <TableCell>
                  <StatusLabel status={row.status} edited={edited} missing={missing} />
                </TableCell>
                <TableCell>
                  <NativeSelect
                    aria-label={`「${row.sourceName}」の税区分`}
                    aria-invalid={missing ? true : undefined}
                    className="h-8 max-w-64"
                    value={value ?? ""}
                    onChange={(e) => {
                      const code = taxCategories.find(
                        (c) => c.code === e.currentTarget.value,
                      )?.code;
                      onTaxEdit(row.sourceName, code);
                    }}
                  >
                    <option value="">選んでください</option>
                    {taxCategories.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </NativeSelect>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={nothingToSave || save.isPending}
          onClick={() => save.mutate()}
        >
          対応表を保存
        </Button>
        <p className="text-sm text-muted-foreground">
          保存すると、次の取込でも使います。保存の後にプレビューを作り直します。
        </p>
      </div>
      <ApiErrorMessage error={save.error} />

      <Dialog
        open={creatingFor !== undefined}
        onOpenChange={(open) => {
          if (!open) setCreatingFor(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新しい勘定科目</DialogTitle>
            <DialogDescription>
              「{creatingFor}」の対応先として帳簿に科目を作り、決算書の区分と欄に対応づけます。
            </DialogDescription>
          </DialogHeader>
          {creatingFor !== undefined && (
            <AccountCreateForm
              key={creatingFor}
              entityId={entityId}
              defaultName={creatingFor}
              submitLabel="作成して選ぶ"
              layout="stacked"
              onCreated={(account) => {
                onAccountEdit(creatingFor, { accountId: account.id });
                setCreatingFor(undefined);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusLabel({
  status,
  edited,
  missing,
}: {
  status: MappingRow["status"];
  edited: boolean;
  missing: boolean;
}) {
  if (edited)
    return (
      <span className={cn("text-sm", missing ? "text-destructive" : "text-amber-700")}>
        {missing ? "未定" : "未保存"}
      </span>
    );
  return (
    <span
      className={cn(
        "text-sm",
        status === "unmapped" && "font-semibold text-destructive",
        status === "proposed" && "text-amber-700",
        status === "saved" && "text-muted-foreground",
      )}
    >
      {MAPPING_STATUS_LABELS[status]}
    </span>
  );
}

function AccountMappingRow({
  entityId,
  row,
  edited,
  target,
  accounts,
  onChange,
  onCreate,
}: {
  entityId: string;
  row: MappingRow;
  edited: boolean;
  target: AccountTarget;
  accounts: readonly Account[];
  onChange: (target: AccountTarget) => void;
  onCreate: () => void;
}) {
  const missing = target.accountId === undefined;
  // 使用停止の科目は選べない。いま選ばれているものだけは表示する（ACCOUNT_INACTIVE の行）
  const choices = accounts.filter((a) => a.isActive || a.id === target.accountId);
  return (
    <TableRow
      data-status={edited ? "edited" : row.status}
      className={cn(missing && "bg-destructive/10 hover:bg-destructive/15")}
    >
      <TableHead scope="row" className="font-normal text-foreground">
        {row.sourceName}
      </TableHead>
      <TableCell>
        <StatusLabel status={row.status} edited={edited} missing={missing} />
      </TableCell>
      <TableCell>
        <NativeSelect
          aria-label={`「${row.sourceName}」の勘定科目`}
          aria-invalid={missing ? true : undefined}
          className="h-8 max-w-64"
          value={target.accountId ?? ""}
          onChange={(e) => {
            const accountId = e.currentTarget.value;
            onChange(accountId === "" ? {} : { accountId });
          }}
        >
          <option value="">選んでください</option>
          {groupAccountsBySection(choices).map((group) => (
            <optgroup key={group.section} label={group.label}>
              {group.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.isActive ? "" : "（使用停止）"}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
      </TableCell>
      <TableCell>
        {target.accountId !== undefined && (
          <SubAccountSelect
            entityId={entityId}
            sourceName={row.sourceName}
            target={{ ...target, accountId: target.accountId }}
            onChange={onChange}
          />
        )}
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="sm" onClick={onCreate}>
          新しい科目を作る
          <span className="sr-only">（{row.sourceName}）</span>
        </Button>
      </TableCell>
    </TableRow>
  );
}

const NEW_PREFIX = "new:";
const ID_PREFIX = "id:";

function SubAccountSelect({
  entityId,
  sourceName,
  target,
  onChange,
}: {
  entityId: string;
  sourceName: string;
  target: AccountTarget & { accountId: string };
  onChange: (target: AccountTarget) => void;
}) {
  const { data: subAccounts } = useQuery(subAccountsQuery(entityId, target.accountId));
  const value =
    target.subAccountId !== undefined
      ? `${ID_PREFIX}${target.subAccountId}`
      : target.subAccountName !== undefined
        ? `${NEW_PREFIX}${target.subAccountName}`
        : "";
  return (
    <NativeSelect
      aria-label={`「${sourceName}」の補助科目`}
      className="h-8 max-w-56"
      value={value}
      onChange={(e) => {
        const v = e.currentTarget.value;
        onChange({
          accountId: target.accountId,
          ...(v.startsWith(ID_PREFIX) && { subAccountId: v.slice(ID_PREFIX.length) }),
          ...(v.startsWith(NEW_PREFIX) && { subAccountName: v.slice(NEW_PREFIX.length) }),
        });
      }}
    >
      <option value="">（なし）</option>
      {subAccounts
        ?.filter((s) => s.isActive || s.id === target.subAccountId)
        .map((s) => (
          <option key={s.id} value={`${ID_PREFIX}${s.id}`}>
            {s.name}
          </option>
        ))}
      {target.subAccountName !== undefined && (
        <option value={`${NEW_PREFIX}${target.subAccountName}`}>
          {target.subAccountName}（取込で作る）
        </option>
      )}
    </NativeSelect>
  );
}
