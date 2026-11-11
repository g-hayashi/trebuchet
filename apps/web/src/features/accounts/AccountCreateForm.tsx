import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AccountCategory, AccountCreate, ALLOWED_SECTIONS } from "@trebuchet/schema";
import { useId } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CATEGORY_LABELS, SECTION_LABELS } from "@/lib/accounts";
import { cn } from "@/lib/utils";
import { type Account, accountKeys, postAccount } from "./api";

type AccountCreateInput = z.input<typeof AccountCreate>;

/**
 * 科目を作るフォーム（名称・区分・決算書の区分・欄番号, POST /accounts）。
 * 勘定科目の画面（inline）と、取込の対応表の「新しい科目」のダイアログ（stacked）で使う
 */
export function AccountCreateForm({
  entityId,
  defaultName = "",
  submitLabel,
  layout,
  onCreated,
}: {
  entityId: string;
  defaultName?: string | undefined;
  submitLabel: string;
  layout: "inline" | "stacked";
  onCreated?: ((account: Account) => void) | undefined;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const form = useForm<AccountCreateInput, unknown, AccountCreate>({
    resolver: zodResolver(AccountCreate),
    defaultValues: { name: defaultName, category: "expense", reportSection: "PL_EXPENSE" },
  });
  const { errors } = form.formState;
  const category = form.watch("category");

  const create = useMutation({
    mutationFn: (input: AccountCreate) => postAccount(entityId, input),
    onSuccess: async (account) => {
      form.reset({ name: "", category, reportSection: form.getValues("reportSection") });
      await queryClient.invalidateQueries({ queryKey: accountKeys.list(entityId) });
      onCreated?.(account);
    },
  });

  return (
    <form
      noValidate
      className={cn(
        "grid gap-4",
        layout === "inline" && "md:grid-cols-[2fr_1fr_1fr_6rem_auto] md:items-start",
      )}
      onSubmit={form.handleSubmit((values) => create.mutate(values))}
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
        <Label htmlFor={`${id}-category`}>区分</Label>
        <NativeSelect
          id={`${id}-category`}
          {...form.register("category", {
            onChange: (e: { target: { value: string } }) => {
              const parsed = AccountCategory.safeParse(e.target.value);
              const first = parsed.success ? ALLOWED_SECTIONS[parsed.data][0] : undefined;
              if (first) form.setValue("reportSection", first);
            },
          })}
        >
          {AccountCategory.options.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-section`}>決算書の区分</Label>
        {/* 区分を変えると選択肢が入れ替わるため、作り直して選んだ値を表示に反映する */}
        <NativeSelect key={category} id={`${id}-section`} {...form.register("reportSection")}>
          {ALLOWED_SECTIONS[category].map((s) => (
            <option key={s} value={s}>
              {SECTION_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-line`}>欄番号</Label>
        <Input
          id={`${id}-line`}
          inputMode="numeric"
          placeholder="任意"
          aria-invalid={errors.reportLine ? true : undefined}
          aria-describedby={`${id}-line-error`}
          {...form.register("reportLine", {
            setValueAs: (v: unknown) => (v === "" || v === undefined ? undefined : Number(v)),
          })}
        />
        <FieldError id={`${id}-line-error`} message={errors.reportLine?.message} />
      </div>
      <Button
        type="submit"
        className={cn(layout === "inline" ? "md:mt-6" : "justify-self-end")}
        disabled={create.isPending}
      >
        {submitLabel}
      </Button>
      <ApiErrorMessage
        error={create.error}
        className={cn(layout === "inline" && "md:col-span-5")}
      />
    </form>
  );
}
