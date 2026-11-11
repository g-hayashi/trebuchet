import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loading } from "@/components/loading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { invoiceSettingsQuery } from "@/features/invoicing/api";
import { IssuerSettingsForm } from "@/features/invoicing/IssuerSettingsForm";

export const Route = createFileRoute("/e/$entityId/invoice-settings")({
  component: InvoiceSettingsPage,
});

function InvoiceSettingsPage() {
  const { entityId } = Route.useParams();
  const { data, isPending, error } = useQuery(invoiceSettingsQuery(entityId));

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">請求の設定</h1>
      <Card>
        <CardHeader>
          <CardTitle>発行者</CardTitle>
          <CardDescription>
            請求書に載せる発行者の情報です。氏名・住所・連絡先・振込先がそろうまで、請求書は発行できません。
            取引先ごとの単価や支払期限は、取引先の画面で設定します。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiErrorMessage error={error} />
          {isPending && <Loading />}
          {data && (
            <IssuerSettingsForm
              entityId={entityId}
              settings={data.settings}
              minimumNextSeq={data.minimumNextSeq}
            />
          )}
        </CardContent>
      </Card>
    </main>
  );
}
