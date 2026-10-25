import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AccountingMethod,
  TaxpayerStatus,
  TaxSettingInput,
  type TaxSettingsPut,
} from "@trebuchet/schema";
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
import {
  entityKeys,
  putTaxSettings,
  type TaxSetting,
  taxSettingsQuery,
} from "@/features/entities/api";
import { previousDay } from "@/lib/dates";

export const Route = createFileRoute("/e/$entityId/tax-settings")({
  component: TaxSettingsPage,
});

const TAXPAYER_STATUS_LABELS: Record<TaxpayerStatus, string> = {
  exempt: "免税",
  general: "課税（本則）",
  simplified: "課税（簡易）",
  two_tenths: "課税（2割特例）",
};

const ACCOUNTING_METHOD_LABELS: Record<AccountingMethod, string> = {
  tax_included: "税込経理",
  tax_excluded: "税抜経理",
};

/** 設定を適用開始日の順に並べ、適用終了日（次の設定の前日。最後は null）を付ける */
function withEffectiveTo(settings: readonly TaxSetting[]) {
  const sorted = [...settings].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return sorted.map((s, i) => {
    const next = sorted[i + 1];
    return { ...s, effectiveTo: next === undefined ? null : previousDay(next.effectiveFrom) };
  });
}

const toInput = ({ effectiveFrom, taxpayerStatus, accountingMethod }: TaxSetting) => ({
  effectiveFrom,
  taxpayerStatus,
  accountingMethod,
});

function TaxSettingsPage() {
  const { entityId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: settings, isPending, error } = useQuery(taxSettingsQuery(entityId));
  const form = useForm<z.input<typeof TaxSettingInput>, unknown, TaxSettingInput>({
    resolver: zodResolver(TaxSettingInput),
    defaultValues: {
      effectiveFrom: "",
      taxpayerStatus: "general",
      accountingMethod: "tax_included",
    },
  });
  const { errors } = form.formState;

  // 一覧の全体を置き換える API のため、追加・削除のどちらも全件を送る
  const replace = useMutation({
    mutationFn: (json: TaxSettingsPut) => putTaxSettings(entityId, json),
    onSuccess: async (taxSettings) => {
      queryClient.setQueryData(entityKeys.taxSettings(entityId), taxSettings);
      await queryClient.invalidateQueries({ queryKey: entityKeys.taxSettings(entityId) });
    },
  });

  const rows = settings ? withEffectiveTo(settings) : [];

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">消費税の設定</h1>
      <Card>
        <CardHeader>
          <CardTitle>適用期間ごとの設定</CardTitle>
          <CardDescription>
            仕訳の日付に応じて、その日を含む期間の設定が使われます。期間に空白や重複は作れません。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={error} />
          {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {settings && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>適用期間</TableHead>
                  <TableHead>課税区分</TableHead>
                  <TableHead>経理方式</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="tabular-nums">
                      {row.effectiveFrom} 〜 {row.effectiveTo ?? ""}
                    </TableCell>
                    <TableCell>{TAXPAYER_STATUS_LABELS[row.taxpayerStatus]}</TableCell>
                    <TableCell>{ACCOUNTING_METHOD_LABELS[row.accountingMethod]}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        disabled={rows.length <= 1 || replace.isPending}
                        onClick={() => {
                          if (!window.confirm(`${row.effectiveFrom} からの設定を削除しますか？`)) {
                            return;
                          }
                          replace.mutate(settings.filter((s) => s.id !== row.id).map(toInput));
                        }}
                      >
                        削除
                        <span className="sr-only">（{row.effectiveFrom} からの設定）</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>設定を追加</CardTitle>
          <CardDescription>
            例: 2027-01-01 から課税（本則）・税抜経理。前の設定はその前日までになります。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            className="grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-start"
            onSubmit={form.handleSubmit(async (values) => {
              if (!settings) return;
              try {
                await replace.mutateAsync([...settings.map(toInput), values]);
              } catch {
                return; // エラーはフォームの下に表示する
              }
              form.reset();
            })}
          >
            <div className="grid gap-2">
              <Label htmlFor="tax-effective-from">適用開始日</Label>
              <Input
                id="tax-effective-from"
                type="date"
                aria-invalid={errors.effectiveFrom ? true : undefined}
                aria-describedby="tax-effective-from-error"
                {...form.register("effectiveFrom")}
              />
              <FieldError id="tax-effective-from-error" message={errors.effectiveFrom?.message} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tax-status">課税区分</Label>
              <NativeSelect id="tax-status" {...form.register("taxpayerStatus")}>
                {TaxpayerStatus.options.map((s) => (
                  <option key={s} value={s}>
                    {TAXPAYER_STATUS_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tax-method">経理方式</Label>
              <NativeSelect id="tax-method" {...form.register("accountingMethod")}>
                {AccountingMethod.options.map((m) => (
                  <option key={m} value={m}>
                    {ACCOUNTING_METHOD_LABELS[m]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" className="md:mt-6" disabled={!settings || replace.isPending}>
              追加して保存
            </Button>
            <ApiErrorMessage error={replace.error} className="md:col-span-4" />
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
