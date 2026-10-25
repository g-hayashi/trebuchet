import type { InvoiceDraftResult } from "./api";
import { InvoiceDraftEditor } from "./InvoiceDraftEditor";

const SKIP_REASONS = {
  NO_HOURS: "工数が未入力のため、案を作りませんでした。",
  ZERO_HOURS: "工数が 0 時間のため、案を作りませんでした。",
} as const;

/** 請求書の案の一覧（取引先ごとに 1 通）と、案を作れなかった取引先 */
export function InvoiceDraftList({
  entityId,
  result,
  partnerNames,
}: {
  entityId: string;
  result: InvoiceDraftResult;
  partnerNames: Map<string, string>;
}) {
  const nameOf = (partnerId: string) => partnerNames.get(partnerId) ?? partnerId;
  return (
    <div className="grid gap-4">
      {result.drafts.length === 0 && (
        <p className="text-sm text-muted-foreground">この月の請求書の案はありません。</p>
      )}
      {result.drafts.map((draft) => (
        <InvoiceDraftEditor
          key={`${draft.partnerId}-${draft.targetMonth}`}
          entityId={entityId}
          draft={draft}
          partnerName={nameOf(draft.partnerId)}
        />
      ))}
      {result.skipped.length > 0 && (
        <ul className="grid gap-1 text-sm text-muted-foreground">
          {result.skipped.map((s) => (
            <li key={s.partnerId}>
              {nameOf(s.partnerId)}: {SKIP_REASONS[s.reason]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
