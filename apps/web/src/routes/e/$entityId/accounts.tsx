import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AccountPatch, SubAccountCreate } from "@trebuchet/schema";
import { Fragment, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AccountCreateForm } from "@/features/accounts/AccountCreateForm";
import { CATEGORY_LABELS, groupAccountsBySection } from "@/lib/accounts";
import { api, unwrap } from "@/lib/api";
import { type Account, accountsQuery, queryKeys, subAccountsQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/e/$entityId/accounts")({
  component: AccountsPage,
});

const accountApi = api.api.entities[":entityId"].accounts;

function AccountsPage() {
  const { entityId } = Route.useParams();
  const { data: accounts, isPending, error } = useQuery(accountsQuery(entityId));
  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">勘定科目</h1>
      <AddAccountForm entityId={entityId} />
      <ApiErrorMessage error={error} />
      {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {accounts && (
        <Card>
          <CardHeader>
            <CardTitle>科目の一覧</CardTitle>
            <CardDescription>
              青色申告決算書の順に並んでいます。使用停止の科目は薄く表示されます。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">コード</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-20">区分</TableHead>
                  <TableHead className="w-24 text-right">決算書の欄</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              {groupAccountsBySection(accounts).map((group) => (
                <TableBody key={group.section}>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead colSpan={5} scope="colgroup" className="text-foreground">
                      {group.label}
                    </TableHead>
                  </TableRow>
                  {group.accounts.map((account) => (
                    <AccountRow key={account.id} entityId={entityId} account={account} />
                  ))}
                </TableBody>
              ))}
            </Table>
          </CardContent>
        </Card>
      )}
    </main>
  );
}

function AddAccountForm({ entityId }: { entityId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>科目を追加</CardTitle>
      </CardHeader>
      <CardContent>
        <AccountCreateForm entityId={entityId} submitLabel="追加する" layout="inline" />
      </CardContent>
    </Card>
  );
}

function AccountRow({ entityId, account }: { entityId: string; account: Account }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showSubAccounts, setShowSubAccounts] = useState(false);
  const param = { entityId, accountId: account.id };
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.accounts(entityId) });

  const patch = useMutation({
    mutationFn: async (json: AccountPatch) =>
      unwrap(await accountApi[":accountId"].$patch({ param, json })),
    onSuccess: async () => {
      setEditing(false);
      await invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: async () => unwrap(await accountApi[":accountId"].$delete({ param })),
    onSuccess: invalidate,
  });
  const error = patch.error ?? remove.error;

  return (
    <Fragment>
      <TableRow className={cn(!account.isActive && "opacity-50")}>
        <TableCell className="font-mono text-muted-foreground">{account.code}</TableCell>
        <TableCell>
          {editing ? (
            <RenameForm
              account={account}
              pending={patch.isPending}
              onSubmit={(name) => patch.mutate({ name })}
              onCancel={() => {
                setEditing(false);
                patch.reset();
              }}
            />
          ) : (
            <span>
              {account.name}
              {!account.isActive && (
                <span className="ml-2 text-xs text-muted-foreground">（使用停止）</span>
              )}
            </span>
          )}
        </TableCell>
        <TableCell>{CATEGORY_LABELS[account.category]}</TableCell>
        <TableCell className="text-right tabular-nums">
          {account.category === "expense" ? (
            <ReportLineSelect
              account={account}
              pending={patch.isPending}
              onChange={(reportLine) => patch.mutate({ reportLine })}
            />
          ) : (
            (account.reportLine ?? "")
          )}
        </TableCell>
        <TableCell>
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showSubAccounts}
              onClick={() => setShowSubAccounts((v) => !v)}
            >
              補助科目
              <span className="sr-only">（{account.name}）</span>
            </Button>
            {!editing && (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                名称変更
                <span className="sr-only">（{account.name}）</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ isActive: !account.isActive })}
            >
              {account.isActive ? "使用停止" : "使用再開"}
              <span className="sr-only">（{account.name}）</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`「${account.name}」を削除しますか？`)) remove.mutate();
              }}
            >
              削除
              <span className="sr-only">（{account.name}）</span>
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {error ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5}>
            <ApiErrorMessage error={error} />
          </TableCell>
        </TableRow>
      ) : null}
      {showSubAccounts && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="pl-8">
            <SubAccountsPanel entityId={entityId} account={account} />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

/** 費用の科目の決算書の欄（青色申告決算書 1ページの欄 8〜31）。選ぶとすぐ保存する（FR-006） */
const REPORT_LINE_CHOICES = Array.from({ length: 24 }, (_, i) => i + 8);

function ReportLineSelect({
  account,
  pending,
  onChange,
}: {
  account: Account;
  pending: boolean;
  onChange: (reportLine: number | null) => void;
}) {
  return (
    <NativeSelect
      aria-label={`決算書の欄（${account.name}）`}
      className="h-8 w-20"
      disabled={pending}
      value={account.reportLine === null ? "" : String(account.reportLine)}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    >
      <option value="">なし</option>
      {REPORT_LINE_CHOICES.map((n) => (
        <option key={n} value={String(n)}>
          {n}
        </option>
      ))}
    </NativeSelect>
  );
}

function RenameForm({
  account,
  pending,
  onSubmit,
  onCancel,
}: {
  account: Account;
  pending: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const form = useForm<z.input<typeof AccountPatch>, unknown, AccountPatch>({
    resolver: zodResolver(AccountPatch),
    defaultValues: { name: account.name },
  });
  const id = `rename-${account.id}`;
  const message = form.formState.errors.name?.message;
  return (
    <form
      noValidate
      className="flex flex-wrap items-center gap-2"
      onSubmit={form.handleSubmit((v) => {
        if (v.name !== undefined) onSubmit(v.name);
      })}
    >
      <Label htmlFor={id} className="sr-only">
        「{account.name}」の新しい名称
      </Label>
      <Input
        id={id}
        className="h-8 max-w-60"
        autoFocus
        aria-invalid={message ? true : undefined}
        aria-describedby={`${id}-error`}
        {...form.register("name")}
      />
      <Button type="submit" size="sm" disabled={pending}>
        保存
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        取消
      </Button>
      <FieldError id={`${id}-error`} message={message} />
    </form>
  );
}

function SubAccountsPanel({ entityId, account }: { entityId: string; account: Account }) {
  const queryClient = useQueryClient();
  const { data: subAccounts, isPending, error } = useQuery(subAccountsQuery(entityId, account.id));
  const form = useForm<z.input<typeof SubAccountCreate>, unknown, SubAccountCreate>({
    resolver: zodResolver(SubAccountCreate),
    defaultValues: { name: "" },
  });
  const create = useMutation({
    mutationFn: async (json: SubAccountCreate) =>
      unwrap(
        await accountApi[":accountId"]["sub-accounts"].$post({
          param: { entityId, accountId: account.id },
          json,
        }),
      ),
    onSuccess: async () => {
      form.reset({ name: "" });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.subAccounts(entityId, account.id),
      });
    },
  });
  const id = `sub-account-${account.id}`;
  const message = form.formState.errors.name?.message;

  return (
    <div className="grid gap-3">
      <ApiErrorMessage error={error} />
      {isPending ? (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      ) : subAccounts && subAccounts.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={`「${account.name}」の補助科目`}>
          {subAccounts.map((s) => (
            <li
              key={s.id}
              className={cn("rounded-md border px-2 py-1 text-sm", !s.isActive && "opacity-50")}
            >
              {s.name}
            </li>
          ))}
        </ul>
      ) : (
        subAccounts && <p className="text-sm text-muted-foreground">補助科目はありません。</p>
      )}
      <form
        noValidate
        className="flex flex-wrap items-center gap-2"
        onSubmit={form.handleSubmit((v) => create.mutate(v))}
      >
        <Label htmlFor={id}>補助科目を追加</Label>
        <Input
          id={id}
          className="h-8 max-w-60"
          placeholder="例: ○○銀行"
          aria-invalid={message ? true : undefined}
          aria-describedby={`${id}-error`}
          {...form.register("name")}
        />
        <Button type="submit" size="sm" disabled={create.isPending}>
          追加
        </Button>
        <FieldError id={`${id}-error`} message={message} />
      </form>
      <ApiErrorMessage error={create.error} />
    </div>
  );
}
