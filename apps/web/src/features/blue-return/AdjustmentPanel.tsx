import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AdjustmentProposal } from "@trebuchet/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatYen } from "@/lib/format";
import type { Account } from "@/lib/queries";
import { queryKeys } from "@/lib/queries";
import { blueReturnKeys, type HomeUseAllocationRow, postAdjustment } from "./api";
import { formatRatioAsPercent } from "./ratio";

/** 画面が見た案の金額（借方の行の金額）。確定のとき API が帳簿から作り直した案と比べる */
const debitTotal = (proposal: AdjustmentProposal) =>
  proposal.journal.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);

/**
 * 決算整理の仕訳の案（FR-014〜016）。帳簿の金額・割合・事業分・家事分と仕訳の案を見せ、
 * 「仕訳を登録」で確定する。案は API が作る。画面は計算しない
 */
export function AdjustmentPanel({
  entityId,
  year,
  proposals,
  accounts,
  allocations,
}: {
  entityId: string;
  year: string;
  proposals: readonly AdjustmentProposal[];
  accounts: readonly Account[];
  allocations: readonly HomeUseAllocationRow[];
}) {
  const queryClient = useQueryClient();
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? "";

  const commit = useMutation({
    mutationFn: (proposal: AdjustmentProposal) =>
      postAdjustment(entityId, year, {
        kind: proposal.kind,
        sourceId: proposal.sourceId,
        expected: { amount: debitTotal(proposal) },
      }),
    // 失敗（案の金額が変わった）でも、決算書と案を読み直して新しい案を見せる
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: blueReturnKeys.year(entityId, year) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.journals(entityId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.reports(entityId) }),
      ]);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>決算整理の仕訳の案</CardTitle>
        <CardDescription>
          按分の登録と帳簿から求めた、家事分を事業主貸へ振り替える仕訳の案です。「仕訳を登録」で帳簿に登録されます（日付は年度末日）。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <section aria-label="決算整理の仕訳の案" className="grid gap-4">
          {proposals.length === 0 && (
            <p className="text-sm text-muted-foreground">登録する仕訳の案はありません。</p>
          )}
          {proposals.map((p) => {
            const allocation = allocations.find((a) => a.id === p.sourceId);
            const label = allocation ? nameOf(allocation.accountId) : "按分";
            const b = p.breakdown;
            return (
              <fieldset
                key={`${p.kind}-${p.sourceId}`}
                aria-label={`${label}の振替の案`}
                className="grid gap-3 rounded-md border p-3"
              >
                <h3 className="font-medium">{label}</h3>
                {"bookAmount" in b && (
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground">帳簿の金額</dt>
                      <dd className="tabular-nums">{formatYen(b.bookAmount)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">事業専用割合</dt>
                      <dd className="tabular-nums">{formatRatioAsPercent(b.ratio)}%</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">事業分</dt>
                      <dd className="tabular-nums">{formatYen(b.business)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">家事分</dt>
                      <dd className="tabular-nums">{formatYen(b.home)}</dd>
                    </div>
                  </dl>
                )}
                <div className="grid gap-1 text-sm">
                  <p>
                    <span className="text-muted-foreground">日付 </span>
                    <span>{p.journal.date}</span>
                  </p>
                  {p.journal.memo && <p className="text-muted-foreground">{p.journal.memo}</p>}
                </div>
                <Table aria-label={`${label}の仕訳の案`}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>貸借</TableHead>
                      <TableHead>科目</TableHead>
                      <TableHead className="text-right">金額</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.journal.lines.map((l, i) => (
                      // 仕訳の案の行は並びが固定で、入れ替えも挿入もしない
                      // biome-ignore lint/suspicious/noArrayIndexKey: 固定の並び
                      <TableRow key={i}>
                        <TableCell>{l.side === "debit" ? "借方" : "貸方"}</TableCell>
                        <TableCell>{nameOf(l.accountId)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatYen(l.amount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div>
                  <Button disabled={commit.isPending} onClick={() => commit.mutate(p)}>
                    仕訳を登録
                  </Button>
                </div>
              </fieldset>
            );
          })}
        </section>
        <ApiErrorMessage error={commit.error} />
      </CardContent>
    </Card>
  );
}
