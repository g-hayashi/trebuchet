import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { OpeningComparison, OpeningProposal } from "@trebuchet/schema";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatSignedYen, formatYen } from "@/lib/format";
import { type Account, subAccountsQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { WARNING_LABELS } from "./labels";

const sameTarget = (
  a: { accountId: string; subAccountId: string | null },
  b: { accountId: string; subAccountId: string | null },
) => a.accountId === b.accountId && a.subAccountId === b.subAccountId;

const difference = (proposed: number, other: number | null) =>
  other === null ? null : proposed - other;

/**
 * freee の総勘定元帳から作った期首残高の案（FR-019〜020a）。
 * 案の合計、対応が未定の科目、警告、科目ごとの比較（登録済み・前年度の繰越との差）を示す。
 * 金額は科目の通常の側を正とする符号付き（マイナスは ▲）
 */
export function OpeningProposalPanel({
  entityId,
  proposal,
  accounts,
  onApply,
  onDiscard,
}: {
  entityId: string;
  proposal: OpeningProposal;
  accounts: readonly Account[];
  onApply: () => void;
  onDiscard: () => void;
}) {
  const { comparisons, unmapped, warnings, totals } = proposal;
  const hasRegistered = comparisons.some((c) => c.registered !== null);
  const hasCarryForward = comparisons.some((c) => c.carryForward !== null);
  const changed = comparisons.filter((c) => {
    const d = difference(c.proposed, c.registered);
    return d !== null && d !== 0;
  }).length;
  const sourceNames = (c: OpeningComparison) =>
    proposal.rows
      .filter((r) => sameTarget(r, c))
      .flatMap((r) => r.sourceNames)
      .join("、") || "—";

  return (
    <section aria-label="freee の元帳から作った案" className="grid gap-4">
      <div className="grid gap-1 text-sm">
        <p>
          案を入力欄に入れました（{proposal.rows.length}行、借方合計 {formatYen(totals.debit)} 円 ／
          貸方合計 {formatYen(totals.credit)} 円）。内容を確かめてから「保存する」を押してください。
        </p>
        {hasRegistered && (
          <p className={cn(changed > 0 && "font-medium text-amber-700")}>
            {changed > 0
              ? `登録済みと違う科目が ${changed} 件あります。差は下の表のとおりです。`
              : "登録済みの期首残高と同じです。"}
          </p>
        )}
      </div>

      {unmapped.length > 0 && (
        <div className="grid gap-1 rounded-md border border-destructive/50 px-3 py-2 text-sm">
          <h3 className="font-medium text-destructive">対応が未定の freee の科目</h3>
          <ul aria-label="対応が未定の freee の科目" className="list-disc pl-5">
            {unmapped.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p>
            これらの科目は案に含めていません。
            <Link
              to="/e/$entityId/imports/new"
              params={{ entityId }}
              className="underline underline-offset-4"
            >
              freee からの取込の画面
            </Link>
            の対応表で対応先を決めてから、もう一度読み込んでください。
          </p>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="grid gap-1 text-sm">
          <h3 className="font-medium">警告（保存は妨げません）</h3>
          <ul aria-label="案の警告" className="grid gap-1">
            {warnings.map((w, index) => (
              <li
                // 同じコードの警告が科目ごとに重なるため、順番も使う
                // biome-ignore lint/suspicious/noArrayIndexKey: 警告は並べ替えない
                key={`${w.code}-${index}`}
                className="rounded-md border border-amber-500/50 px-3 py-1.5"
              >
                <span className="font-medium">{WARNING_LABELS[w.code]}</span>
                <span className="ml-2">{w.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Table aria-label="科目ごとの比較">
        <TableHeader>
          <TableRow>
            <TableHead>勘定科目</TableHead>
            <TableHead>freee の科目</TableHead>
            <TableHead className="text-right">案</TableHead>
            {hasRegistered && (
              <>
                <TableHead className="text-right">登録済み</TableHead>
                <TableHead className="text-right">登録済みとの差</TableHead>
              </>
            )}
            {hasCarryForward && (
              <>
                <TableHead className="text-right">前年度の繰越</TableHead>
                <TableHead className="text-right">繰越との差</TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {comparisons.map((c) => (
            <TableRow key={`${c.accountId}-${c.subAccountId ?? ""}`}>
              <TableHead scope="row" className="font-normal text-foreground">
                <AccountLabel entityId={entityId} comparison={c} accounts={accounts} />
              </TableHead>
              <TableCell className="text-muted-foreground">{sourceNames(c)}</TableCell>
              <AmountCell value={c.proposed} />
              {hasRegistered && (
                <>
                  <AmountCell value={c.registered} />
                  <AmountCell value={difference(c.proposed, c.registered)} highlight />
                </>
              )}
              {hasCarryForward && (
                <>
                  <AmountCell value={c.carryForward} />
                  <AmountCell value={difference(c.proposed, c.carryForward)} highlight />
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-sm text-muted-foreground">
        金額は科目の通常の側（資産は借方、負債・純資産は貸方）を正とし、反対側の残高は ▲
        で示します。差は「案 − 比べる値」です。
      </p>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onApply}>
          案を入力欄に反映する
        </Button>
        <Button variant="ghost" onClick={onDiscard}>
          読み込みをやめる
        </Button>
      </div>
    </section>
  );
}

function AccountLabel({
  entityId,
  comparison,
  accounts,
}: {
  entityId: string;
  comparison: OpeningComparison;
  accounts: readonly Account[];
}) {
  const { accountId, subAccountId } = comparison;
  const subAccounts = useQuery({
    ...subAccountsQuery(entityId, accountId),
    enabled: subAccountId !== null,
  });
  const name = accounts.find((a) => a.id === accountId)?.name ?? accountId;
  if (subAccountId === null) return name;
  const sub = subAccounts.data?.find((s) => s.id === subAccountId)?.name ?? "（補助科目）";
  return `${name} ／ ${sub}`;
}

function AmountCell({ value, highlight }: { value: number | null; highlight?: boolean }) {
  return (
    <TableCell
      className={cn(
        "text-right tabular-nums",
        highlight && value !== null && value !== 0 && "font-semibold text-amber-700",
      )}
    >
      {value === null ? "—" : formatSignedYen(value)}
    </TableCell>
  );
}
