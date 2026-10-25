import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { invoiceQuery } from "@/features/invoicing/api";
import { InvoicePrint } from "@/features/invoicing/InvoicePrint";

// ファイル名の `$invoiceId_` の `_` は、詳細の画面（`$invoiceId.tsx`）の子にしないための印
export const Route = createFileRoute("/e/$entityId/invoices/$invoiceId_/print")({
  component: InvoicePrintPage,
});

/** 印刷（PDF に保存）用の画面。PDF のファイル名の既定になるので、開いている間だけ title を請求番号にする */
function InvoicePrintPage() {
  const { entityId, invoiceId } = Route.useParams();
  const { data, isPending, error } = useQuery(invoiceQuery(entityId, invoiceId));
  const invoiceNo = data?.invoiceNo;

  useEffect(() => {
    if (invoiceNo === undefined) return;
    const previous = document.title;
    document.title = invoiceNo;
    return () => {
      document.title = previous;
    };
  }, [invoiceNo]);

  return (
    <main className="invoice-print grid gap-4">
      <div className="no-print flex flex-wrap items-center gap-3">
        <Button onClick={() => window.print()} disabled={data === undefined}>
          印刷・PDF に保存
        </Button>
        <Link
          to="/e/$entityId/invoices/$invoiceId"
          params={{ entityId, invoiceId }}
          className="text-sm underline underline-offset-4"
        >
          請求書の詳細へ戻る
        </Link>
        {data?.status === "voided" && (
          <span className="text-sm text-destructive">この請求書は取り消されています。</span>
        )}
      </div>
      <ApiErrorMessage error={error} className="no-print" />
      {isPending && !error && <p className="no-print text-sm text-muted-foreground">読み込み中…</p>}
      {data && <InvoicePrint invoice={data} />}
    </main>
  );
}
