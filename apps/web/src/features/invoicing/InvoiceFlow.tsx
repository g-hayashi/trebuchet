import { useQuery } from "@tanstack/react-query";
import { Steps } from "@/components/ui/steps";
import { billingTermsQuery, invoiceListQuery } from "./api";
import { type ListFilters, toQueryFilters } from "./InvoiceList";

const STEPS = ["工数", "請求書を作る", "入金"] as const;

/**
 * 請求の流れ（工数 → 請求書を作る → 入金）と今の段階（011 FR-031）。
 * 工数・請求の設定の入口は 2 段目のメニュー、「請求書を作る」は画面の見出しの右にある。
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

  return <Steps steps={STEPS} current={current} label="請求の流れ" />;
}
