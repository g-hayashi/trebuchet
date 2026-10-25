import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { SaveNotice } from "@/components/ui/save-notice";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type Account, accountsQuery, subAccountsQuery } from "@/features/accounts/api";
import { blueReturnKeys, type HomeUseAllocationRow, putHomeUse } from "./api";
import { formatRatioAsPercent, parsePercentToRatio } from "./ratio";

const RATIO_ERROR = "事業専用割合は 0〜100 の数値を小数第2位までで入力してください";

type Values = {
  accountId: string;
  subAccountId: string;
  percent: string;
  basis: string;
  changeReason: string;
};
const EMPTY: Values = { accountId: "", subAccountId: "", percent: "", basis: "", changeReason: "" };

/** 補助科目の名前。登録の一覧の表示だけに使う */
function SubAccountName({
  entityId,
  accountId,
  subAccountId,
}: {
  entityId: string;
  accountId: string;
  subAccountId: string;
}) {
  const { data } = useQuery(subAccountsQuery(entityId, accountId));
  return <> ／ {data?.find((s) => s.id === subAccountId)?.name ?? ""}</>;
}

/**
 * 家事按分の登録（FR-012〜013）。科目は費用の科目だけ。割合は「%」で小数第2位まで入力し、
 * 万分率に変換して送る（変換は入力の整形。割合の範囲・根拠・理由の必須は API が判定する）。
 * 割合 0% の保存の前に確認する（全額が家事分になり、その科目は経費にならない）
 */
export function HomeUseForm({
  entityId,
  year,
  allocations,
  previousYear,
}: {
  entityId: string;
  year: string;
  allocations: readonly HomeUseAllocationRow[];
  previousYear: readonly HomeUseAllocationRow[];
}) {
  const queryClient = useQueryClient();
  const { data: accounts } = useQuery(accountsQuery(entityId));
  const [values, setValues] = useState<Values>(EMPTY);
  const [ratioError, setRatioError] = useState<string>();
  const [confirmZero, setConfirmZero] = useState(false);

  const expenseAccounts = (accounts ?? []).filter((a) => a.category === "expense" && a.isActive);
  const nameOf = (id: string) => accounts?.find((a: Account) => a.id === id)?.name ?? "";
  const { data: subAccounts } = useQuery({
    ...subAccountsQuery(entityId, values.accountId),
    enabled: values.accountId !== "",
  });
  const activeSubs = (subAccounts ?? []).filter((s) => s.isActive);

  const previousRatio = previousYear.find(
    (p) => p.accountId === values.accountId && (p.subAccountId ?? "") === values.subAccountId,
  )?.businessRatio;

  const save = useMutation({
    mutationFn: (ratio: number) =>
      putHomeUse(entityId, year, {
        accountId: values.accountId,
        subAccountId: values.subAccountId === "" ? null : values.subAccountId,
        businessRatio: ratio,
        basis: values.basis,
        changeReason: values.changeReason.trim() === "" ? null : values.changeReason,
      }),
    onSuccess: () => {
      setValues(EMPTY);
      return queryClient.invalidateQueries({ queryKey: blueReturnKeys.year(entityId, year) });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const ratio = parsePercentToRatio(values.percent);
    if (ratio === undefined) {
      setRatioError(RATIO_ERROR);
      return;
    }
    setRatioError(undefined);
    if (ratio === 0) {
      setConfirmZero(true);
      return;
    }
    save.mutate(ratio);
  };

  const edit = (row: HomeUseAllocationRow) => {
    setRatioError(undefined);
    setValues({
      accountId: row.accountId,
      subAccountId: row.subAccountId ?? "",
      percent: formatRatioAsPercent(row.businessRatio),
      basis: row.basis,
      changeReason: row.changeReason ?? "",
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>家事按分の登録</CardTitle>
        <CardDescription>
          自宅兼事務所の家賃や通信費など、費用の科目のうち事業に使う割合を登録します。登録しただけでは帳簿は変わりません。下の「決算整理の仕訳の案」で仕訳を登録すると、家事分が事業主貸に振り替わります。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {allocations.length > 0 && (
          <Table aria-label="按分の登録">
            <TableHeader>
              <TableRow>
                <TableHead>科目</TableHead>
                <TableHead className="text-right">事業専用割合</TableHead>
                <TableHead>根拠</TableHead>
                <TableHead>変更の理由</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {allocations.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    {nameOf(a.accountId)}
                    {a.subAccountId !== null && (
                      <SubAccountName
                        entityId={entityId}
                        accountId={a.accountId}
                        subAccountId={a.subAccountId}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRatioAsPercent(a.businessRatio)}%
                  </TableCell>
                  <TableCell>{a.basis}</TableCell>
                  <TableCell>{a.changeReason ?? ""}</TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm" onClick={() => edit(a)}>
                      {`${nameOf(a.accountId)}を編集`}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {previousYear.length > 0 && (
          <Table aria-label="前の年度の按分">
            <TableHeader>
              <TableRow>
                <TableHead>科目</TableHead>
                <TableHead className="text-right">事業専用割合</TableHead>
                <TableHead>根拠</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {previousYear.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    {nameOf(p.accountId)}
                    {p.subAccountId !== null && (
                      <SubAccountName
                        entityId={entityId}
                        accountId={p.accountId}
                        subAccountId={p.subAccountId}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRatioAsPercent(p.businessRatio)}%
                  </TableCell>
                  <TableCell>{p.basis}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <form noValidate onSubmit={submit} className="grid gap-3 sm:max-w-xl">
          <div className="grid gap-1">
            <label htmlFor="home-use-account" className="text-sm font-medium">
              科目
            </label>
            <NativeSelect
              id="home-use-account"
              value={values.accountId}
              onChange={(e) =>
                setValues((v) => ({ ...v, accountId: e.target.value, subAccountId: "" }))
              }
            >
              <option value="">選択してください</option>
              {expenseAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          {activeSubs.length > 0 && (
            <div className="grid gap-1">
              <label htmlFor="home-use-sub" className="text-sm font-medium">
                補助科目
              </label>
              <NativeSelect
                id="home-use-sub"
                value={values.subAccountId}
                onChange={(e) => setValues((v) => ({ ...v, subAccountId: e.target.value }))}
              >
                <option value="">科目全体</option>
                {activeSubs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="grid gap-1">
            <label htmlFor="home-use-percent" className="text-sm font-medium">
              事業専用割合（%）
            </label>
            <Input
              id="home-use-percent"
              inputMode="decimal"
              autoComplete="off"
              value={values.percent}
              onChange={(e) => setValues((v) => ({ ...v, percent: e.target.value }))}
              aria-invalid={ratioError ? true : undefined}
              aria-describedby="home-use-percent-error"
            />
            <FieldError id="home-use-percent-error" message={ratioError} />
            {previousRatio !== undefined && (
              <p className="text-sm text-muted-foreground">
                前の年度は {formatRatioAsPercent(previousRatio)}%
                でした。割合を変えるときは、変更の理由を入力してください。
              </p>
            )}
          </div>
          <div className="grid gap-1">
            <label htmlFor="home-use-basis" className="text-sm font-medium">
              根拠
            </label>
            <Input
              id="home-use-basis"
              autoComplete="off"
              placeholder="例: 床面積 15㎡／50㎡"
              value={values.basis}
              onChange={(e) => setValues((v) => ({ ...v, basis: e.target.value }))}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor="home-use-reason" className="text-sm font-medium">
              変更の理由
            </label>
            <Input
              id="home-use-reason"
              autoComplete="off"
              value={values.changeReason}
              onChange={(e) => setValues((v) => ({ ...v, changeReason: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              保存
            </Button>
            <SaveNotice message={save.isSuccess ? "保存しました。" : ""} />
          </div>
        </form>
        <ApiErrorMessage error={save.error} />

        <Dialog open={confirmZero} onOpenChange={setConfirmZero}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>事業専用割合が 0% です</DialogTitle>
              <DialogDescription>
                全額が家事分になり、この科目は経費になりません。保存しますか？
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmZero(false)}>
                戻る
              </Button>
              <Button
                onClick={() => {
                  setConfirmZero(false);
                  save.mutate(0);
                }}
              >
                保存する
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
