import type { InvoiceDetail } from "@trebuchet/schema";
import { formatYen } from "@/lib/format";
import { invoiceTaxSummary, quantityOf, recipientOf } from "./display";

/**
 * 印刷用の請求書（A4 縦 1 枚。005/FR-011・012）。発行時に写した値（`issuer`・明細）だけを使い、
 * 屋号と登録番号は設定されているときだけ（屋号が氏名と同じなら 1 回だけ。011 FR-037）、
 * 税率ごとの内訳は `tax_display = separate` のときだけ出す。見出しの「ご請求金額」は、源泉徴収税額があるとき
 * （013）は差引請求額、ないときは合計。
 * 印刷の対象の絞り込みと余白は、全体の `src/print.css`（`[data-print-root]`）で行う
 */
export function InvoicePrint({
  invoice,
  demo = false,
}: {
  invoice: InvoiceDetail;
  /** デモの事業体（014）の請求書なら、印刷にも「デモ（架空のデータ）」を出す（print.css で隠さない） */
  demo?: boolean;
}) {
  const { issuer } = invoice;
  const summary = invoiceTaxSummary(invoice);
  const showBreakdown = invoice.taxDisplay === "separate" && invoice.taxBreakdown.length > 0;
  return (
    <article
      aria-label={`請求書 ${invoice.invoiceNo}`}
      className="invoice-sheet grid gap-6 text-sm"
    >
      <h2 className="text-center text-2xl font-semibold tracking-widest">請求書</h2>
      {demo && <p className="text-center text-sm font-medium">デモ（架空のデータ）</p>}

      <div className="flex justify-between gap-6">
        <div className="grid content-start gap-1">
          <p className="border-b pb-1 text-lg">{recipientOf(invoice)}</p>
          <p>下記のとおりご請求申し上げます。</p>
        </div>
        <div className="grid content-start gap-1 text-right">
          <p>{`請求番号 ${invoice.invoiceNo}`}</p>
          <p>{`発行日 ${invoice.issueDate}`}</p>
        </div>
      </div>

      <div className="flex items-end justify-between gap-6">
        <div className="grid gap-1">
          <p className="text-lg font-semibold">{`ご請求金額 ${formatYen(
            invoice.withholdingTax > 0 ? invoice.netAmount : invoice.total,
          )} 円`}</p>
          <p>{`支払期限 ${invoice.dueDate}`}</p>
        </div>
        <div className="grid gap-0.5 text-right">
          {issuer.tradeName !== null && issuer.tradeName !== issuer.issuerName && (
            <p>{issuer.tradeName}</p>
          )}
          <p>{issuer.issuerName}</p>
          <p>{issuer.address}</p>
          <p>{issuer.contact}</p>
          {issuer.registrationNumber !== null && <p>{`登録番号 ${issuer.registrationNumber}`}</p>}
        </div>
      </div>

      <table aria-label="明細" className="w-full border-collapse">
        <thead>
          <tr className="border-y">
            <th className="py-1 text-left font-medium">品名</th>
            <th className="py-1 text-right font-medium">数量</th>
            <th className="py-1 text-right font-medium">{`単価（${summary.modeLabel}）`}</th>
            <th className="py-1 text-right font-medium">{`金額（${summary.modeLabel}）`}</th>
          </tr>
        </thead>
        <tbody>
          {invoice.items.map((item) => (
            <tr key={item.lineNo} className="border-b">
              <td className="py-1">{item.name}</td>
              <td className="py-1 text-right tabular-nums">{quantityOf(item)}</td>
              <td className="py-1 text-right tabular-nums">
                {item.unitPrice === null ? "" : formatYen(item.unitPrice)}
              </td>
              <td className="py-1 text-right tabular-nums">{formatYen(item.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="grid justify-items-end gap-2">
        {summary.exclusive && (
          <div className="grid justify-items-end gap-1 tabular-nums">
            <p>{`小計（税抜）${formatYen(summary.subtotal)} 円`}</p>
            <p>{`${summary.taxLabel} ${formatYen(summary.tax)} 円`}</p>
          </div>
        )}
        {showBreakdown && (
          <table aria-label="消費税の内訳" className="border-collapse text-right tabular-nums">
            <thead>
              <tr className="border-b">
                <th className="px-3 py-1 text-left font-medium">税率</th>
                <th className="px-3 py-1 font-medium">税抜</th>
                <th className="px-3 py-1 font-medium">{summary.taxLabel}</th>
                <th className="px-3 py-1 font-medium">税込</th>
              </tr>
            </thead>
            <tbody>
              {invoice.taxBreakdown.map((b) => (
                <tr key={b.rate}>
                  <td className="px-3 py-1 text-left">{`${b.rate}%`}</td>
                  <td className="px-3 py-1">{formatYen(b.exclusive)}</td>
                  <td className="px-3 py-1">{formatYen(b.tax)}</td>
                  <td className="px-3 py-1">{formatYen(b.inclusive)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-base font-semibold tabular-nums">{`合計 ${formatYen(invoice.total)} 円${
          invoice.taxDisplay === "inclusive_only" ? "（税込）" : ""
        }`}</p>
        {invoice.withholdingTax > 0 && (
          <div className="grid justify-items-end gap-1 tabular-nums">
            <p>{`源泉徴収税額 ${formatYen(invoice.withholdingTax)} 円`}</p>
            <p className="text-base font-semibold">{`差引請求額 ${formatYen(invoice.netAmount)} 円`}</p>
          </div>
        )}
      </div>

      <div className="grid gap-1">
        <p className="font-medium">お振込先</p>
        <p className="whitespace-pre-line">{issuer.bankAccount}</p>
      </div>
    </article>
  );
}
