import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AdjustmentProposal } from "@trebuchet/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { SaveNotice } from "@/components/ui/save-notice";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Account } from "@/features/accounts/api";
import { deferredAssetKeys } from "@/features/deferred-assets/api";
import { formatYen } from "@/lib/format";
import { invalidateLedger } from "@/lib/queries";
import { type HomeUseAllocationRow, postAdjustment } from "./api";
import { formatDepreciationRate, formatRatioAsPercent } from "./ratio";

const DEPRECIATION_METHOD_LABELS = {
  small_asset_28_2: "少額の特例",
  straight_line: "定額法",
  lump_sum: "一括償却",
} as const;

/** 画面が見た案の金額（借方の行の金額）。確定のとき API が帳簿から作り直した案と比べる */
const debitTotal = (proposal: AdjustmentProposal) =>
  proposal.journal.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);

/**
 * 決算整理の仕訳の案（003/FR-014〜016）。帳簿の金額・割合・事業分・家事分と仕訳の案を見せ、
 * 「仕訳を登録」で確定する。案は API が作る。画面は計算しない
 */
export function AdjustmentPanel({
  entityId,
  year,
  proposals,
  accounts,
  allocations = [],
  assets = [],
  deferredAssets = [],
}: {
  entityId: string;
  year: string;
  proposals: readonly AdjustmentProposal[];
  accounts: readonly Account[];
  /** 家事按分の案の見出しに使う（省略可） */
  allocations?: readonly HomeUseAllocationRow[];
  /** 減価償却の案の見出しに使う資産の名前（省略可） */
  assets?: readonly { id: string; name: string }[];
  /** 開業費の案の見出しに使う開業費の名前（省略可） */
  deferredAssets?: readonly { id: string; name: string }[];
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
    // 失敗（案の金額が変わった）でも、決算書と案を読み直して新しい案を見せる。
    // 開業費の案は、開業費の「登録済み」の状態も変わる
    onSettled: () =>
      Promise.all([
        invalidateLedger(queryClient, entityId),
        queryClient.invalidateQueries({ queryKey: deferredAssetKeys.all(entityId) }),
      ]),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>決算整理の仕訳の案</CardTitle>
        <CardDescription>
          按分の登録と帳簿から求めた、家事分を事業主貸へ振り替える仕訳の案と、固定資産台帳から求めた減価償却費の仕訳の案と、決めた償却額による開業費の仕訳の案です。「仕訳を登録」で帳簿に登録されます（日付は年度末日）。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <section aria-label="決算整理の仕訳の案" className="grid gap-4">
          {proposals.length === 0 && (
            <p className="text-sm text-muted-foreground">登録する仕訳の案はありません。</p>
          )}
          {proposals.map((p) => {
            const allocation = allocations.find((a) => a.id === p.sourceId);
            const label =
              p.kind === "depreciation"
                ? (assets.find((a) => a.id === p.sourceId)?.name ?? "固定資産")
                : p.kind === "deferred_amortization"
                  ? (deferredAssets.find((d) => d.id === p.sourceId)?.name ?? "開業費")
                  : allocation
                    ? nameOf(allocation.accountId)
                    : "按分";
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
                {"totalAmount" in b && (
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
                    <div>
                      <dt className="text-muted-foreground">総額</dt>
                      <dd className="tabular-nums">{formatYen(b.totalAmount)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">期首の未償却残高</dt>
                      <dd className="tabular-nums">{formatYen(b.openingBalance)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">償却額</dt>
                      <dd className="tabular-nums">{formatYen(b.amount)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">目安</dt>
                      <dd className="tabular-nums">{formatYen(b.target)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">期末の未償却残高</dt>
                      <dd className="tabular-nums">{formatYen(b.closingBalance)}</dd>
                    </div>
                  </dl>
                )}
                {"acquisitionCost" in b && (
                  <>
                    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-muted-foreground">償却方法</dt>
                        <dd>{DEPRECIATION_METHOD_LABELS[b.method]}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">取得価額</dt>
                        <dd className="tabular-nums">{formatYen(b.acquisitionCost)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">事業専用割合</dt>
                        <dd className="tabular-nums">{formatRatioAsPercent(b.businessRatio)}%</dd>
                      </div>
                      {b.months !== null && (
                        <div>
                          <dt className="text-muted-foreground">本年中の償却期間</dt>
                          <dd className="tabular-nums">{b.months}/12</dd>
                        </div>
                      )}
                      {b.ratePermille !== null && (
                        <div>
                          <dt className="text-muted-foreground">償却率</dt>
                          <dd className="tabular-nums">{formatDepreciationRate(b.ratePermille)}</dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-muted-foreground">必要経費算入額</dt>
                        <dd className="tabular-nums">{formatYen(b.deductible)}</dd>
                      </div>
                      {b.disposalKind === "scrap" && (
                        <>
                          <div>
                            <dt className="text-muted-foreground">除却損</dt>
                            <dd className="tabular-nums">{formatYen(b.disposalAmount)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">除却損のうち必要経費算入額</dt>
                            <dd className="tabular-nums">{formatYen(b.disposalDeductible)}</dd>
                          </div>
                        </>
                      )}
                      {b.disposalKind === "sale" && (
                        <div>
                          <dt className="text-muted-foreground">売却による事業主貸への振替</dt>
                          <dd className="tabular-nums">{formatYen(b.disposalAmount)}</dd>
                        </div>
                      )}
                    </dl>
                    {b.disposalKind === "sale" && (
                      <p className="text-sm text-muted-foreground">
                        譲渡所得の計算はこのアプリの範囲外です。売却代金と譲渡所得は、別に計算して申告してください。
                      </p>
                    )}
                  </>
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
                  <Button
                    variant="outline"
                    disabled={commit.isPending}
                    onClick={() => commit.mutate(p)}
                  >
                    仕訳を登録
                  </Button>
                </div>
              </fieldset>
            );
          })}
        </section>
        <SaveNotice
          message={
            commit.isSuccess ? `仕訳を登録しました（No.${commit.data.journal.journalNo}）。` : ""
          }
        />
        <ApiErrorMessage error={commit.error} />
      </CardContent>
    </Card>
  );
}
