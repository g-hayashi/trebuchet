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
import { postReceiptJournal, receiptQuery } from "@/features/receipts/api";
import { journalSourceOf, suggestionOf } from "@/features/receipts/journal-source";
import { useReceiptReading } from "@/features/receipts/reading";
import { today } from "@/lib/dates";
import { invalidateLedger } from "@/lib/queries";

/**
 * correctsJournalId を付けて開くと、その仕訳の訂正仕訳を起票する（FR-019a）。
 * receiptId を付けて開くと、その証憑の値を初期値にして仕訳を作り、証憑に結びつける（010 FR-010）
 */
const NewJournalSearch = z.object({ correctsJournalId: Id.optional(), receiptId: Id.optional() });

export const Route = createFileRoute("/e/$entityId/journals/new")({
  validateSearch: NewJournalSearch,
  component: NewJournalPage,
});

function NewJournalPage() {
  const { entityId } = Route.useParams();
  const { correctsJournalId, receiptId } = Route.useSearch();
  const corrects = useQuery({
    ...journalQuery(entityId, correctsJournalId ?? ""),
    enabled: correctsJournalId !== undefined,
  });
  const receipt = useQuery({
    ...receiptQuery(entityId, receiptId ?? ""),
    enabled: receiptId !== undefined,
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
  // 証憑から作る（1 つのトランザクションで仕訳の登録と結びつけ）。登録したあとは入力を閉じて二重に登録しない
  // AI の候補（科目・税区分）は初期値にだけ使う。使ったときは readingId を付けて、保存した仕訳との
  // 一致を記録する（010 US4）。設定を読み終える前にフォームを開かない（初期値が後から変わらないように）
  const { ready: readingReady, usable: reading } = useReceiptReading(receipt.data);
  const suggestion =
    accounts.data && taxCategories.data
      ? suggestionOf(reading, accounts.data, taxCategories.data)
      : undefined;
  const readingId = reading?.status === "succeeded" ? reading.id : undefined;
  const saveFromReceipt = useMutation({
    mutationFn: (json: JournalInput) =>
      postReceiptJournal(entityId, receiptId ?? "", {
        journal: json,
        ...(readingId !== undefined && { readingId }),
      }),
    onSuccess: () => invalidateLedger(queryClient, entityId),
  });
  const saved = save.isSuccess ? save.data : undefined;
  const savedFromReceipt = saveFromReceipt.isSuccess ? saveFromReceipt.data : undefined;
  const receiptSource =
    receipt.data && partners.data && readingReady
      ? journalSourceOf(receipt.data, partners.data, defaultDate, suggestion)
      : undefined;

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
        {savedFromReceipt && (
          <div className="rounded-md border px-3 py-2 text-sm">
            <p className="font-medium">
              仕訳 No.{savedFromReceipt.journal.journalNo} を登録し、証憑に結びつけました。
            </p>
            <Link
              to="/e/$entityId/receipts/$receiptId"
              params={{ entityId, receiptId: savedFromReceipt.receipt.id }}
              className="text-primary underline underline-offset-4"
            >
              証憑に戻る
            </Link>
          </div>
        )}
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
            日付・科目・金額・摘要を入力します。複数行の仕訳は「詳細」で入力できます。
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
          <ApiErrorMessage error={loadError ?? corrects.error ?? receipt.error} />
          {queries.some((q) => q.isPending) && !loadError && (
            <p className="text-sm text-muted-foreground">読み込み中…</p>
          )}
          {receiptId !== undefined && receipt.data?.deleted && (
            <p role="note" className="text-sm">
              この証憑は削除済みのため、仕訳を作れません。
            </p>
          )}
          {suggestion !== undefined && reading !== undefined && !savedFromReceipt && (
            <p
              role="note"
              aria-label="AI の候補"
              className="mb-3 rounded-md border px-3 py-2 text-sm"
            >
              AI の候補: 科目 {suggestion.account.name}
              {suggestion.taxCategory !== null && `、税区分 ${suggestion.taxCategory.name}`}
              。確かめてから登録してください。
              {reading.reason !== null && reading.reason !== "" && ` 説明: ${reading.reason}`}
            </p>
          )}
          {accounts.data &&
            partners.data &&
            tags.data &&
            taxSettings.data &&
            taxCategories.data &&
            !savedFromReceipt &&
            (receiptId === undefined ? (
              <JournalForm
                key={formKey}
                initialMode={correctsJournalId ? "detailed" : "quick"}
                focusAfterSave={formKey > 0}
                autoBalance
                submitLabel="登録"
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
            ) : (
              receiptSource &&
              !receipt.data?.deleted && (
                <JournalForm
                  submitLabel="登録"
                  entityId={entityId}
                  accounts={accounts.data}
                  partners={partners.data}
                  tags={tags.data}
                  taxSettings={taxSettings.data}
                  taxCategories={taxCategories.data}
                  defaultDate={receiptSource.date}
                  journal={receiptSource}
                  onSubmit={(input) => saveFromReceipt.mutateAsync(input)}
                />
              )
            ))}
        </CardContent>
      </Card>
    </main>
  );
}
