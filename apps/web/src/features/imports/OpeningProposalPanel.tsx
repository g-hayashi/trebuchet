import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MappingRow,
  MissingSubAccount,
  OpeningComparison,
  OpeningProposal,
} from "@trebuchet/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type Account,
  accountKeys,
  postSubAccount,
  subAccountsQuery,
} from "@/features/accounts/api";
import { formatSignedYen, formatYen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WARNING_LABELS } from "./labels";
import { type AccountEdits, MappingEditor } from "./MappingEditor";

const sameTarget = (
  a: { accountId: string; subAccountId: string | null },
  b: { accountId: string; subAccountId: string | null },
) => a.accountId === b.accountId && a.subAccountId === b.subAccountId;

const difference = (proposed: number, other: number | null) =>
  other === null ? null : proposed - other;

/**
 * freee の総勘定元帳から作った期首残高の案（002/FR-019〜020a）。
 * 案の合計、対応が未定の科目、警告、科目ごとの比較（登録済み・前年度の繰越との差）を示す。
 * 対応が未定の科目は、補助科目の作成か対応表の保存で解消し、onResolved で案を作り直す。
 * 金額は科目の通常の側を正とする符号付き（マイナスは ▲）
 */
export function OpeningProposalPanel({
  entityId,
  proposal,
  accounts,
  resolving,
  onApply,
  onDiscard,
  onResolved,
}: {
  entityId: string;
  proposal: OpeningProposal;
  accounts: readonly Account[];
  /** 案を作り直している */
  resolving: boolean;
  onApply: () => void;
  onDiscard: () => void;
  /** 未定の科目を解消した後に、同じ元帳で案を作り直す */
  onResolved: () => void;
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
        <UnmappedAccounts
          // 案を作り直したら、選びかけの対応先を捨てる
          key={unmapped.join("\n")}
          entityId={entityId}
          proposal={proposal}
          accounts={accounts}
          resolving={resolving}
          onResolved={onResolved}
        />
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

/**
 * 対応が未定の freee の科目と、その解消。補助科目がまだない科目（カードなど）は「補助科目を作成」、
 * それ以外は対応表（MappingEditor）で帳簿の科目を選んで保存する。どちらも完了後に案を作り直す
 */
function UnmappedAccounts({
  entityId,
  proposal,
  accounts,
  resolving,
  onResolved,
}: {
  entityId: string;
  proposal: OpeningProposal;
  accounts: readonly Account[];
  resolving: boolean;
  onResolved: () => void;
}) {
  const missing = new Map(proposal.missingSubAccounts.map((m) => [m.sourceName, m]));
  const others: MappingRow[] = proposal.unmapped
    .filter((name) => !missing.has(name))
    .map((sourceName) => ({ sourceName, status: "unmapped" }));
  const [accountEdits, setAccountEdits] = useState<AccountEdits>({});

  return (
    <div className="grid gap-3 rounded-md border border-destructive/50 px-3 py-2 text-sm">
      <h3 className="font-medium text-destructive">対応が未定の freee の科目</h3>
      <p>
        これらの科目は案に含めていません。対応先を決めると、同じ元帳で案を作り直します（対応表は
        freee からの取込でも使います）。
      </p>
      <ul aria-label="対応が未定の freee の科目" className="grid gap-2">
        {proposal.unmapped.map((name) => {
          const m = missing.get(name);
          return (
            <li key={name} className="grid gap-1">
              {m === undefined ? (
                <span>
                  <span className="font-medium">{name}</span>
                  <span className="ml-2 text-muted-foreground">
                    下の表で帳簿の勘定科目を選んでください
                  </span>
                </span>
              ) : (
                <MissingSubAccountItem
                  entityId={entityId}
                  missing={m}
                  accounts={accounts}
                  resolving={resolving}
                  onResolved={onResolved}
                />
              )}
            </li>
          );
        })}
      </ul>
      {others.length > 0 && (
        <MappingEditor
          entityId={entityId}
          mappings={{ accounts: others, taxes: [] }}
          accounts={accounts}
          taxCategories={[]}
          accountEdits={accountEdits}
          taxEdits={{}}
          onAccountEdit={(sourceName, target) =>
            setAccountEdits((edits) => ({ ...edits, [sourceName]: target }))
          }
          onTaxEdit={() => {}}
          onSaved={async () => onResolved()}
          hideTaxes
          saveNote="保存すると、次の取込でも使います。保存の後に案を作り直します。"
        />
      )}
    </div>
  );
}

/** 対応先の補助科目がまだない科目。001 の補助科目の作成（POST .../sub-accounts）で作ってから案を作り直す */
function MissingSubAccountItem({
  entityId,
  missing,
  accounts,
  resolving,
  onResolved,
}: {
  entityId: string;
  missing: MissingSubAccount;
  accounts: readonly Account[];
  resolving: boolean;
  onResolved: () => void;
}) {
  const queryClient = useQueryClient();
  const { sourceName, accountId, subAccountName } = missing;
  const create = useMutation({
    mutationFn: () => postSubAccount(entityId, accountId, { name: subAccountName }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: accountKeys.subAccounts(entityId, accountId),
      });
      onResolved();
    },
  });
  const accountName = accounts.find((a) => a.id === accountId)?.name ?? accountId;
  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{sourceName}</span>
        <span className="text-muted-foreground">
          「{accountName}」の補助科目「{subAccountName}」がまだありません
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={create.isPending || create.isSuccess || resolving}
          onClick={() => create.mutate()}
        >
          補助科目を作成<span className="sr-only">（{sourceName}）</span>
        </Button>
      </span>
      <ApiErrorMessage error={create.error} />
    </>
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
