import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JournalInput, Recurring, RecurringInput, RecurringUpdate } from "@trebuchet/schema";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { JournalForm } from "@/features/journals/JournalForm";
import { today } from "@/lib/dates";
import {
  accountsQuery,
  partnersQuery,
  queryKeys,
  taxCategoriesQuery,
  taxSettingsQuery,
} from "@/lib/queries";
import { confirmDetailsOf, postRecurring, putRecurring, recurringKeys } from "./api";
import { DAY_OPTIONS } from "./labels";

type Body = Omit<RecurringInput, "confirm">;

/**
 * 定期仕訳の入力（FR-023・029）。名前・予定日（1〜28 と末日 = 31）・開始月・終了月と、仕訳の行。
 * 行の入力は 001 の `JournalForm` を使う（日付の入力は出さない。日付は回ごとに予定日で決まる）。
 * 保存で今日以前に登録される回があると server が 409 `RECURRING_CONFIRM_REQUIRED` を返すので、
 * 件数と月を示し、確認を受けて `confirm: true` で同じ内容を再送する。
 * `recurring` があれば更新（`version` を送る）、なければ作成
 */
export function RecurringForm({
  entityId,
  recurring,
  onSaved,
}: {
  entityId: string;
  recurring?: Recurring | undefined;
  onSaved?: ((saved: Recurring) => void) | undefined;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(recurring?.name ?? "");
  const [day, setDay] = useState(String(recurring?.dayOfMonth ?? 1));
  const [startMonth, setStartMonth] = useState(recurring?.startMonth ?? today().slice(0, 7));
  const [endMonth, setEndMonth] = useState(recurring?.endMonth ?? "");
  const [errors, setErrors] = useState<{ name?: string; startMonth?: string; endMonth?: string }>(
    {},
  );
  const [confirming, setConfirming] = useState<
    { body: Body; count: number; months: string[] } | undefined
  >();
  const [notice, setNotice] = useState("");
  const [confirmError, setConfirmError] = useState<unknown>();

  const accounts = useQuery(accountsQuery(entityId));
  const partners = useQuery(partnersQuery(entityId));
  const taxSettings = useQuery(taxSettingsQuery(entityId));
  const taxCategories = useQuery(taxCategoriesQuery(entityId));
  const queries = [accounts, partners, taxSettings, taxCategories];
  const loadError = queries.find((q) => q.error)?.error;

  const save = async (body: Body, confirm: boolean) => {
    const withConfirm = confirm ? { ...body, confirm: true } : body;
    const result = recurring
      ? await putRecurring(entityId, recurring.id, {
          ...withConfirm,
          version: recurring.version,
        } satisfies RecurringUpdate)
      : await postRecurring(entityId, withConfirm);
    setConfirming(undefined);
    const posted = result.posted.length;
    setNotice(posted > 0 ? `保存しました。${posted} 件の仕訳を登録しました。` : "保存しました。");
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: recurringKeys.all(entityId) }),
      ...(posted > 0
        ? [
            queryClient.invalidateQueries({ queryKey: queryKeys.journals(entityId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.reports(entityId) }),
          ]
        : []),
    ]);
    onSaved?.(result.recurring);
  };

  /** 失敗したら例外を投げる（行・項目の表示は JournalForm が行う）。確認が要るときは確認の表示にして戻る */
  const onSubmit = async (input: JournalInput) => {
    setNotice("");
    setConfirming(undefined);
    setConfirmError(undefined);
    const next: typeof errors = {};
    if (name.trim() === "") next.name = "名前を入力してください";
    if (startMonth === "") next.startMonth = "開始月を入力してください";
    else if (endMonth !== "" && endMonth < startMonth) {
      next.endMonth = "終了月は開始月以降にしてください";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const body: Body = {
      name: name.trim(),
      ...(input.memo === undefined ? {} : { memo: input.memo }),
      dayOfMonth: Number(day),
      startMonth,
      ...(endMonth === "" ? {} : { endMonth }),
      lines: input.lines,
    };
    try {
      await save(body, false);
    } catch (e) {
      const details = confirmDetailsOf(e);
      if (!details) throw e;
      setConfirming({ body, ...details });
    }
  };

  const onConfirm = async () => {
    if (!confirming) return;
    setConfirmError(undefined);
    try {
      await save(confirming.body, true);
    } catch (e) {
      setConfirmError(e);
    }
  };

  const leading = (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="grid content-start gap-1 sm:col-span-2">
        <Label htmlFor={`${id}-name`}>名前</Label>
        <Input
          id={`${id}-name`}
          autoComplete="off"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={`${id}-name-error`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <FieldError id={`${id}-name-error`} message={errors.name} />
      </div>
      <div className="grid content-start gap-1">
        <Label htmlFor={`${id}-day`}>毎月の予定日</Label>
        <NativeSelect id={`${id}-day`} value={day} onChange={(e) => setDay(e.target.value)}>
          {DAY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid content-start gap-1">
        <Label htmlFor={`${id}-start`}>開始月</Label>
        <Input
          id={`${id}-start`}
          type="month"
          aria-invalid={errors.startMonth ? true : undefined}
          aria-describedby={`${id}-start-error`}
          value={startMonth}
          onChange={(e) => setStartMonth(e.target.value)}
        />
        <FieldError id={`${id}-start-error`} message={errors.startMonth} />
      </div>
      <div className="grid content-start gap-1">
        <Label htmlFor={`${id}-end`}>終了月</Label>
        <Input
          id={`${id}-end`}
          type="month"
          aria-invalid={errors.endMonth ? true : undefined}
          aria-describedby={`${id}-end-error`}
          value={endMonth}
          onChange={(e) => setEndMonth(e.target.value)}
        />
        <FieldError id={`${id}-end-error`} message={errors.endMonth} />
      </div>
    </div>
  );

  return (
    <div className="grid gap-4">
      <ApiErrorMessage error={loadError} />
      {queries.some((q) => q.isPending) && !loadError && (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      )}
      {accounts.data && partners.data && taxSettings.data && taxCategories.data && (
        <JournalForm
          entityId={entityId}
          accounts={accounts.data}
          partners={partners.data}
          tags={[]}
          taxSettings={taxSettings.data}
          taxCategories={taxCategories.data}
          defaultDate={recurring ? `${recurring.startMonth}-01` : today()}
          journal={
            recurring && {
              date: `${recurring.startMonth}-01`,
              memo: recurring.memo,
              lines: recurring.lines,
            }
          }
          formLabel="定期仕訳"
          hideDate
          leading={leading}
          submitLabel={recurring ? "保存する" : "登録する"}
          onSubmit={onSubmit}
        />
      )}
      {confirming && (
        <div
          role="alert"
          className="grid gap-3 rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm text-amber-950"
        >
          <p>
            {`今日までに登録される回が ${confirming.count} 件あります（${confirming.months.join("、")}）。保存すると、これらの仕訳をすぐに登録します。`}
          </p>
          <div>
            <Button onClick={onConfirm}>
              {recurring ? "確認して保存する" : "確認して登録する"}
            </Button>
          </div>
        </div>
      )}
      <ApiErrorMessage error={confirmError} />
      <SaveNotice message={notice} />
    </div>
  );
}
