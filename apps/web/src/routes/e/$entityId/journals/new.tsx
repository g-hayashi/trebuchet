import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Id, type JournalInput } from "@trebuchet/schema";
import { useState } from "react";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { accountsQuery } from "@/features/accounts/api";
import { taxCategoriesQuery, taxSettingsQuery } from "@/features/entities/api";
import { journalQuery, postJournal } from "@/features/journals/api";
import { JournalForm } from "@/features/journals/JournalForm";
import { partnersQuery, tagsQuery } from "@/features/masters/api";
import { today } from "@/lib/dates";
import { invalidateLedger } from "@/lib/queries";

/** correctsJournalId を付けて開くと、その仕訳の訂正仕訳を起票する（FR-019a） */
const NewJournalSearch = z.object({ correctsJournalId: Id.optional() });

export const Route = createFileRoute("/e/$entityId/journals/new")({
  validateSearch: NewJournalSearch,
  component: NewJournalPage,
});

function NewJournalPage() {
  const { entityId } = Route.useParams();
  const { correctsJournalId } = Route.useSearch();
  const corrects = useQuery({
    ...journalQuery(entityId, correctsJournalId ?? ""),
    enabled: correctsJournalId !== undefined,
  });
  const queryClient = useQueryClient();
  const accounts = useQuery(accountsQuery(entityId));
  const partners = useQuery(partnersQuery(entityId));
  const tags = useQuery(tagsQuery(entityId));
  const taxSettings = useQuery(taxSettingsQuery(entityId));
  const taxCategories = useQuery(taxCategoriesQuery(entityId));
  const queries = [accounts, partners, tags, taxSettings, taxCategories];
  const loadError = queries.find((q) => q.error)?.error;

  const [formKey, setFormKey] = useState(0);
  const [defaultDate, setDefaultDate] = useState(today);

  const save = useMutation({
    mutationFn: (json: JournalInput) => postJournal(entityId, json),
    onSuccess: async ({ journal }) => {
      // 続けて入力できるよう、日付を残してフォームを空にする
      setDefaultDate(journal.date);
      setFormKey((k) => k + 1);
      await invalidateLedger(queryClient, entityId);
    },
  });
  const saved = save.isSuccess ? save.data : undefined;

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">
          {correctsJournalId ? "訂正仕訳の入力" : "仕訳の入力"}
        </h1>
        <Link
          to="/e/$entityId/journals"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          仕訳の一覧へ
        </Link>
      </div>
      <div role="status" aria-label="登録の結果">
        {saved && (
          <div
            className={
              saved.warnings.length > 0
                ? "rounded-md border border-amber-500/60 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                : "rounded-md border px-3 py-2 text-sm"
            }
          >
            <p className="font-medium">仕訳 No.{saved.journal.journalNo} を登録しました。</p>
            {saved.warnings.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {saved.warnings.map((w) => (
                  <li key={w.code}>{w.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{correctsJournalId ? "訂正仕訳" : "新しい仕訳"}</CardTitle>
          <CardDescription>
            借方と貸方を1行以上ずつ入力します。借方合計と貸方合計が一致すると登録できます。
          </CardDescription>
          {correctsJournalId && (
            <p className="text-sm">
              訂正元の仕訳:{" "}
              {corrects.data ? (
                <Link
                  to="/e/$entityId/journals/$journalId"
                  params={{ entityId, journalId: correctsJournalId }}
                  className="text-primary underline underline-offset-4"
                >
                  No.{corrects.data.journal.journalNo}（{corrects.data.journal.date}）
                </Link>
              ) : (
                "読み込み中…"
              )}
              。締め済みの年度の仕訳は直接直せないため、差額などを当年度の日付で起票します。
            </p>
          )}
        </CardHeader>
        <CardContent>
          <ApiErrorMessage error={loadError ?? corrects.error} />
          {queries.some((q) => q.isPending) && !loadError && (
            <p className="text-sm text-muted-foreground">読み込み中…</p>
          )}
          {accounts.data &&
            partners.data &&
            tags.data &&
            taxSettings.data &&
            taxCategories.data && (
              <JournalForm
                key={formKey}
                entityId={entityId}
                accounts={accounts.data}
                partners={partners.data}
                tags={tags.data}
                taxSettings={taxSettings.data}
                taxCategories={taxCategories.data}
                defaultDate={defaultDate}
                correctsJournalId={correctsJournalId}
                onSubmit={(input) => save.mutateAsync(input)}
              />
            )}
        </CardContent>
      </Card>
    </main>
  );
}
