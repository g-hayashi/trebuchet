import { useMutation, useQuery } from "@tanstack/react-query";
import type { AiSuggestion, TaxCategoryCode } from "@trebuchet/schema";
import { useState } from "react";
import { useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import type { Account } from "@/features/accounts/api";
import { aiSettingsQuery } from "@/features/ai-settings/api";
import type { TaxCategory } from "@/features/entities/api";
import type { JournalFormControl } from "@/features/journals/JournalForm";
import { postJournalAiSuggestion } from "./api";

/** どの場面の入力への候補か。011 は仕訳の入力（journal_entry）だけ */
type Scene = "journal_entry";

type Result = { key: string; suggestion: AiSuggestion | null };

/**
 * 外部の AI が有効なときだけ、摘要・金額・日付から科目と税区分の候補を出す（011/FR-060）。
 * 候補は「入れる」を押すまで欄に入れず、登録はいつも利用者が行う。
 * 外部の AI が無効なら何も出さない（AI の API も呼ばない）
 */
export function AiSuggestionPanel({
  scene,
  form,
  entityId,
  accounts,
  taxCategories,
}: {
  scene: Scene;
  form: JournalFormControl;
  entityId: string;
  accounts: Account[];
  taxCategories: TaxCategory[];
}) {
  // 入力フォームの作り直し（登録後など）のたびに取り直さない。設定の保存は同じキーを無効にする
  const settings = useQuery({ ...aiSettingsQuery(), staleTime: 60_000 });
  const values = useWatch({ control: form.control });
  const [result, setResult] = useState<Result>();
  const request = useMutation({ mutationFn: postJournalAiSuggestion.bind(null, entityId) });
  if (scene !== "journal_entry" || !settings.data?.externalEnabled) return null;

  const date = values.date ?? "";
  const amount = values.lines?.[0]?.amount;
  const memo = (values.memo ?? "").trim();
  // 入力が変わったら古い候補は出さない
  const key = JSON.stringify([date, amount, memo]);
  const current = result?.key === key ? result : undefined;
  const account = current?.suggestion
    ? accounts.find((a) => a.code === current.suggestion?.accountCode && a.isActive)
    : undefined;
  const suggestion = account ? current?.suggestion : null;

  function ask() {
    if (!date || !memo || typeof amount !== "number" || !Number.isInteger(amount)) return;
    request.mutate(
      { date, amount, memo },
      { onSuccess: (data) => setResult({ key, suggestion: data.suggestion }) },
    );
  }

  /** 収益の科目は貸方、それ以外（経費・資産など、区分から決められないものを含む）は借方へ入れる */
  function apply(found: Account, taxCategory: TaxCategoryCode) {
    const index = found.category === "revenue" ? 1 : 0;
    form.setValue(`lines.${index}.accountId`, found.id, { shouldDirty: true });
    form.setValue(`lines.${index}.taxCategory`, taxCategory, { shouldDirty: true });
  }

  const ready = !!date && !!memo && typeof amount === "number" && Number.isInteger(amount);
  return (
    <section aria-label="AI の候補" className="grid gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={ask} disabled={!ready || request.isPending}>
          AI で候補を出す
        </Button>
        <p className="text-xs text-muted-foreground">
          日付・金額・摘要だけを外部の AI
          へ送ります（個人情報は伏せます）。入れる前に確認してください。
        </p>
      </div>
      {request.isPending && <p className="text-sm">候補を確認しています…</p>}
      <ApiErrorMessage error={request.error} />
      {current && !suggestion && <p className="text-sm">候補はありませんでした</p>}
      {suggestion && account && (
        <div className="grid gap-2 text-sm">
          <dl className="grid gap-1">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">科目</dt>
              <dd>
                {account.code} {account.name}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">税区分</dt>
              <dd>
                {taxCategories.find((tax) => tax.code === suggestion.taxCategory)?.name ??
                  suggestion.taxCategory}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">確信度</dt>
              <dd>{suggestion.confidence}%</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">根拠</dt>
              <dd>{suggestion.reason}</dd>
            </div>
          </dl>
          <div>
            <Button onClick={() => apply(account, suggestion.taxCategory)}>入れる</Button>
          </div>
        </div>
      )}
    </section>
  );
}
