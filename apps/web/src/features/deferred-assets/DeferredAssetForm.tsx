import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { SaveNotice } from "@/components/ui/save-notice";
import type { Account } from "@/features/accounts/api";
import { blueReturnKeys } from "@/features/blue-return/api";
import { parseWholeYen } from "@/lib/format";
import { parsePriorAccumulated, priorFieldsOf } from "@/lib/prior-accumulated";
import {
  type DeferredAssetRow,
  deferredAssetKeys,
  postDeferredAsset,
  putDeferredAsset,
} from "./api";

const TOTAL_ERROR = "開業費の総額は1円以上の整数で入力してください";
const REQUIRED_ERROR = "名称・開業日・勘定を入力してください";

type Values = {
  name: string;
  total: string;
  openedOn: string;
  priorAccumulated: string;
  priorThroughYear: string;
  accountId: string;
  note: string;
  reason: string;
};

const EMPTY: Values = {
  name: "",
  total: "",
  openedOn: "",
  priorAccumulated: "",
  priorThroughYear: "",
  accountId: "",
  note: "",
  reason: "",
};

const valuesOf = (d: DeferredAssetRow): Values => ({
  name: d.name,
  total: String(d.totalAmount),
  openedOn: d.openedOn,
  ...priorFieldsOf(d),
  accountId: d.accountId,
  note: d.note ?? "",
  reason: "",
});

/**
 * 開業費（繰延資産）の登録・編集（FR-012、009 US3）。総額・開業日・前年までの償却累計額とその年分・勘定を入れる。
 * 登録しただけでは帳簿は変わらない。上限・勘定の区分・変更の制限（有効な仕訳があるとき）の判定は API が行う
 */
export function DeferredAssetForm({
  entityId,
  accounts,
  editing,
  onDone,
  notice,
  onSaved,
}: {
  entityId: string;
  accounts: readonly Account[];
  /** 編集する開業費。なければ新規の登録 */
  editing: DeferredAssetRow | undefined;
  onDone: () => void;
  /** 成功の知らせ。保存すると入力欄を作り直すので、親が持つ */
  notice: string;
  onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(editing ? valuesOf(editing) : EMPTY);
  const [requiredError, setRequiredError] = useState<string>();
  const [totalError, setTotalError] = useState<string>();
  const [priorError, setPriorError] = useState<string>();
  const [priorYearError, setPriorYearError] = useState<string>();
  const set = (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch }));

  const assetAccounts = accounts.filter(
    (a) => a.category === "asset" && (a.isActive || a.id === editing?.accountId),
  );

  const save = useMutation({
    mutationFn: (fields: { total: number; prior: number; priorThroughYear: number | null }) => {
      const body = {
        name: values.name,
        totalAmount: fields.total,
        openedOn: values.openedOn,
        priorAccumulated: fields.prior,
        priorThroughYear: fields.priorThroughYear,
        accountId: values.accountId,
        note: values.note.trim() === "" ? null : values.note,
      };
      return editing
        ? putDeferredAsset(entityId, editing.id, {
            ...body,
            reason: values.reason.trim() === "" ? null : values.reason,
          })
        : postDeferredAsset(entityId, body);
    },
    onSuccess: async () => {
      setValues(EMPTY);
      onDone();
      onSaved(editing ? "開業費を更新しました。" : "開業費を登録しました。");
      // 開業費の一覧と、決算書（3ページ・警告）・仕訳の案を読み直す（開業費の保存は仕訳を変えない）
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deferredAssetKeys.all(entityId) }),
        queryClient.invalidateQueries({ queryKey: blueReturnKeys.all(entityId) }),
      ]);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const total = parseWholeYen(values.total, { min: 1 });
    const { value, priorError, priorYearError } = parsePriorAccumulated(values);
    const required =
      values.name.trim() === "" || values.openedOn === "" || values.accountId === ""
        ? REQUIRED_ERROR
        : undefined;
    setRequiredError(required);
    setTotalError(total === null ? TOTAL_ERROR : undefined);
    setPriorError(priorError);
    setPriorYearError(priorYearError);
    // 前の保存の知らせを、今回の結果（失敗を含む）と並べて出さない
    onSaved("");
    if (required || total === null || !value) return;
    save.mutate({ total, prior: value.prior, priorThroughYear: value.year });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `${editing.name}を編集` : "開業費の登録"}</CardTitle>
        <CardDescription>
          開業費は 60
          か月の均等償却を目安に、年分ごとに償却額を決めます（任意償却）。登録しただけでは帳簿は変わりません。償却額を決めると、下の「決算整理の仕訳の案」に仕訳の案が出ます。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={submit} className="grid gap-3 sm:max-w-xl">
          <div className="grid gap-1">
            <label htmlFor="deferred-name" className="text-sm font-medium">
              開業費の名称
            </label>
            <Input
              id="deferred-name"
              autoComplete="off"
              value={values.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor="deferred-total" className="text-sm font-medium">
              開業費の総額
            </label>
            <Input
              id="deferred-total"
              inputMode="numeric"
              autoComplete="off"
              value={values.total}
              onChange={(e) => set({ total: e.target.value })}
              aria-invalid={totalError ? true : undefined}
              aria-describedby="deferred-total-error"
            />
            <FieldError id="deferred-total-error" message={totalError} />
          </div>
          <div className="grid gap-1">
            <label htmlFor="deferred-opened-on" className="text-sm font-medium">
              開業日
            </label>
            <Input
              id="deferred-opened-on"
              type="date"
              value={values.openedOn}
              onChange={(e) => set({ openedOn: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor="deferred-prior" className="text-sm font-medium">
              開業費の前年までの償却累計額
            </label>
            <Input
              id="deferred-prior"
              inputMode="numeric"
              autoComplete="off"
              value={values.priorAccumulated}
              onChange={(e) => set({ priorAccumulated: e.target.value })}
              aria-invalid={priorError ? true : undefined}
              aria-describedby="deferred-prior-error"
            />
            <FieldError id="deferred-prior-error" message={priorError} />
          </div>
          <div className="grid gap-1">
            <label htmlFor="deferred-prior-year" className="text-sm font-medium">
              開業費の累計の年分
            </label>
            <Input
              id="deferred-prior-year"
              inputMode="numeric"
              autoComplete="off"
              value={values.priorThroughYear}
              onChange={(e) => set({ priorThroughYear: e.target.value })}
              aria-invalid={priorYearError ? true : undefined}
              aria-describedby="deferred-prior-year-error"
            />
            <FieldError id="deferred-prior-year-error" message={priorYearError} />
            <p className="text-sm text-muted-foreground">
              この年分より後の年から、償却額を決めます。前の年から償却している開業費だけ入力します。
            </p>
          </div>
          <div className="grid gap-1">
            <label htmlFor="deferred-account" className="text-sm font-medium">
              開業費の勘定
            </label>
            <NativeSelect
              id="deferred-account"
              value={values.accountId}
              onChange={(e) => set({ accountId: e.target.value })}
            >
              <option value="">選択してください</option>
              {assetAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1">
            <label htmlFor="deferred-note" className="text-sm font-medium">
              開業費の備考
            </label>
            <Input
              id="deferred-note"
              autoComplete="off"
              value={values.note}
              onChange={(e) => set({ note: e.target.value })}
            />
          </div>
          {editing && (
            <div className="grid gap-1">
              <label htmlFor="deferred-reason" className="text-sm font-medium">
                開業費の変更の理由
              </label>
              <Input
                id="deferred-reason"
                autoComplete="off"
                value={values.reason}
                onChange={(e) => set({ reason: e.target.value })}
              />
            </div>
          )}
          <FieldError id="deferred-required-error" message={requiredError} />
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending}>
              {editing ? "開業費を更新" : "開業費を登録"}
            </Button>
            {editing && (
              <Button type="button" variant="outline" onClick={onDone}>
                開業費の編集をやめる
              </Button>
            )}
            <SaveNotice message={notice} />
          </div>
        </form>
        <ApiErrorMessage error={save.error} className="mt-3" />
      </CardContent>
    </Card>
  );
}
