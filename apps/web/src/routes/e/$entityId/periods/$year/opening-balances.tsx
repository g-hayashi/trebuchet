import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { OpeningBalanceInput, type OpeningBalancesPut, Side, Yen } from "@trebuchet/schema";
import { useMemo } from "react";
import {
  type Control,
  type UseFormReturn,
  useFieldArray,
  useForm,
  useWatch,
} from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { groupAccountsBySection } from "@/lib/accounts";
import { api, unwrap } from "@/lib/api";
import { formatYen, parseYenInput } from "@/lib/format";
import { openingTotals } from "@/lib/opening-balances";
import {
  type Account,
  accountsQuery,
  type OpeningBalancesData,
  openingBalancesQuery,
  queryKeys,
  subAccountsQuery,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/e/$entityId/periods/$year/opening-balances")({
  component: OpeningBalancesPage,
});

const SIDE_LABELS: Record<Side, string> = { debit: "借方", credit: "貸方" };

/** 共有スキーマの行。入力途中の金額（未入力 = undefined）を型として許し、検証は Yen で行う */
const FormSchema = z.object({
  rows: z.array(
    OpeningBalanceInput.extend({
      amount: z.preprocess<number | undefined, typeof Yen, number | undefined>((v) => v, Yen),
    }),
  ),
});
type FormInput = z.input<typeof FormSchema>;
type FormOutput = z.output<typeof FormSchema>;

const toFormRows = (data: OpeningBalancesData): FormInput["rows"] =>
  data.openingBalances.map((b) => ({
    accountId: b.accountId,
    subAccountId: b.subAccountId ?? undefined,
    side: b.side,
    amount: b.amount,
  }));

function OpeningBalancesPage() {
  const { entityId, year } = Route.useParams();
  const balances = useQuery(openingBalancesQuery(entityId, year));
  const accounts = useQuery(accountsQuery(entityId));
  const error = balances.error ?? accounts.error;

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">{year}年度の期首残高</h1>
        <Link
          to="/e/$entityId/periods"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          会計期間の一覧へ
        </Link>
      </div>
      <ApiErrorMessage error={error} />
      {(balances.isPending || accounts.isPending) && !error && (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      )}
      {balances.data && accounts.data && (
        <OpeningBalancesForm
          key={balances.data.fiscalPeriod.id}
          entityId={entityId}
          year={year}
          data={balances.data}
          accounts={accounts.data}
        />
      )}
    </main>
  );
}

function OpeningBalancesForm({
  entityId,
  year,
  data,
  accounts,
}: {
  entityId: string;
  year: string;
  data: OpeningBalancesData;
  accounts: Account[];
}) {
  const queryClient = useQueryClient();
  const closed = data.fiscalPeriod.status === "closed";
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(FormSchema),
    defaultValues: { rows: toFormRows(data) },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "rows" });

  const save = useMutation({
    mutationFn: async (json: OpeningBalancesPut) =>
      unwrap(
        await api.api.entities[":entityId"]["fiscal-periods"][":year"]["opening-balances"].$put({
          param: { entityId, year },
          json,
        }),
      ),
    onSuccess: async (saved) => {
      queryClient.setQueryData(queryKeys.openingBalances(entityId, year), saved);
      form.reset({ rows: toFormRows(saved) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.openingBalances(entityId, year) });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {data.fiscalPeriod.startDate} 時点の残高
          {closed && <span className="ml-2 text-sm text-muted-foreground">（締め済み）</span>}
        </CardTitle>
        <CardDescription>
          科目・補助科目ごとに金額を入力します。借方合計と貸方合計が一致すると保存できます。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          aria-label="期首残高"
          onSubmit={form.handleSubmit((values) => save.mutate(values.rows))}
        >
          <fieldset disabled={closed || save.isPending} className="grid gap-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>勘定科目</TableHead>
                  <TableHead>補助科目</TableHead>
                  <TableHead className="w-28">貸借</TableHead>
                  <TableHead className="w-44 text-right">金額（円）</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fields.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="text-muted-foreground">
                      行がありません。「行を追加」から入力してください。
                    </TableCell>
                  </TableRow>
                )}
                {fields.map((field, index) => (
                  <BalanceRow
                    key={field.id}
                    index={index}
                    form={form}
                    entityId={entityId}
                    accounts={accounts}
                    onRemove={() => remove(index)}
                  />
                ))}
              </TableBody>
              <Totals control={form.control} />
            </Table>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() => append({ accountId: "", side: "debit", amount: undefined })}
              >
                行を追加
              </Button>
              <SaveButton control={form.control} pending={save.isPending} />
            </div>
            <ApiErrorMessage error={save.error} />
          </fieldset>
        </form>
      </CardContent>
    </Card>
  );
}

function BalanceRow({
  index,
  form,
  entityId,
  accounts,
  onRemove,
}: {
  index: number;
  form: UseFormReturn<FormInput, unknown, FormOutput>;
  entityId: string;
  accounts: Account[];
  onRemove: () => void;
}) {
  const accountId = useWatch({ control: form.control, name: `rows.${index}.accountId` });
  const subAccounts = useQuery({
    ...subAccountsQuery(entityId, accountId),
    enabled: accountId !== "",
  });
  const groups = useMemo(
    () => groupAccountsBySection(accounts.filter((a) => a.isActive || a.id === accountId)),
    [accounts, accountId],
  );
  const rowErrors = form.formState.errors.rows?.[index];
  const n = index + 1;
  const ids = {
    account: `ob-${index}-account`,
    sub: `ob-${index}-sub`,
    side: `ob-${index}-side`,
    amount: `ob-${index}-amount`,
  };

  return (
    <TableRow>
      <TableCell className="align-top">
        <label htmlFor={ids.account} className="sr-only">
          {n}行目の勘定科目
        </label>
        <NativeSelect
          id={ids.account}
          aria-invalid={rowErrors?.accountId ? true : undefined}
          aria-describedby={`${ids.account}-error`}
          {...form.register(`rows.${index}.accountId`, {
            onChange: (e: { target: { value: string } }) => {
              const account = accounts.find((a) => a.id === e.target.value);
              if (account) form.setValue(`rows.${index}.side`, account.normalSide);
              form.setValue(`rows.${index}.subAccountId`, undefined);
            },
          })}
        >
          <option value="">選択してください</option>
          {groups.map((g) => (
            <optgroup key={g.section} label={g.label}>
              {g.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.isActive ? "" : "（使用停止）"}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
        <FieldError
          id={`${ids.account}-error`}
          message={rowErrors?.accountId ? "勘定科目を選択してください" : undefined}
        />
      </TableCell>
      <TableCell className="align-top">
        <label htmlFor={ids.sub} className="sr-only">
          {n}行目の補助科目
        </label>
        <NativeSelect
          id={ids.sub}
          disabled={!subAccounts.data || subAccounts.data.length === 0}
          {...form.register(`rows.${index}.subAccountId`, {
            setValueAs: (v: unknown) => (v === "" || v === null ? undefined : v),
          })}
        >
          <option value="">（なし）</option>
          {subAccounts.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      </TableCell>
      <TableCell className="align-top">
        <label htmlFor={ids.side} className="sr-only">
          {n}行目の貸借
        </label>
        <NativeSelect id={ids.side} {...form.register(`rows.${index}.side`)}>
          {Side.options.map((s) => (
            <option key={s} value={s}>
              {SIDE_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </TableCell>
      <TableCell className="align-top">
        <label htmlFor={ids.amount} className="sr-only">
          {n}行目の金額
        </label>
        <Input
          id={ids.amount}
          inputMode="numeric"
          autoComplete="off"
          className="text-right tabular-nums"
          aria-invalid={rowErrors?.amount ? true : undefined}
          aria-describedby={`${ids.amount}-error`}
          {...form.register(`rows.${index}.amount`, {
            setValueAs: (v: unknown) => (typeof v === "string" ? parseYenInput(v) : v),
          })}
        />
        <FieldError
          id={`${ids.amount}-error`}
          message={rowErrors?.amount ? "1 円以上 1 兆円未満の整数で入力してください" : undefined}
        />
      </TableCell>
      <TableCell className="align-top">
        <Button variant="ghost" size="sm" onClick={onRemove}>
          削除<span className="sr-only">（{n}行目）</span>
        </Button>
      </TableCell>
    </TableRow>
  );
}

function useTotals(control: Control<FormInput, unknown, FormOutput>) {
  const rows = useWatch({ control, name: "rows" });
  return openingTotals(rows);
}

function Totals({ control }: { control: Control<FormInput, unknown, FormOutput> }) {
  const totals = useTotals(control);
  return (
    <TableFooter>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={5}>
          <dl
            aria-live="polite"
            aria-label="合計"
            className="flex flex-wrap justify-end gap-x-8 gap-y-1 tabular-nums"
          >
            <div className="flex gap-2">
              <dt className="text-muted-foreground">借方合計</dt>
              <dd>{formatYen(totals.debit)} 円</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">貸方合計</dt>
              <dd>{formatYen(totals.credit)} 円</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">差額</dt>
              <dd className={cn(!totals.balanced && "font-semibold text-destructive")}>
                {formatYen(totals.diff)} 円
              </dd>
            </div>
          </dl>
        </TableCell>
      </TableRow>
    </TableFooter>
  );
}

function SaveButton({
  control,
  pending,
}: {
  control: Control<FormInput, unknown, FormOutput>;
  pending: boolean;
}) {
  const totals = useTotals(control);
  return (
    <>
      <Button type="submit" disabled={!totals.balanced || pending} aria-describedby="ob-save-hint">
        {pending ? "保存中…" : "保存する"}
      </Button>
      <span id="ob-save-hint" className="text-sm text-muted-foreground">
        {totals.balanced ? "" : "差額が 0 円になると保存できます。"}
      </span>
    </>
  );
}
