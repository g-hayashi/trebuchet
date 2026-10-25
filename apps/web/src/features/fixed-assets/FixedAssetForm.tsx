import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { SaveNotice } from "@/components/ui/save-notice";
import type { Account } from "@/features/accounts/api";
import { blueReturnKeys } from "@/features/blue-return/api";
import { formatRatioAsPercent, parsePercentToRatio } from "@/features/blue-return/ratio";
import { journalSearchQuery } from "@/features/journals/api";
import { parseWholeYen } from "@/lib/format";
import { type FixedAssetRow, fixedAssetKeys, postFixedAsset, putFixedAsset } from "./api";

const COST_ERROR = "取得価額は1円以上の整数で入力してください";
const RATIO_ERROR = "事業専用割合は 0〜100 の数値を小数第2位までで入力してください";
const METHOD = "small_asset_28_2" as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type Values = {
  name: string;
  quantity: string;
  acquiredOn: string;
  cost: string;
  percent: string;
  assetAccountId: string;
  linkedJournalId: string;
  note: string;
  reason: string;
};

const EMPTY: Values = {
  name: "",
  quantity: "",
  acquiredOn: "",
  cost: "",
  percent: "100",
  assetAccountId: "",
  linkedJournalId: "",
  note: "",
  reason: "",
};

const valuesOf = (asset: FixedAssetRow): Values => ({
  name: asset.name,
  quantity: asset.quantity ?? "",
  acquiredOn: asset.acquiredOn,
  cost: String(asset.acquisitionCost),
  percent: formatRatioAsPercent(asset.businessRatio),
  assetAccountId: asset.assetAccountId,
  linkedJournalId: asset.linkedJournalId ?? "",
  note: asset.note ?? "",
  reason: "",
});

/** 取得年月日の年の仕訳だけを、結びつける候補にする（年が決まるまでは読まない） */
function JournalSelect({
  entityId,
  acquiredOn,
  value,
  onChange,
}: {
  entityId: string;
  acquiredOn: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const valid = DATE_PATTERN.test(acquiredOn);
  const year = acquiredOn.slice(0, 4);
  const journals = useInfiniteQuery({
    ...journalSearchQuery(entityId, {
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
      includeVoided: false,
    }),
    enabled: valid,
  });
  const items = journals.data?.pages.flatMap((p) => p.journals) ?? [];
  return (
    <div className="grid gap-1">
      <label htmlFor="asset-journal" className="text-sm font-medium">
        結びつける仕訳
      </label>
      <NativeSelect id="asset-journal" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">結びつけない</option>
        {value !== "" && !items.some((j) => j.id === value) && (
          <option value={value}>（登録済みの仕訳）</option>
        )}
        {items.map((j) => (
          <option key={j.id} value={j.id}>
            {`${j.date} #${j.journalNo}${j.memo ? ` ${j.memo}` : ""}`}
          </option>
        ))}
      </NativeSelect>
      {journals.hasNextPage && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={journals.isFetchingNextPage}
            onClick={() => journals.fetchNextPage()}
          >
            さらに読み込む
          </Button>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        購入の仕訳をすでに登録しているときに選びます。結びつけた資産には、減価償却費の仕訳の案を出しません。
      </p>
    </div>
  );
}

/**
 * 固定資産の登録・編集（FR-018〜020）。償却の方法は少額減価償却資産の特例（措置法28条の2）だけ、
 * 資産の勘定は資産の科目だけ。取得価額・割合の形を整えて送る（特例の基準額・年間の上限の判定は API が行う）
 */
export function FixedAssetForm({
  entityId,
  accounts,
  editing,
  onDone,
  notice,
  onSaved,
}: {
  entityId: string;
  accounts: readonly Account[];
  /** 編集する資産。なければ新規の登録 */
  editing: FixedAssetRow | undefined;
  onDone: () => void;
  /** 成功の知らせ（「登録しました。」「更新しました。」）。保存すると入力欄を作り直すので、親が持つ */
  notice: string;
  onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(editing ? valuesOf(editing) : EMPTY);
  const [costError, setCostError] = useState<string>();
  const [ratioError, setRatioError] = useState<string>();
  const set = (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch }));

  const assetAccounts = accounts.filter(
    (a) => a.category === "asset" && (a.isActive || a.id === editing?.assetAccountId),
  );

  const save = useMutation({
    mutationFn: ({ cost, ratio }: { cost: number; ratio: number }) => {
      const body = {
        name: values.name,
        quantity: values.quantity.trim() === "" ? null : values.quantity,
        acquiredOn: values.acquiredOn,
        acquisitionCost: cost,
        method: METHOD,
        businessRatio: ratio,
        assetAccountId: values.assetAccountId,
        linkedJournalId: values.linkedJournalId === "" ? null : values.linkedJournalId,
        note: values.note.trim() === "" ? null : values.note,
      };
      return editing
        ? putFixedAsset(entityId, editing.id, {
            ...body,
            reason: values.reason.trim() === "" ? null : values.reason,
          })
        : postFixedAsset(entityId, body);
    },
    onSuccess: async () => {
      setValues(EMPTY);
      onDone();
      onSaved(editing ? "更新しました。" : "登録しました。");
      // 台帳と、決算書（3ページ・警告）・仕訳の案を読み直す
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: fixedAssetKeys.all(entityId) }),
        queryClient.invalidateQueries({ queryKey: blueReturnKeys.all(entityId) }),
      ]);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cost = parseWholeYen(values.cost, { min: 1 });
    const ratio = parsePercentToRatio(values.percent);
    setCostError(cost === null ? COST_ERROR : undefined);
    setRatioError(ratio === undefined ? RATIO_ERROR : undefined);
    if (cost === null || ratio === undefined) return;
    save.mutate({ cost, ratio });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `${editing.name}を編集` : "固定資産の登録"}</CardTitle>
        <CardDescription>
          取得価額が基準額未満の資産を、取得した年に全額償却します（少額減価償却資産の特例）。登録しただけでは帳簿は変わりません。下の「決算整理の仕訳の案」で仕訳を登録します。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={submit} className="grid gap-3 sm:max-w-xl">
          <div className="grid gap-1">
            <label htmlFor="asset-name" className="text-sm font-medium">
              資産名
            </label>
            <Input
              id="asset-name"
              autoComplete="off"
              value={values.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor="asset-quantity" className="text-sm font-medium">
              数量
            </label>
            <Input
              id="asset-quantity"
              autoComplete="off"
              value={values.quantity}
              onChange={(e) => set({ quantity: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor="asset-acquired-on" className="text-sm font-medium">
              取得年月日
            </label>
            <Input
              id="asset-acquired-on"
              type="date"
              value={values.acquiredOn}
              onChange={(e) => set({ acquiredOn: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor="asset-cost" className="text-sm font-medium">
              取得価額
            </label>
            <Input
              id="asset-cost"
              inputMode="numeric"
              autoComplete="off"
              value={values.cost}
              onChange={(e) => set({ cost: e.target.value })}
              aria-invalid={costError ? true : undefined}
              aria-describedby="asset-cost-error"
            />
            <FieldError id="asset-cost-error" message={costError} />
          </div>
          <div className="grid gap-1">
            <label htmlFor="asset-percent" className="text-sm font-medium">
              事業専用割合（%）
            </label>
            <Input
              id="asset-percent"
              inputMode="decimal"
              autoComplete="off"
              value={values.percent}
              onChange={(e) => set({ percent: e.target.value })}
              aria-invalid={ratioError ? true : undefined}
              aria-describedby="asset-percent-error"
            />
            <FieldError id="asset-percent-error" message={ratioError} />
          </div>
          <div className="grid gap-1">
            <label htmlFor="asset-account" className="text-sm font-medium">
              資産の勘定
            </label>
            <NativeSelect
              id="asset-account"
              value={values.assetAccountId}
              onChange={(e) => set({ assetAccountId: e.target.value })}
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
            <label htmlFor="asset-method" className="text-sm font-medium">
              償却の方法
            </label>
            <NativeSelect id="asset-method" value={METHOD} onChange={() => {}}>
              <option value={METHOD}>少額減価償却資産の特例（措置法28条の2）</option>
            </NativeSelect>
          </div>
          <JournalSelect
            entityId={entityId}
            acquiredOn={values.acquiredOn}
            value={values.linkedJournalId}
            onChange={(id) => set({ linkedJournalId: id })}
          />
          <div className="grid gap-1">
            <label htmlFor="asset-note" className="text-sm font-medium">
              備考
            </label>
            <Input
              id="asset-note"
              autoComplete="off"
              value={values.note}
              onChange={(e) => set({ note: e.target.value })}
            />
          </div>
          {editing && (
            <div className="grid gap-1">
              <label htmlFor="asset-reason" className="text-sm font-medium">
                変更の理由
              </label>
              <Input
                id="asset-reason"
                autoComplete="off"
                value={values.reason}
                onChange={(e) => set({ reason: e.target.value })}
              />
            </div>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending}>
              {editing ? "更新" : "登録"}
            </Button>
            {editing && (
              <Button type="button" variant="outline" onClick={onDone}>
                キャンセル
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
