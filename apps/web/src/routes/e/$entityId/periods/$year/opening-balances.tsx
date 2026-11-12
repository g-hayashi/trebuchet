import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  OpeningBalanceInput,
  type OpeningBalancesPut,
  type OpeningProposal,
  Side,
  Yen,
} from "@trebuchet/schema";
import { useEffect, useMemo, useState } from "react";
import {
  type Control,
  type UseFormReturn,
  useFieldArray,
  useForm,
  useWatch,
} from "react-hook-form";
import { z } from "zod";
import { Loading } from "@/components/loading";
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
import { type Account, accountsQuery, subAccountsQuery } from "@/features/accounts/api";
import { proposeFreeeOpening } from "@/features/imports/api";
import { FilePicker } from "@/features/imports/FilePicker";
import { OpeningProposalPanel } from "@/features/imports/OpeningProposalPanel";
import {
  type OpeningBalancesData,
  openingBalancesQuery,
  periodKeys,
  putOpeningBalances,
} from "@/features/periods/api";
import { groupAccountsBySection, SIDE_LABELS } from "@/lib/accounts";
import { formatYen, parseYenInput } from "@/lib/format";
import { invalidateLedger } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/e/$entityId/periods/$year/opening-balances")({
  component: OpeningBalancesPage,
});

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

const proposalToFormRows = (proposal: OpeningProposal): FormInput["rows"] =>
  proposal.rows.map((r) => ({
    accountId: r.accountId,
    subAccountId: r.subAccountId ?? undefined,
    side: r.side,
    amount: r.amount,
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
      {(balances.isPending || accounts.isPending) && !error && <Loading />}
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
  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "rows",
  });
  // ファイルを選び直すたびに FilePicker を作り直し、選んだファイル名の表示を消す
  const [pickerKey, setPickerKey] = useState(0);
  const propose = useMutation({
    mutationFn: (file: File) => proposeFreeeOpening(entityId, year, file),
  });
  // 最後に読み込めた案。読み込み直しが失敗しても、入力欄に入れた案の未定の科目で保存を止め続ける
  const [proposal, setProposal] = useState<OpeningProposal>();
  // 案を作った元帳。未定の科目を解消した後に、同じファイルで案を作り直す
  const [ledger, setLedger] = useState<File>();
  const applyProposal = (p: OpeningProposal) => replace(proposalToFormRows(p));
  const loadProposal = (file: File) =>
    propose.mutate(file, {
      onSuccess: (p) => {
        setLedger(file);
        setProposal(p);
        applyProposal(p);
      },
    });
  const closeProposal = () => {
    setProposal(undefined);
    setLedger(undefined);
    propose.reset();
    setPickerKey((k) => k + 1);
  };

  const save = useMutation({
    mutationFn: (json: OpeningBalancesPut) => putOpeningBalances(entityId, year, json),
    onSuccess: async (saved) => {
      queryClient.setQueryData(periodKeys.openingBalances(entityId, year), saved);
      form.reset({ rows: toFormRows(saved) });
      closeProposal();
      // 期首残高は帳票・決算書・ホームの数字の元
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: periodKeys.openingBalances(entityId, year) }),
        invalidateLedger(queryClient, entityId),
      ]);
    },
  });

  const saveHints = [
    ...(proposal && proposal.unmapped.length > 0
      ? ["対応が決まっていない freee の科目があるため、保存できません。"]
      : []),
    ...(proposal && data.openingBalances.length > 0
      ? ["保存すると、登録済みの期首残高を置き換えます。"]
      : []),
  ];

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>freee の元帳から読み込む</CardTitle>
          <CardDescription>
            freee から書き出した{year}
            年の総勘定元帳を選ぶと、各科目の期首の残高（前期繰越・開始残高）から案を作り、下の入力欄に入れます。保存するまで帳簿は変わりません。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FilePicker
            key={pickerKey}
            label="総勘定元帳のファイル"
            disabled={closed || propose.isPending || save.isPending}
            onChange={(file) => {
              // 選択を取り消したときは、案と入力欄をそのままにする
              if (!file) return;
              loadProposal(file);
            }}
          />
          {propose.isPending && (
            <p className="text-sm text-muted-foreground">
              {proposal ? "案を作り直しています…" : "元帳を読み込み中…"}
            </p>
          )}
          <ApiErrorMessage error={propose.error} />
          {proposal && (
            <OpeningProposalPanel
              entityId={entityId}
              proposal={proposal}
              accounts={accounts}
              resolving={propose.isPending}
              onApply={() => applyProposal(proposal)}
              onResolved={() => {
                if (ledger) loadProposal(ledger);
              }}
              onDiscard={() => {
                closeProposal();
                form.reset({ rows: toFormRows(data) });
              }}
            />
          )}
        </CardContent>
      </Card>
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
                <SaveButton
                  control={form.control}
                  pending={save.isPending}
                  blocked={proposal !== undefined && proposal.unmapped.length > 0}
                  hints={saveHints}
                />
                <span role="status" className="text-sm">
                  {save.isSuccess && !form.formState.isDirty ? "保存しました。" : ""}
                </span>
              </div>
              <ApiErrorMessage error={save.error} />
            </fieldset>
          </form>
        </CardContent>
      </Card>
    </div>
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
  // 補助科目の選択肢が後から届くため、届いたら選択中の値を選択欄に入れ直す（案・登録済みの値）
  useEffect(() => {
    if (!subAccounts.data) return;
    form.setValue(`rows.${index}.subAccountId`, form.getValues(`rows.${index}.subAccountId`));
  }, [subAccounts.data, form, index]);
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

/** 借方合計・貸方合計・差額（借方 − 貸方）。未入力の金額は 0 として数える */
function useTotals(control: Control<FormInput, unknown, FormOutput>) {
  const rows = useWatch({ control, name: "rows" });
  let debit = 0;
  let credit = 0;
  for (const row of rows) {
    const amount = typeof row.amount === "number" && Number.isFinite(row.amount) ? row.amount : 0;
    if (row.side === "debit") debit += amount;
    else credit += amount;
  }
  return { debit, credit, diff: debit - credit, balanced: debit === credit };
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
  blocked,
  hints,
}: {
  control: Control<FormInput, unknown, FormOutput>;
  pending: boolean;
  /** 貸借が一致していても保存できない（freee の案に対応が未定の科目がある） */
  blocked: boolean;
  hints: readonly string[];
}) {
  const totals = useTotals(control);
  return (
    <>
      <Button
        type="submit"
        disabled={!totals.balanced || blocked || pending}
        aria-describedby="ob-save-hint"
      >
        {pending ? "保存中…" : "保存する"}
      </Button>
      <span id="ob-save-hint" className="grid text-sm text-muted-foreground">
        <span>{totals.balanced ? "" : "差額が 0 円になると保存できます。"}</span>
        {hints.map((hint) => (
          <span key={hint}>{hint}</span>
        ))}
      </span>
    </>
  );
}
