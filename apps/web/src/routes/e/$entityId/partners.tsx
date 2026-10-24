import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PartnerInput } from "@trebuchet/schema";
import { Fragment, useId, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { type BillingTermsRow, billingTermsQuery } from "@/features/invoicing/api";
import { BillingTermsForm } from "@/features/invoicing/BillingTermsForm";
import { api, unwrap } from "@/lib/api";
import { formatYen } from "@/lib/format";
import { type Partner, partnersQuery, queryKeys } from "@/lib/queries";

export const Route = createFileRoute("/e/$entityId/partners")({
  component: PartnersPage,
});

const partnerApi = api.api.entities[":entityId"].partners;

function PartnersPage() {
  const { entityId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: partners, isPending, error } = useQuery(partnersQuery(entityId));
  const { data: billingTerms } = useQuery(billingTermsQuery(entityId));
  const termsByPartner = new Map((billingTerms ?? []).map((t) => [t.partnerId, t]));
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 請求の条件を編集中の取引先（US4） */
  const [billingId, setBillingId] = useState<string | null>(null);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.partners(entityId) });

  const create = useMutation({
    mutationFn: async (json: PartnerInput) =>
      unwrap(await partnerApi.$post({ param: { entityId }, json })),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: async ({ partnerId, json }: { partnerId: string; json: PartnerInput }) =>
      unwrap(await partnerApi[":partnerId"].$patch({ param: { entityId, partnerId }, json })),
    onSuccess: async () => {
      setEditingId(null);
      await invalidate();
    },
  });

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">取引先</h1>
      <Card>
        <CardHeader>
          <CardTitle>取引先を追加</CardTitle>
        </CardHeader>
        <CardContent>
          <PartnerForm
            submitLabel="追加する"
            pending={create.isPending}
            error={create.error}
            onSubmit={(json) => create.mutateAsync(json)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>取引先の一覧</CardTitle>
        </CardHeader>
        <CardContent>
          <ApiErrorMessage error={error} />
          {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {partners && partners.length === 0 && (
            <p className="text-sm text-muted-foreground">取引先はまだありません。</p>
          )}
          {partners && partners.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-16">敬称</TableHead>
                  <TableHead>メモ</TableHead>
                  <TableHead>請求</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {partners.map((p) =>
                  editingId === p.id ? (
                    <TableRow key={p.id} className="hover:bg-transparent">
                      <TableCell colSpan={5}>
                        <PartnerForm
                          partner={p}
                          submitLabel="保存"
                          pending={update.isPending}
                          error={update.error}
                          onSubmit={(json) => update.mutateAsync({ partnerId: p.id, json })}
                          onCancel={() => {
                            setEditingId(null);
                            update.reset();
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    <Fragment key={p.id}>
                      <TableRow>
                        <TableCell>{p.name}</TableCell>
                        <TableCell>{p.honorific ?? ""}</TableCell>
                        <TableCell className="whitespace-pre-wrap text-muted-foreground">
                          {p.memo ?? ""}
                        </TableCell>
                        <TableCell>{billingSummary(termsByPartner.get(p.id))}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              update.reset();
                              setEditingId(p.id);
                            }}
                          >
                            編集
                            <span className="sr-only">（{p.name}）</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-expanded={billingId === p.id}
                            onClick={() => setBillingId(billingId === p.id ? null : p.id)}
                          >
                            請求の条件
                            <span className="sr-only">（{p.name}）</span>
                          </Button>
                        </TableCell>
                      </TableRow>
                      {billingId === p.id && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={5}>
                            <BillingTermsForm
                              entityId={entityId}
                              partner={p}
                              terms={termsByPartner.get(p.id) ?? null}
                              onClose={() => setBillingId(null)}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ),
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

/** 一覧の「請求」の欄。条件がなければ「未設定」 */
function billingSummary(terms: BillingTermsRow | undefined): string {
  if (terms === undefined) return "未設定";
  return terms.billingType === "hourly"
    ? `時間単価 ${formatYen(terms.unitPrice ?? 0)} 円`
    : `月額 ${formatYen(terms.monthlyAmount ?? 0)} 円`;
}

type PartnerFormInput = z.input<typeof PartnerInput>;

function PartnerForm({
  partner,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  partner?: Partner;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (values: PartnerInput) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const id = useId();
  const form = useForm<PartnerFormInput, unknown, PartnerInput>({
    resolver: zodResolver(PartnerInput),
    defaultValues: {
      name: partner?.name ?? "",
      honorific: partner?.honorific ?? null,
      memo: partner?.memo ?? "",
    },
  });
  const { errors } = form.formState;

  return (
    <form
      noValidate
      className="grid gap-4 md:grid-cols-[2fr_8rem_3fr_auto] md:items-start"
      onSubmit={form.handleSubmit(async (values) => {
        try {
          await onSubmit(values);
        } catch {
          return; // エラーは error プロパティ（mutation の状態）で表示する
        }
        if (!partner) form.reset({ name: "", honorific: null, memo: "" });
      })}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>名称</Label>
        <Input
          id={`${id}-name`}
          autoComplete="off"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={`${id}-name-error`}
          {...form.register("name")}
        />
        <FieldError id={`${id}-name-error`} message={errors.name?.message} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-honorific`}>敬称</Label>
        <NativeSelect
          id={`${id}-honorific`}
          {...form.register("honorific", {
            setValueAs: (v: unknown) => (v === "" || v === null ? null : v),
          })}
        >
          <option value="">なし</option>
          <option value="様">様</option>
          <option value="御中">御中</option>
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-memo`}>メモ</Label>
        <Input
          id={`${id}-memo`}
          autoComplete="off"
          aria-invalid={errors.memo ? true : undefined}
          aria-describedby={`${id}-memo-error`}
          {...form.register("memo")}
        />
        <FieldError id={`${id}-memo-error`} message={errors.memo?.message} />
      </div>
      <div className="flex gap-2 md:mt-6">
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
      <ApiErrorMessage error={error} className="md:col-span-4" />
    </form>
  );
}
