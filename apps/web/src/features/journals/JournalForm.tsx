import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type JournalInput,
  JournalInputFields,
  JournalLineInput,
  Side,
  type TaxCategoryCode,
  Yen,
} from "@trebuchet/schema";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  type Control,
  type FieldError as RhfFieldError,
  type UseFormReturn,
  useFieldArray,
  useForm,
  useWatch,
} from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { type Account, subAccountsQuery } from "@/features/accounts/api";
import type { TaxCategory, TaxSetting } from "@/features/entities/api";
import type { Partner, Tag } from "@/features/masters/api";
import { groupAccountsBySection } from "@/lib/accounts";
import { ApiError } from "@/lib/api";
import { formatYen, parseYenInput } from "@/lib/format";
import { cn } from "@/lib/utils";

const SIDE_LABELS: Record<Side, string> = { debit: "借方", credit: "貸方" };

/** 共有スキーマの行。入力途中の金額（未入力 = undefined）を型として許し、検証は Yen で行う */
const LineSchema = JournalLineInput.extend({
  amount: z.preprocess<number | undefined, typeof Yen, number | undefined>((v) => v, Yen),
});
const FormSchema = JournalInputFields.extend({ lines: z.array(LineSchema).min(2) }).refine(
  (v) => v.lines.some((l) => l.side === "debit") && v.lines.some((l) => l.side === "credit"),
  { message: "借方と貸方をそれぞれ1行以上入力してください", path: ["lines"] },
);
type FormInput = z.input<typeof FormSchema>;
type FormOutput = z.output<typeof FormSchema>;
type Form = UseFormReturn<FormInput, unknown, FormOutput>;
type LineValues = FormInput["lines"][number];

const emptyLine = (side: Side): LineValues => ({
  side,
  accountId: "",
  amount: undefined,
  tagIds: [],
});

/** 空の選択・入力を「指定なし」にする */
const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

/**
 * 税区分の既定値（FR-017）。サーバー（domain の defaultTaxCategory）と同じ規則で、
 * 「自動」の表示に使う。実際の値は税区分を省略して送り、サーバーが決める
 */
function defaultTaxCategory(
  date: string,
  account: Account | undefined,
  settings: readonly TaxSetting[],
): TaxCategoryCode {
  let setting: TaxSetting | undefined;
  for (const s of settings) {
    if (s.effectiveFrom <= date && (!setting || s.effectiveFrom > setting.effectiveFrom)) {
      setting = s;
    }
  }
  if (!setting || setting.taxpayerStatus === "exempt" || !account) return "OUT_OF_SCOPE";
  if (account.category === "revenue") return "SALES_10";
  if (account.category === "expense") return "PURCHASE_10";
  return "OUT_OF_SCOPE";
}

/**
 * フォームの初期値になる仕訳の形。訂正する仕訳（`Journal`）のほか、定期仕訳の定義
 * （005。税区分が null = 自動、タグなし、訂正元なし）も同じ形で渡せる
 */
export type JournalFormSource = {
  date: string;
  memo: string | null;
  correctsJournalId?: string | null | undefined;
  lines: readonly {
    side: Side;
    /** 空文字は未選択（証憑から仕訳を作るとき。010） */
    accountId: string;
    subAccountId: string | null;
    /** undefined は未入力（金額が未入力の証憑から仕訳を作るとき。010） */
    amount: number | undefined;
    taxCategory: TaxCategoryCode | null;
    partnerId: string | null;
    description: string | null;
    tagIds?: readonly string[] | undefined;
  }[];
};

/** 訂正する仕訳をフォームの値にする。税区分は既定値と同じなら「自動」にする */
function valuesOf(
  journal: JournalFormSource,
  accounts: readonly Account[],
  settings: readonly TaxSetting[],
): FormInput {
  return {
    date: journal.date,
    memo: journal.memo ?? undefined,
    correctsJournalId: journal.correctsJournalId ?? undefined,
    lines: journal.lines.map((l) => ({
      side: l.side,
      accountId: l.accountId,
      subAccountId: l.subAccountId ?? undefined,
      amount: l.amount,
      taxCategory:
        l.taxCategory === null ||
        l.taxCategory ===
          defaultTaxCategory(
            journal.date,
            accounts.find((a) => a.id === l.accountId),
            settings,
          )
          ? undefined
          : l.taxCategory,
      partnerId: l.partnerId ?? undefined,
      description: l.description ?? undefined,
      tagIds: [...(l.tagIds ?? [])],
    })),
  };
}

// ---- API のエラーを項目に対応づける ----

const LINE_FIELDS = [
  "side",
  "accountId",
  "subAccountId",
  "amount",
  "taxCategory",
  "partnerId",
  "description",
  "tagIds",
] as const;
type LineFieldName = (typeof LINE_FIELDS)[number];
const isLineField = (v: unknown): v is LineFieldName => LINE_FIELDS.some((f) => f === v);

/** 日付に関するエラー（会計期間・消費税の設定） */
const DATE_CODES = new Set([
  "OUT_OF_PERIOD",
  "PERIOD_CLOSED",
  "TAX_METHOD_UNSUPPORTED",
  "TAX_SETTING_GAP",
]);

type Issue = { code: string; message: string; details: Record<string, unknown> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * エラーを違反の一覧にする。ドメインの違反は details.errors に、入力の形式の違反は
 * details.issues（path: ["lines", "0", "amount"] など）に入っている
 */
function issuesOf(error: ApiError): Issue[] {
  const nested = error.details?.errors;
  if (Array.isArray(nested)) {
    return nested.filter(isRecord).map((e) => ({
      code: String(e.code),
      message: String(e.message),
      details: isRecord(e.details) ? e.details : {},
    }));
  }
  const zodIssues = error.details?.issues;
  if (error.code === "VALIDATION" && Array.isArray(zodIssues)) {
    return zodIssues.filter(isRecord).map((i) => {
      const path = Array.isArray(i.path) ? i.path.map(String) : [];
      const details: Record<string, unknown> =
        path[0] === "lines" && path.length >= 3
          ? { lineIndex: Number(path[1]), field: path[2] }
          : { field: path[0] };
      return { code: "VALIDATION", message: String(i.message), details };
    });
  }
  return [{ code: error.code, message: error.message, details: error.details ?? {} }];
}

function describeIssue({ code, message, details }: Issue): string {
  if (code === "UNBALANCED" && typeof details.diff === "number") {
    return `${message}（差額 ${formatYen(details.diff)} 円）`;
  }
  return message;
}

/** 検証のメッセージ。サーバーのエラーはその文言、画面での検証は fallback */
const messageOf = (
  error:
    | (Pick<RhfFieldError, "message"> & { type?: RhfFieldError["type"] | undefined })
    | undefined,
  fallback: string,
) => (error === undefined ? undefined : error.type === "server" ? error.message : fallback);

// ---- フォーム ----

export type JournalFormProps = {
  entityId: string;
  accounts: Account[];
  partners: Partner[];
  tags: Tag[];
  taxSettings: TaxSetting[];
  taxCategories: TaxCategory[];
  defaultDate: string;
  /** 訂正する仕訳。その内容で始め、使っている使用停止の科目・補助科目・取引先も選べるようにする */
  journal?: JournalFormSource | undefined;
  /** 訂正仕訳として登録するときの訂正元（FR-019a） */
  correctsJournalId?: string | undefined;
  submitLabel?: string | undefined;
  /** フォームの名前（読み上げ・テストの検索用）。既定は「仕訳」 */
  formLabel?: string | undefined;
  /**
   * 日付の入力を出さない（定期仕訳。005）。`defaultDate`（または `journal.date`）は税区分の「自動」の
   * 表示にだけ使い、`onSubmit` の `date` はそのまま返す。呼び出し側は使わない
   */
  hideDate?: boolean | undefined;
  /** 日付・メモの前に差し込む入力（定期仕訳の名前・予定日など）。値は呼び出し側が持つ */
  leading?: ReactNode;
  /** 失敗したら ApiError を投げる。エラーはフォームが該当の行・項目に表示する */
  onSubmit: (input: JournalInput) => Promise<unknown>;
};

/** 仕訳の入力フォーム（FR-013〜018）。行の追加・削除、合計と差額の表示、エラーの表示を行う */
export function JournalForm({
  entityId,
  accounts,
  partners,
  tags,
  taxSettings,
  taxCategories,
  defaultDate,
  journal,
  correctsJournalId,
  submitLabel = "登録する",
  formLabel = "仕訳",
  hideDate = false,
  leading,
  onSubmit,
}: JournalFormProps) {
  const form: Form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(FormSchema),
    defaultValues: journal
      ? valuesOf(journal, accounts, taxSettings)
      : {
          date: defaultDate,
          correctsJournalId,
          lines: [emptyLine("debit"), emptyLine("credit")],
        },
  });
  const keep = useMemo(
    () =>
      new Set(
        journal?.lines.flatMap((l) =>
          [l.accountId, l.subAccountId ?? [], l.partnerId ?? []].flat(),
        ),
      ),
    [journal],
  );
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });
  const [generalErrors, setGeneralErrors] = useState<string[]>([]);
  const [unexpected, setUnexpected] = useState<unknown>();
  const [suggestPeriod, setSuggestPeriod] = useState(false);

  const showError = (error: unknown) => {
    if (!(error instanceof ApiError) || error.code === "INTERNAL") {
      setUnexpected(error);
      return;
    }
    const general: string[] = [];
    for (const issue of issuesOf(error)) {
      const { lineIndex, field } = issue.details;
      const server = { type: "server", message: issue.message };
      if (typeof lineIndex === "number" && lineIndex < fields.length && isLineField(field)) {
        form.setError(`lines.${lineIndex}.${field}`, server);
      } else if (field === "date" || DATE_CODES.has(issue.code)) {
        form.setError("date", server);
        if (issue.details.suggest === "create_fiscal_period") setSuggestPeriod(true);
      } else if (field === "memo") {
        form.setError("memo", server);
      } else {
        general.push(describeIssue(issue));
      }
    }
    setGeneralErrors(general);
  };

  const submit = form.handleSubmit(async (values) => {
    setGeneralErrors([]);
    setUnexpected(undefined);
    setSuggestPeriod(false);
    try {
      await onSubmit({
        date: values.date,
        memo: values.memo,
        correctsJournalId: values.correctsJournalId,
        lines: values.lines.map(({ tagIds, ...line }) =>
          tagIds && tagIds.length > 0 ? { ...line, tagIds } : line,
        ),
      });
    } catch (e) {
      showError(e);
    }
  });

  const errors = form.formState.errors;
  const linesError = errors.lines?.message ?? errors.lines?.root?.message;
  const pending = form.formState.isSubmitting;

  return (
    <form noValidate aria-label={formLabel} onSubmit={submit}>
      <fieldset disabled={pending} className="grid gap-4">
        {leading}
        <div className={cn("grid gap-4", hideDate ? undefined : "sm:grid-cols-[12rem_1fr]")}>
          {!hideDate && (
            <div className="grid content-start gap-1">
              <label htmlFor="journal-date" className="text-sm font-medium">
                日付
              </label>
              <Input
                id="journal-date"
                type="date"
                aria-invalid={errors.date ? true : undefined}
                aria-describedby="journal-date-error"
                {...form.register("date")}
              />
              <FieldError id="journal-date-error" message={errors.date?.message} />
              {suggestPeriod && (
                <Link
                  to="/e/$entityId/periods"
                  params={{ entityId }}
                  className="text-sm text-primary underline underline-offset-4"
                >
                  会計期間を作成する
                </Link>
              )}
            </div>
          )}
          <div className="grid content-start gap-1">
            <label htmlFor="journal-memo" className="text-sm font-medium">
              メモ
            </label>
            <Input
              id="journal-memo"
              autoComplete="off"
              aria-invalid={errors.memo ? true : undefined}
              aria-describedby="journal-memo-error"
              {...form.register("memo", { setValueAs: blankToUndefined })}
            />
            <FieldError
              id="journal-memo-error"
              message={messageOf(errors.memo, "メモは 1,000 文字以内で入力してください")}
            />
          </div>
        </div>

        <ol aria-label="仕訳の行" className="grid gap-3">
          {fields.map((field, index) => (
            <JournalLineRow
              key={field.id}
              index={index}
              form={form}
              entityId={entityId}
              accounts={accounts}
              partners={partners}
              tags={tags}
              taxSettings={taxSettings}
              taxCategories={taxCategories}
              keep={keep}
              canRemove={fields.length > 2}
              onRemove={() => remove(index)}
            />
          ))}
        </ol>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <Button variant="outline" onClick={() => append(emptyLine("debit"))}>
            行を追加
          </Button>
          <Totals control={form.control} />
        </div>

        <div aria-live="assertive">
          {(generalErrors.length > 0 || linesError) && (
            <ul
              role="alert"
              className="list-disc rounded-md border border-destructive/50 py-2 pr-3 pl-8 text-sm text-destructive"
            >
              {linesError && <li>{linesError}</li>}
              {generalErrors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </div>
        <ApiErrorMessage error={unexpected} />

        <SubmitButton control={form.control} pending={pending} label={submitLabel} />
      </fieldset>
    </form>
  );
}

/** 行の中の1項目。ラベルは見た目では項目名だけ、読み上げでは「n行目の〜」 */
function LineCell({
  label,
  index,
  htmlFor,
  className,
  children,
}: {
  label: string;
  index: number;
  htmlFor: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid content-start gap-1", className)}>
      <label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        <span className="sr-only">{index + 1}行目の</span>
        {label}
      </label>
      {children}
    </div>
  );
}

function JournalLineRow({
  index,
  form,
  entityId,
  accounts,
  partners,
  tags,
  taxSettings,
  taxCategories,
  keep,
  canRemove,
  onRemove,
}: {
  index: number;
  form: Form;
  entityId: string;
  accounts: Account[];
  partners: Partner[];
  tags: Tag[];
  taxSettings: TaxSetting[];
  taxCategories: TaxCategory[];
  /** 使用停止でも選べる科目・補助科目・取引先の ID */
  keep: ReadonlySet<string>;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const date = useWatch({ control: form.control, name: "date" });
  const accountId = useWatch({ control: form.control, name: `lines.${index}.accountId` });
  const subAccounts = useQuery({
    ...subAccountsQuery(entityId, accountId),
    enabled: accountId !== "",
  });
  const groups = useMemo(
    () => groupAccountsBySection(accounts.filter((a) => a.isActive || keep.has(a.id))),
    [accounts, keep],
  );
  // 補助科目の選択肢は後から読み込まれるので、読み込んだら選択中の値を選択肢に反映する
  useEffect(() => {
    if (subAccounts.data) {
      const name = `lines.${index}.subAccountId` as const;
      form.setValue(name, form.getValues(name));
    }
  }, [subAccounts.data, form, index]);
  const account = accounts.find((a) => a.id === accountId);
  const autoTax = defaultTaxCategory(date, account, taxSettings);
  const taxName = (code: TaxCategoryCode) =>
    taxCategories.find((c) => c.code === code)?.name ?? code;

  const lineErrors = form.formState.errors.lines?.[index];
  const id = (name: string) => `line-${index}-${name}`;
  const described = (name: string) => ({ "aria-describedby": `${id(name)}-error` });
  const invalid = (error: unknown) => (error ? true : undefined);

  return (
    <li className="grid gap-3 rounded-md border p-3 md:grid-cols-12">
      <LineCell label="貸借" index={index} htmlFor={id("side")} className="md:col-span-2">
        <NativeSelect id={id("side")} {...form.register(`lines.${index}.side`)}>
          {Side.options.map((s) => (
            <option key={s} value={s}>
              {SIDE_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </LineCell>
      <LineCell label="勘定科目" index={index} htmlFor={id("account")} className="md:col-span-3">
        <NativeSelect
          id={id("account")}
          aria-invalid={invalid(lineErrors?.accountId)}
          {...described("account")}
          {...form.register(`lines.${index}.accountId`, {
            onChange: () => form.setValue(`lines.${index}.subAccountId`, undefined),
          })}
        >
          <option value="">選択してください</option>
          {groups.map((g) => (
            <optgroup key={g.section} label={g.label}>
              {g.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
        <FieldError
          id={`${id("account")}-error`}
          message={messageOf(lineErrors?.accountId, "勘定科目を選択してください")}
        />
      </LineCell>
      <LineCell label="補助科目" index={index} htmlFor={id("sub")} className="md:col-span-2">
        <NativeSelect
          id={id("sub")}
          disabled={!subAccounts.data || subAccounts.data.length === 0}
          aria-invalid={invalid(lineErrors?.subAccountId)}
          {...described("sub")}
          {...form.register(`lines.${index}.subAccountId`, { setValueAs: blankToUndefined })}
        >
          <option value="">（なし）</option>
          {subAccounts.data
            ?.filter((s) => s.isActive || keep.has(s.id))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </NativeSelect>
        <FieldError
          id={`${id("sub")}-error`}
          message={messageOf(lineErrors?.subAccountId, "補助科目を選び直してください")}
        />
      </LineCell>
      <LineCell label="金額" index={index} htmlFor={id("amount")} className="md:col-span-2">
        <Input
          id={id("amount")}
          inputMode="numeric"
          autoComplete="off"
          className="text-right tabular-nums"
          aria-invalid={invalid(lineErrors?.amount)}
          {...described("amount")}
          {...form.register(`lines.${index}.amount`, {
            setValueAs: (v: unknown) => (typeof v === "string" ? parseYenInput(v) : v),
          })}
        />
        <FieldError
          id={`${id("amount")}-error`}
          message={messageOf(lineErrors?.amount, "1 円以上 1 兆円未満の整数で入力してください")}
        />
      </LineCell>
      <LineCell label="税区分" index={index} htmlFor={id("tax")} className="md:col-span-3">
        <NativeSelect
          id={id("tax")}
          aria-invalid={invalid(lineErrors?.taxCategory)}
          {...described("tax")}
          {...form.register(`lines.${index}.taxCategory`, { setValueAs: blankToUndefined })}
        >
          <option value="">自動（{taxName(autoTax)}）</option>
          {taxCategories.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
        <FieldError
          id={`${id("tax")}-error`}
          message={messageOf(lineErrors?.taxCategory, "税区分を選び直してください")}
        />
      </LineCell>
      <LineCell label="取引先" index={index} htmlFor={id("partner")} className="md:col-span-3">
        <NativeSelect
          id={id("partner")}
          aria-invalid={invalid(lineErrors?.partnerId)}
          {...described("partner")}
          {...form.register(`lines.${index}.partnerId`, { setValueAs: blankToUndefined })}
        >
          <option value="">（なし）</option>
          {partners
            .filter((p) => p.isActive || keep.has(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </NativeSelect>
        <FieldError
          id={`${id("partner")}-error`}
          message={messageOf(lineErrors?.partnerId, "取引先を選び直してください")}
        />
      </LineCell>
      <LineCell label="摘要" index={index} htmlFor={id("description")} className="md:col-span-5">
        <Input
          id={id("description")}
          autoComplete="off"
          aria-invalid={invalid(lineErrors?.description)}
          {...described("description")}
          {...form.register(`lines.${index}.description`, { setValueAs: blankToUndefined })}
        />
        <FieldError
          id={`${id("description")}-error`}
          message={messageOf(lineErrors?.description, "摘要は 500 文字以内で入力してください")}
        />
      </LineCell>
      <LineCell label="タグ" index={index} htmlFor={id("tags")} className="md:col-span-3">
        <NativeSelect
          id={id("tags")}
          multiple
          size={Math.min(Math.max(tags.length, 2), 4)}
          disabled={tags.length === 0}
          className="h-auto py-1"
          aria-invalid={invalid(lineErrors?.tagIds)}
          {...described("tags")}
          {...form.register(`lines.${index}.tagIds`)}
        >
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </NativeSelect>
        <FieldError
          id={`${id("tags")}-error`}
          message={messageOf(lineErrors?.tagIds, "タグを選び直してください")}
        />
      </LineCell>
      <div className="flex items-end md:col-span-1">
        <Button variant="ghost" size="sm" disabled={!canRemove} onClick={onRemove}>
          削除<span className="sr-only">（{index + 1}行目）</span>
        </Button>
      </div>
    </li>
  );
}

/** 借方合計・貸方合計・差額（借方 − 貸方）。未入力の金額は 0 として数える */
function useTotals(control: Control<FormInput, unknown, FormOutput>) {
  const lines = useWatch({ control, name: "lines" });
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    const amount =
      typeof line.amount === "number" && Number.isFinite(line.amount) ? line.amount : 0;
    if (line.side === "debit") debit += amount;
    else credit += amount;
  }
  return { debit, credit, diff: debit - credit, balanced: debit === credit };
}

function Totals({ control }: { control: Control<FormInput, unknown, FormOutput> }) {
  const totals = useTotals(control);
  return (
    <dl
      aria-live="polite"
      aria-label="合計"
      className="flex flex-wrap justify-end gap-x-8 gap-y-1 text-sm tabular-nums"
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
  );
}

function SubmitButton({
  control,
  pending,
  label,
}: {
  control: Control<FormInput, unknown, FormOutput>;
  pending: boolean;
  label: string;
}) {
  const totals = useTotals(control);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" disabled={!totals.balanced || pending} aria-describedby="journal-hint">
        {pending ? "登録中…" : label}
      </Button>
      <span id="journal-hint" className="text-sm text-muted-foreground">
        {totals.balanced ? "" : "差額が 0 円になると登録できます。"}
      </span>
    </div>
  );
}
