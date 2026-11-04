import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Steps } from "@/components/ui/steps";
import { billingTermsQuery, invoiceListQuery } from "./api";
import { type ListFilters, toQueryFilters } from "./InvoiceList";

const STEPS = ["工数", "請求書を作る", "入金"] as const;

const linkButton =
  "inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium shadow-xs hover:bg-accent";
const primaryLink =
  "inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90";

/**
 * 請求の流れ（工数 → 請求書を作る → 入金）と今の段階、各段階への入口（011 FR-031）。
 * 今の段階は目安: 請求の条件がまだなければ「工数」、未回収の請求書があれば「入金」、それ以外は「請求書を作る」
 */
export function InvoiceFlow({ entityId, filters }: { entityId: string; filters: ListFilters }) {
  const terms = useQuery(billingTermsQuery(entityId));
  // 一覧と同じ問い合わせ（同じ key なので読み込みは 1 回）
  const invoices = useQuery(invoiceListQuery(entityId, toQueryFilters(filters)));
  const hasOutstanding =
    (invoices.data?.outstandingByPartner.length ?? 0) > 0 ||
    (invoices.data?.invoices.some((i) => i.status === "unpaid" || i.status === "partial") ?? false);
  const current = terms.data?.length === 0 ? 0 : hasOutstanding ? 2 : 1;

  return (
    <div className="grid gap-3">
      <Steps steps={STEPS} current={current} label="請求の流れ" />
      <div className="flex flex-wrap gap-2">
        <Link to="/e/$entityId/work-hours" params={{ entityId }} className={linkButton}>
          工数の入力
        </Link>
        <Link to="/e/$entityId/invoices/new" params={{ entityId }} className={primaryLink}>
          請求書を作る
        </Link>
        <Link to="/e/$entityId/invoice-settings" params={{ entityId }} className={linkButton}>
          請求の設定
        </Link>
      </div>
    </div>
  );
}
