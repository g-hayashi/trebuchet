import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { ReceiptQuery } from "@trebuchet/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { type ReceiptSearch, receiptSearchQuery } from "@/features/receipts/api";
import { ReceiptList } from "@/features/receipts/ReceiptList";
import { ReceiptSearchForm } from "@/features/receipts/ReceiptSearchForm";

/** URL の検索パラメーター（FR-008）。ページの指定（cursor・limit）は URL に残さない */
const ReceiptSearchParams = ReceiptQuery.omit({ cursor: true, limit: true });

export const Route = createFileRoute("/e/$entityId/receipts/")({
  validateSearch: ReceiptSearchParams,
  search: { middlewares: [stripSearchParams({ includeDeleted: false })] },
  component: ReceiptsPage,
});

const hasFilter = (search: ReceiptSearch) =>
  Object.entries(search).some(([k, v]) => v !== undefined && !(k === "includeDeleted" && !v));

function ReceiptsPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const receipts = useInfiniteQuery(receiptSearchQuery(entityId, search));
  const items = receipts.data?.pages.flatMap((p) => p.receipts);

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">証憑</h1>
      <p className="text-sm text-muted-foreground">
        領収書・請求書などの画像や PDF
        を、暗号化して保存します。取引年月日・金額・取引先で探せます。
      </p>
      <Link
        to="/e/$entityId/receipts/new"
        params={{ entityId }}
        className="justify-self-start text-sm underline"
      >
        追加する
      </Link>
      <ReceiptSearchForm
        search={search}
        onSearch={(next) => navigate({ search: next })}
        onClear={() => navigate({ search: {} })}
      />
      <Card>
        <CardHeader>
          <CardTitle>{hasFilter(search) ? "検索の結果（新しい順）" : "証憑（新しい順）"}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={receipts.error} />
          {receipts.isPending && !receipts.error && (
            <p className="text-sm text-muted-foreground">読み込み中…</p>
          )}
          {items?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {hasFilter(search)
                ? "条件に合う証憑がありません。"
                : "証憑がありません。「追加する」から保存してください。"}
            </p>
          )}
          {items && items.length > 0 && <ReceiptList entityId={entityId} receipts={items} />}
          {receipts.hasNextPage && (
            <Button
              variant="outline"
              className="justify-self-center"
              disabled={receipts.isFetchingNextPage}
              onClick={() => receipts.fetchNextPage()}
            >
              {receipts.isFetchingNextPage ? "読み込み中…" : "さらに読み込む"}
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
