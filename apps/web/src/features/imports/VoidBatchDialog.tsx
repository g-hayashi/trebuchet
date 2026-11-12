import { Link } from "@tanstack/react-router";
import type { ImportBatch, ImportBatchJournal } from "@trebuchet/schema";
import { Fragment, useState } from "react";
import { ReasonDialog } from "@/components/reason-dialog";
import { JournalLink } from "@/features/reports/JournalLink";
import { isApiError } from "@/lib/api";
import { voidImportBatch } from "./api";

type Corrected = { count: number; journalIds: string[] };

const numbers = (v: unknown) =>
  Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

/**
 * 取込の取消のダイアログ（002/FR-024〜026）。理由が空欄なら確定できない。
 * 訂正済みの仕訳があると件数を示して再確認を求め、締め済みの年度があれば締めの解除を案内する
 */
export function VoidBatchDialog({
  entityId,
  batchId,
  journals,
  open,
  onCancel,
  onVoided,
}: {
  entityId: string;
  batchId: string;
  journals: readonly ImportBatchJournal[];
  open: boolean;
  onCancel: () => void;
  onVoided: (result: { batch: ImportBatch; voidedCount: number }) => void | Promise<void>;
}) {
  const [corrected, setCorrected] = useState<Corrected>();
  const activeCount = journals.filter((j) => j.status === "active").length;

  const correctedLinks = (corrected?.journalIds ?? []).flatMap((journalId) => {
    const j = journals.find((x) => x.journalId === journalId);
    return j ? [j] : [];
  });

  return (
    <ReasonDialog
      open={open}
      title="取込の取消"
      description={`この取込で登録した仕訳${activeCount}件をまとめて取り消します。取り消した仕訳は帳簿から除かれますが、内容と理由は変更履歴に残ります。取込で作った補助科目・取引先・メモタグと対応表は残ります。`}
      confirmLabel={corrected ? "訂正済みの仕訳を含めて取り消す" : "取消を確定"}
      confirmVariant="destructive"
      onConfirm={async (reason) => {
        const result = await voidImportBatch(
          entityId,
          batchId,
          corrected ? { reason, confirmCorrected: true } : { reason },
        );
        setCorrected(undefined);
        await onVoided(result);
      }}
      onConfirmError={(err) => {
        if (!isApiError(err, "CORRECTED_JOURNALS")) return false;
        const journalIds = strings(err.details?.journalIds);
        const count = err.details?.count;
        setCorrected({ count: typeof count === "number" ? count : journalIds.length, journalIds });
        return true;
      }}
      renderError={(err) => {
        if (!isApiError(err, "PERIOD_CLOSED")) return undefined;
        const closedYears = numbers(err.details?.fiscalYears);
        return (
          <div
            role="alert"
            className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
          >
            {closedYears.length > 0 ? `${closedYears.join("・")}年度は` : "取り込んだ年度が"}
            締め済みのため、この取込は取り消せません。
            <Link
              to="/e/$entityId/periods"
              params={{ entityId }}
              className="underline underline-offset-2"
            >
              会計期間
            </Link>
            の画面で締めを解除してから取り消してください。
          </div>
        );
      }}
      onCancel={() => {
        setCorrected(undefined);
        onCancel();
      }}
    >
      {corrected && (
        <div
          role="alert"
          className="grid gap-1 rounded-md border border-amber-500/50 px-3 py-2 text-sm"
        >
          <p className="font-medium">取込の後に訂正された仕訳が{corrected.count}件あります。</p>
          {correctedLinks.length > 0 && (
            <p>
              仕訳番号:{" "}
              {correctedLinks.map((j, index) => (
                <Fragment key={j.journalId}>
                  {index > 0 && "、"}
                  <JournalLink journalId={j.journalId} journalNo={j.journalNo} />
                </Fragment>
              ))}
            </p>
          )}
          <p>
            取り消すと、訂正した内容も取消になります。確かめてから「訂正済みの仕訳を含めて取り消す」を押してください。
          </p>
        </div>
      )}
    </ReasonDialog>
  );
}
