import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReceiptDetail } from "@trebuchet/schema";
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { receiptQuery } from "@/features/receipts/api";
import {
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  formatBytes,
  LINK_STATE_LABELS,
  MEDIA_TYPE_LABELS,
  warningText,
} from "@/features/receipts/labels";
import { ReceiptDeleteSection } from "@/features/receipts/ReceiptDeleteSection";
import { ReceiptFieldsForm } from "@/features/receipts/ReceiptFieldsForm";
import { ReceiptHistory } from "@/features/receipts/ReceiptHistory";
import { ReceiptLinkSection } from "@/features/receipts/ReceiptLinkSection";
import { ReceiptReplaceSection } from "@/features/receipts/ReceiptReplaceSection";
import { ReceiptViewer } from "@/features/receipts/ReceiptViewer";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/e/$entityId/receipts/$receiptId")({
  component: ReceiptDetailPage,
});

function ReceiptDetailPage() {
  const { entityId, receiptId } = Route.useParams();
  const query = useQuery(receiptQuery(entityId, receiptId));
  const receipt = query.data;

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">証憑</h1>
        <Link to="/e/$entityId/receipts" params={{ entityId }} className="text-sm underline">
          証憑の一覧
        </Link>
      </div>
      <ApiErrorMessage error={query.error} />
      {query.isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {receipt && <ReceiptBody entityId={entityId} receipt={receipt} />}
    </main>
  );
}

function ReceiptBody({ entityId, receipt }: { entityId: string; receipt: ReceiptDetail }) {
  return (
    <>
      {receipt.deleted && (
        <p role="note" className="rounded-md border px-3 py-2 text-sm">
          削除済みです{receipt.deletedAt ? `（${formatDateTime(receipt.deletedAt)}）` : ""}。
          {receipt.deletedReason ? `理由: ${receipt.deletedReason}` : ""}
        </p>
      )}
      {receipt.warnings.length > 0 && (
        <ul aria-label="警告" className="grid gap-1 rounded-md border px-3 py-2 text-sm">
          {receipt.warnings.map((w) => (
            <li key={w.code}>{warningText(w)}</li>
          ))}
        </ul>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>ファイル</CardTitle>
          </CardHeader>
          <CardContent>
            <ReceiptViewer entityId={entityId} receipt={receipt} />
          </CardContent>
        </Card>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>値</CardTitle>
            </CardHeader>
            <CardContent>
              {receipt.deleted ? (
                <ValueSummary receipt={receipt} />
              ) : (
                <ReceiptFieldsForm entityId={entityId} receipt={receipt} />
              )}
            </CardContent>
          </Card>
          <ReceiptLinkSection entityId={entityId} receipt={receipt} />
          {!receipt.deleted && <ReceiptReplaceSection entityId={entityId} receipt={receipt} />}
          <ReceiptInfo entityId={entityId} receipt={receipt} />
          <ReceiptHistory entityId={entityId} receiptId={receipt.id} />
          {!receipt.deleted && <ReceiptDeleteSection entityId={entityId} receipt={receipt} />}
        </div>
      </div>
    </>
  );
}

/** 削除済みの証憑の値（変更できない） */
function ValueSummary({ receipt }: { receipt: ReceiptDetail }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
      <Row label="取引年月日">{receipt.transactionDate ?? "未入力"}</Row>
      <Row label="金額">
        {receipt.amount === null ? "未入力" : receipt.amount.toLocaleString("ja-JP")}
      </Row>
      <Row label="取引先">{receipt.partnerName ?? "未入力"}</Row>
      <Row label="メモ">{receipt.memo ?? ""}</Row>
    </dl>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="break-all">{children}</dd>
  </>
);

/** 受領日時・ハッシュ・元の名前・形式・大きさ・経路など、保存した時点の事実（FR-009） */
function ReceiptInfo({ entityId, receipt }: { entityId: string; receipt: ReceiptDetail }) {
  const file = receipt.currentFile;
  return (
    <section aria-label="証憑の情報">
      <Card>
        <CardHeader>
          <CardTitle>証憑の情報</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
            <Row label="受領日時">{formatDateTime(receipt.receivedAt)}</Row>
            <Row label="経路">{CHANNEL_LABELS[receipt.channel]}</Row>
            <Row label="区分">{CATEGORY_LABELS[receipt.category]}</Row>
            <Row label="形式">{MEDIA_TYPE_LABELS[file.mediaType]}</Row>
            <Row label="大きさ">{formatBytes(file.sizeBytes)}</Row>
            <Row label="元の名前">{file.originalName}</Row>
            {file.width !== null && file.height !== null && (
              <Row label="画像の大きさ">
                {file.width}×{file.height}
              </Row>
            )}
            <Row label="SHA-256">
              <code className="text-xs">{file.sha256}</code>
            </Row>
            <Row label="結びつき">
              {LINK_STATE_LABELS[receipt.linkState]}
              {receipt.journal && (
                <>
                  {" "}
                  <Link
                    to="/e/$entityId/journals/$journalId"
                    params={{ entityId, journalId: receipt.journal.id }}
                    className="underline"
                  >
                    仕訳 No.{receipt.journal.journalNo}
                  </Link>
                </>
              )}
            </Row>
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}
