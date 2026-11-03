import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReceiptDetail, ReceiptReadingView } from "@trebuchet/schema";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { accountsQuery } from "@/features/accounts/api";
import { taxCategoriesQuery } from "@/features/entities/api";
import { formatDateTime, formatYen } from "@/lib/format";
import { postReceiptReading, receiptKeys } from "./api";
import { useReceiptReading } from "./reading";

/** 失敗の表示（FR-017）。`errorCode` は domain の `RECEIPT_READING_ERROR` の文字列 */
function failureText(reading: ReceiptReadingView): string {
  switch (reading.errorCode) {
    case "RECEIPT_READ_UNSUPPORTED":
      return "この形式のファイルは AI で読み取れません。";
    case "RECEIPT_CONVERSION_FAILED":
      return "画像を読み取り用に変換できませんでした。";
    case "AI_TIMEOUT":
      return "時間切れで読み取れませんでした。";
    case "AI_HTTP_ERROR":
      return "AI に接続できませんでした。";
    case "AI_INVALID_OUTPUT":
      return "AI の応答を読み取れませんでした。";
  }
  switch (reading.status) {
    case "timeout":
      return "時間切れで読み取れませんでした。";
    case "invalid":
      return "AI の応答を読み取れませんでした。";
    default:
      return "AI に接続できませんでした。";
  }
}

const NONE = "候補なし";

/**
 * 証憑の詳細の「AI の読み取り」（US4、FR-014〜017）。設定「証憑の画像を外部の AI に送る」が有効なときだけ
 * 読み取りの操作を出す。候補は AI の候補として示し（入力欄の初期値になるのは `ReceiptFieldsForm`）、
 * 失敗しても証憑は保存されていて、手入力で続けられる
 */
export function ReceiptReadingNote({
  entityId,
  receipt,
}: {
  entityId: string;
  receipt: ReceiptDetail;
}) {
  const queryClient = useQueryClient();
  const { enabled, latest } = useReceiptReading(receipt);

  const read = useMutation({
    mutationFn: () => postReceiptReading(entityId, receipt.id),
    onSuccess: async (reading) => {
      // 候補の説明（reason）は応答にだけ入るので、詳細のキャッシュに足して画面に残す
      queryClient.setQueryData<ReceiptDetail>(receiptKeys.detail(entityId, receipt.id), (prev) =>
        prev === undefined ? prev : { ...prev, readings: [...prev.readings, reading] },
      );
      await queryClient.invalidateQueries({ queryKey: receiptKeys.history(entityId, receipt.id) });
    },
  });

  const wantsAccount = latest?.status === "succeeded" && latest.candidates.accountCode !== null;
  const wantsTax = latest?.status === "succeeded" && latest.candidates.taxCategory !== null;
  const accounts = useQuery({ ...accountsQuery(entityId), enabled: wantsAccount });
  const taxCategories = useQuery({ ...taxCategoriesQuery(entityId), enabled: wantsTax });

  if (receipt.deleted) return null;

  return (
    <section aria-label="AI の読み取り">
      <Card>
        <CardHeader>
          <CardTitle>AI の読み取り</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {!enabled ? (
            <p className="text-muted-foreground">
              証憑の画像を外部の AI に送る設定が無効のため、AI
              での読み取りは使えません。手入力で続けられます（
              <Link to="/settings/ai" className="underline">
                AI の設定
              </Link>
              ）。
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">
                画像を外部の AI
                に送り、取引年月日・金額・取引先・科目・税区分の候補を読み取ります。候補は入力欄の初期値になるだけで、保存するまで証憑の値は変わりません。
              </p>
              <div>
                <Button type="button" disabled={read.isPending} onClick={() => read.mutate()}>
                  {read.isPending ? "読み取り中…" : "AI で読み取る"}
                </Button>
              </div>
              <ApiErrorMessage error={read.error} />
              {latest !== undefined && (
                <ReadingResult
                  reading={latest}
                  accountName={
                    accounts.data?.find((a) => a.code === latest.candidates.accountCode)?.name
                  }
                  taxName={
                    taxCategories.data?.find((c) => c.code === latest.candidates.taxCategory)?.name
                  }
                />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function ReadingResult({
  reading,
  accountName,
  taxName,
}: {
  reading: ReceiptReadingView;
  accountName: string | undefined;
  taxName: string | undefined;
}) {
  const meta = `${formatDateTime(reading.readAt)}・${reading.model}`;
  if (reading.status !== "succeeded") {
    return (
      <div className="grid gap-1 rounded-md border px-3 py-2">
        <p>{failureText(reading)}証憑は保存されています。手入力で続けられます。</p>
        <p className="text-xs text-muted-foreground">{meta}</p>
      </div>
    );
  }
  const c = reading.candidates;
  return (
    <div className="grid gap-2 rounded-md border px-3 py-2">
      <p className="font-medium">AI の候補です。確かめてから保存してください。</p>
      <dl className="grid grid-cols-[8rem_1fr] gap-1">
        <Item label="取引年月日">{c.transactionDate}</Item>
        <Item label="金額">{c.amount === null ? null : formatYen(c.amount)}</Item>
        <Item label="取引先">{c.partnerName}</Item>
        <Item label="科目">
          {c.accountCode === null ? null : `${c.accountCode} ${accountName ?? ""}`.trim()}
        </Item>
        <Item label="税区分">{c.taxCategory === null ? null : (taxName ?? c.taxCategory)}</Item>
        <Item label="確信度">{reading.confidence === null ? null : `${reading.confidence}`}</Item>
      </dl>
      {reading.reason !== null && reading.reason !== "" && (
        <p>
          <span className="text-muted-foreground">説明: </span>
          {reading.reason}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{meta}</p>
    </div>
  );
}

const Item = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="break-all">{children === null || children === undefined ? NONE : children}</dd>
  </>
);
