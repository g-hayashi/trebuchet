import { useMutation, useQuery } from "@tanstack/react-query";
import type { Purpose } from "@trebuchet/schema";
import { PURPOSES } from "@trebuchet/schema";
import { useId, useState } from "react";
import { Loading } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { accountsQuery } from "@/features/accounts/api";
import { taxCategoriesQuery } from "@/features/entities/api";
import { partnersQuery } from "@/features/masters/api";
import { RULE_DESCRIPTION_MAX } from "@/lib/limits";
import { patchRule, type RuleView } from "./api";
import { PURPOSE_LABELS } from "./labels";

/**
 * ルールの編集（H:§5.3、006/FR-024）: 相手の科目・税区分・判定・取引先・摘要を直す。
 * 適用の回数と修正の回数は直せない。補助科目は、科目を変えると外れる（サーバーの規則）
 */
export function RuleEditor({
  entityId,
  rule,
  onSaved,
  onClose,
}: {
  entityId: string;
  rule: RuleView;
  onSaved: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const accounts = useQuery(accountsQuery(entityId));
  const partners = useQuery(partnersQuery(entityId));
  const taxCategories = useQuery(taxCategoriesQuery(entityId));
  const [counterAccountId, setCounterAccountId] = useState(rule.counterAccountId);
  const [taxCategory, setTaxCategory] = useState<string>(rule.taxCategory);
  const [purpose, setPurpose] = useState<Purpose>(rule.purpose);
  const [partnerId, setPartnerId] = useState(rule.partnerId ?? "");
  const [description, setDescription] = useState(rule.descriptionTemplate ?? "");

  const save = useMutation({
    mutationFn: () =>
      patchRule(entityId, rule.id, {
        counterAccountId,
        taxCategory: taxCategory as RuleView["taxCategory"],
        purpose,
        partnerId: partnerId === "" ? null : partnerId,
        descriptionTemplate: description.trim() === "" ? null : description.trim(),
      }),
    onSuccess: onSaved,
  });

  const loadError = [accounts, partners, taxCategories].find((q) => q.error)?.error;
  const ready = accounts.data && partners.data && taxCategories.data;

  return (
    <section aria-label="ルールの編集" className="grid gap-4 rounded-md border px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="font-medium">ルールの編集: {rule.normalizedContent}</h2>
        <Button variant="ghost" onClick={onClose}>
          閉じる
        </Button>
      </div>
      <ApiErrorMessage error={loadError} />
      {!ready && !loadError && <Loading />}
      {ready && (
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.reset();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid content-start gap-1">
              <Label htmlFor={`${id}-account`}>相手の科目</Label>
              <NativeSelect
                id={`${id}-account`}
                value={counterAccountId}
                onChange={(e) => setCounterAccountId(e.target.value)}
              >
                {accounts.data
                  .filter((a) => a.isActive || a.id === rule.counterAccountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </NativeSelect>
            </div>
            <div className="grid content-start gap-1">
              <Label htmlFor={`${id}-tax`}>税区分</Label>
              <NativeSelect
                id={`${id}-tax`}
                value={taxCategory}
                onChange={(e) => setTaxCategory(e.target.value)}
              >
                {taxCategories.data.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid content-start gap-1">
              <Label htmlFor={`${id}-purpose`}>判定</Label>
              <NativeSelect
                id={`${id}-purpose`}
                value={purpose}
                onChange={(e) => setPurpose(e.target.value as Purpose)}
              >
                {PURPOSES.map((p) => (
                  <option key={p} value={p}>
                    {PURPOSE_LABELS[p]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid content-start gap-1">
              <Label htmlFor={`${id}-partner`}>取引先</Label>
              <NativeSelect
                id={`${id}-partner`}
                value={partnerId}
                onChange={(e) => setPartnerId(e.target.value)}
              >
                <option value="">なし</option>
                {partners.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid content-start gap-1 sm:col-span-2">
              <Label htmlFor={`${id}-description`}>摘要</Label>
              <Input
                id={`${id}-description`}
                maxLength={RULE_DESCRIPTION_MAX}
                autoComplete="off"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">空欄なら、明細の内容を摘要にします。</p>
            </div>
          </div>
          <div>
            <Button type="submit" disabled={save.isPending}>
              保存
            </Button>
          </div>
          <ApiErrorMessage error={save.error} />
        </form>
      )}
    </section>
  );
}
