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
  inactivePartnerIds,
  issuedInvoices,
}: {
  entityId: string;
  result: InvoiceDraftResult;
  partnerNames: Map<string, string>;
  /** 使用停止の取引先。案にも「作れなかった」の知らせにも出さない（011 FR-033） */
  inactivePartnerIds?: ReadonlySet<string>;
  /** 発行済み（未取消）の請求書。キーは `${partnerId}-${対象月}` */
  issuedInvoices?: ReadonlyMap<string, { id: string; invoiceNo: string }>;
}) {
  const nameOf = (partnerId: string) => partnerNames.get(partnerId) ?? partnerId;
  const active = (partnerId: string) => !inactivePartnerIds?.has(partnerId);
  const drafts = result.drafts.filter((d) => active(d.partnerId));
  const skipped = result.skipped.filter((s) => active(s.partnerId));
  const keyOf = (d: { partnerId: string; targetMonth: string }) =>
    `${d.partnerId}-${d.targetMonth}`;
  // 主な操作（variant=default）の「発行する」は、先頭の未発行の案だけ。発行すると次の案に移る（011 ui-shell §7）
  const primaryKey = drafts.map(keyOf).find((key) => !issuedInvoices?.has(key));
  return (
    <div className="grid gap-4">
      {drafts.length === 0 && (
        <p className="text-sm text-muted-foreground">この月の請求書の案はありません。</p>
      )}
      {drafts.map((draft) => (
        <InvoiceDraftEditor
          key={keyOf(draft)}
          entityId={entityId}
          draft={draft}
          partnerName={nameOf(draft.partnerId)}
          existing={issuedInvoices?.get(keyOf(draft))}
          primary={keyOf(draft) === primaryKey}
        />
      ))}
      {skipped.length > 0 && (
        <ul className="grid gap-1 text-sm text-muted-foreground">
          {skipped.map((s) => (
            <li key={s.partnerId}>
              {nameOf(s.partnerId)}: {SKIP_REASONS[s.reason]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
