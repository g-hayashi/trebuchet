import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuleStatus } from "@trebuchet/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type Account, accountsQuery, subAccountsQuery } from "@/features/accounts/api";
import { partnersQuery } from "@/features/masters/api";
import {
  postRuleStatus,
  postSeedRules,
  type RuleView,
  rulesQuery,
  statementAccountsQuery,
  statementKeys,
} from "./api";
import { PURPOSE_LABELS, RULE_STATUS_LABELS } from "./labels";
import { RuleEditor } from "./RuleEditor";
import { RuleHistoryPanel } from "./RuleHistoryPanel";
import { type SeedPreview, SeedRulesPanel } from "./SeedRulesPanel";

/** 相手の科目の名前。補助科目（カードなど）があれば添える */
function CounterName({
  entityId,
  rule,
  accounts,
}: {
  entityId: string;
  rule: RuleView;
  accounts: Account[] | undefined;
}) {
  const subs = useQuery({
    ...subAccountsQuery(entityId, rule.counterAccountId),
    enabled: rule.counterSubAccountId !== null,
  });
  const name = accounts?.find((a) => a.id === rule.counterAccountId)?.name ?? "（不明な科目）";
  const sub = subs.data?.find((s) => s.id === rule.counterSubAccountId)?.name;
  return <>{sub === undefined ? name : `${name}（${sub}）`}</>;
}

type Panel = { kind: "edit" | "history"; ruleId: string };

/**
 * 推定のルールの画面（US3。H:§5、FR-023・024）: 一覧（内容・口座・相手の科目・判定・取引先・確信度・
 * 適用と修正の回数・状態）、編集・停止・再開・履歴、過去の仕訳からの初期作成（案を見てから作る）。
 * ルールを変えると、その内容の未処理の候補が作り直されるので、明細の一覧も読み直す
 */
export function RuleList({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RuleStatus | "">("");
  const [panel, setPanel] = useState<Panel>();
  const [seed, setSeed] = useState<SeedPreview>();
  const [notice, setNotice] = useState("");

  const rules = useQuery(rulesQuery(entityId, status === "" ? undefined : status));
  const accounts = useQuery(accountsQuery(entityId));
  const partners = useQuery(partnersQuery(entityId));
  const statementAccounts = useQuery(statementAccountsQuery(entityId));
  const panelRule = rules.data?.find((r) => r.id === panel?.ruleId);

  const refresh = () => queryClient.invalidateQueries({ queryKey: statementKeys.all(entityId) });

  const toggle = useMutation({
    mutationFn: (rule: RuleView) =>
      postRuleStatus(entityId, rule.id, rule.status === "active" ? "pause" : "resume"),
    onSuccess: refresh,
  });
  const preview = useMutation({
    mutationFn: () => postSeedRules(entityId, true),
    onSuccess: (result) => {
      setNotice("");
      setSeed({ created: result.created, skipped: result.skipped, rules: result.rules ?? [] });
    },
  });

  const nameOf = <T extends { id: string; name: string }>(
    list: T[] | undefined,
    id: string | null,
    fallback: string,
  ) => (id === null ? fallback : (list?.find((x) => x.id === id)?.name ?? "（不明）"));
  const error = rules.error ?? accounts.error ?? partners.error ?? toggle.error ?? preview.error;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1">
          <Label htmlFor="rule-status">状態</Label>
          <NativeSelect
            id="rule-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as RuleStatus | "")}
          >
            <option value="">すべて</option>
            <option value="active">有効</option>
            <option value="paused">停止中</option>
          </NativeSelect>
        </div>
        <Button
          variant="outline"
          disabled={preview.isPending}
          onClick={() => {
            toggle.reset();
            preview.mutate();
          }}
        >
          過去の仕訳から作る
        </Button>
        {notice && <SaveNotice message={notice} />}
      </div>
      <ApiErrorMessage error={error} />

      {seed && (
        <SeedRulesPanel
          entityId={entityId}
          preview={seed}
          onClose={() => setSeed(undefined)}
          onCreated={async (created) => {
            setSeed(undefined);
            setNotice(`ルールを ${created} 件作りました。`);
            await refresh();
          }}
        />
      )}

      {rules.isPending && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {rules.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">該当するルールはありません。</p>
      )}
      {rules.data && rules.data.length > 0 && (
        <Table aria-label="ルールの一覧">
          <TableHeader>
            <TableRow>
              <TableHead>内容</TableHead>
              <TableHead>口座</TableHead>
              <TableHead>相手の科目</TableHead>
              <TableHead>判定</TableHead>
              <TableHead>取引先</TableHead>
              <TableHead className="text-right">確信度</TableHead>
              <TableHead>回数</TableHead>
              <TableHead>状態</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.data.map((r) => (
              <TableRow key={r.id} className="align-top">
                <TableCell>{r.normalizedContent}</TableCell>
                <TableCell>
                  {nameOf(statementAccounts.data, r.statementAccountId, "すべての口座")}
                </TableCell>
                <TableCell>
                  <CounterName entityId={entityId} rule={r} accounts={accounts.data} />
                </TableCell>
                <TableCell>{PURPOSE_LABELS[r.purpose]}</TableCell>
                <TableCell>{nameOf(partners.data, r.partnerId, "—")}</TableCell>
                <TableCell className="text-right tabular-nums">{r.confidence}</TableCell>
                <TableCell className="text-sm">
                  適用 {r.hits} 回
                  {r.overrides > 0 && <span className="block">修正 {r.overrides} 回</span>}
                </TableCell>
                <TableCell>{RULE_STATUS_LABELS[r.status]}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setNotice("");
                        setPanel({ kind: "edit", ruleId: r.id });
                      }}
                    >
                      編集
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={toggle.isPending}
                      onClick={() => {
                        preview.reset();
                        toggle.mutate(r);
                      }}
                    >
                      {r.status === "active" ? "停止" : "再開"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPanel({ kind: "history", ruleId: r.id })}
                    >
                      履歴
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {panelRule && panel?.kind === "edit" && (
        <RuleEditor
          key={panelRule.id}
          entityId={entityId}
          rule={panelRule}
          onClose={() => setPanel(undefined)}
          onSaved={async () => {
            setPanel(undefined);
            setNotice("保存しました。");
            await refresh();
          }}
        />
      )}
      {panelRule && panel?.kind === "history" && (
        <RuleHistoryPanel
          key={panelRule.id}
          entityId={entityId}
          rule={panelRule}
          onClose={() => setPanel(undefined)}
        />
      )}
    </div>
  );
}
