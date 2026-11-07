import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { WithholdingSummary } from "@trebuchet/schema";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { thisYear } from "@/lib/dates";
import { formatYen } from "@/lib/format";
import { withholdingSummaryQuery } from "./api";

/** 年の選択肢（新しい年が上）。今年と選んだ年を含め、古い方に 5 年ぶん足す */
function yearChoices(year: number): number[] {
  const top = Math.max(thisYear(), year);
  const bottom = Math.min(thisYear(), year) - 5;
  return Array.from({ length: top - bottom + 1 }, (_, i) => top - i);
}

/**
 * 源泉徴収の一覧（013 US3）。暦年ごと・取引先ごとの件数、支払金額、源泉徴収税額と全体の合計。
 * 行を開くと、その取引先の入金（入金日・請求番号・支払金額・源泉徴収税額）が並ぶ。年は入金日で数える
 */
export function WithholdingList({
  entityId,
  year,
  onYearChange,
}: {
  entityId: string;
  year: number;
  onYearChange: (year: number) => void;
}) {
  const summary = useQuery(withholdingSummaryQuery(entityId, year));
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (partnerId: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (!next.delete(partnerId)) next.add(partnerId);
      return next;
    });

  return (
    <div className="grid gap-4">
      <div className="grid max-w-40 gap-2">
        <Label htmlFor="withholding-year">年</Label>
        <NativeSelect
          id="withholding-year"
          value={String(year)}
          onChange={(e) => onYearChange(Number(e.target.value))}
        >
          {yearChoices(year).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </NativeSelect>
      </div>
      <p className="text-sm text-muted-foreground">
        入金日がその年の、取り消されていない消し込みを数えます。支払金額は、消し込みで売掛金に充てた額（源泉徴収税額と差額を含む）です。
      </p>
      <ApiErrorMessage error={summary.error} />
      {summary.isPending && !summary.error && (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      )}
      {summary.data &&
        (summary.data.partners.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {year} 年に源泉徴収された入金はありません。
          </p>
        ) : (
          <Table aria-label="取引先ごとの源泉徴収">
            <TableHeader>
              <TableRow>
                <TableHead>取引先</TableHead>
                <TableHead className="text-right">件数</TableHead>
                <TableHead className="text-right">支払金額</TableHead>
                <TableHead className="text-right">源泉徴収税額</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.data.partners.map((partner) => (
                <Fragment key={partner.partnerId}>
                  <TableRow>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={opened.has(partner.partnerId)}
                        onClick={() => toggle(partner.partnerId)}
                      >
                        {partner.partnerName}
                      </Button>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {partner.paymentCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatYen(partner.appliedTotal)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatYen(partner.withholdingTotal)}
                    </TableCell>
                  </TableRow>
                  {opened.has(partner.partnerId) && (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <PaymentsTable entityId={entityId} partner={partner} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>合計</TableCell>
                <TableCell className="text-right tabular-nums">
                  {summary.data.partners.reduce((sum, p) => sum + p.paymentCount, 0)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatYen(summary.data.appliedTotal)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatYen(summary.data.withholdingTotal)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        ))}
    </div>
  );
}

function PaymentsTable({
  entityId,
  partner,
}: {
  entityId: string;
  partner: WithholdingSummary["partners"][number];
}) {
  return (
    <Table aria-label={`${partner.partnerName}の明細`}>
      <TableHeader>
        <TableRow>
          <TableHead>入金日</TableHead>
          <TableHead>請求番号</TableHead>
          <TableHead className="text-right">支払金額</TableHead>
          <TableHead className="text-right">源泉徴収税額</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {partner.payments.map((payment) => (
          <TableRow key={payment.paymentId}>
            <TableCell className="tabular-nums">{payment.receivedOn}</TableCell>
            <TableCell>
              <Link
                to="/e/$entityId/invoices/$invoiceId"
                params={{ entityId, invoiceId: payment.invoiceId }}
                className="text-primary underline underline-offset-4"
              >
                {payment.invoiceNo}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatYen(payment.applied)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatYen(payment.withholdingAmount)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
