import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { accountsQuery } from "@/features/accounts/api";
import { partnersQuery } from "@/features/masters/api";
import { type RuleHistoryEntry, type RuleView, ruleHistoryQuery } from "./api";
import { PURPOSE_LABELS, RULE_ACTION_LABELS, RULE_STATUS_LABELS } from "./labels";

type Snapshot = Record<string, unknown>;

const asSnapshot = (value: unknown): Snapshot | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Snapshot) : null;

/** 履歴の before・after（ルールの JSON）の差を、項目ごとの「前 → 後」の文にする */
function changes(
  entry: RuleHistoryEntry,
  names: { account: (id: unknown) => string; partner: (id: unknown) => string },
): string[] {
  const before = asSnapshot(entry.before);
  const after = asSnapshot(entry.after);
  if (before === null || after === null) return [];
  const text = (v: unknown): string =>
    v === null || v === undefined || v === "" ? "なし" : String(v);
  const fields: [key: string, label: string, show: (v: unknown) => string][] = [
    ["counterAccountId", "相手の科目", names.account],
    ["partnerId", "取引先", names.partner],
    ["taxCategory", "税区分", text],
    ["purpose", "判定", (v) => PURPOSE_LABELS[v as RuleView["purpose"]] ?? text(v)],
    ["descriptionTemplate", "摘要", text],
    ["hits", "適用の回数", text],
    ["overrides", "修正の回数", text],
    ["status", "状態", (v) => RULE_STATUS_LABELS[v as RuleView["status"]] ?? text(v)],
  ];
  return fields
    .filter(([key]) => before[key] !== after[key])
    .map(([key, label, show]) => `${label}: ${show(before[key])} → ${show(after[key])}`);
}

/** ルールの履歴（H:§5.5、FR-022）。追記の順に、操作・日時・変わった項目を出す */
export function RuleHistoryPanel({
  entityId,
  rule,
  onClose,
}: {
  entityId: string;
  rule: RuleView;
  onClose: () => void;
}) {
  const history = useQuery(ruleHistoryQuery(entityId, rule.id));
  const accounts = useQuery(accountsQuery(entityId));
  const partners = useQuery(partnersQuery(entityId));
  const names = {
    account: (id: unknown) => accounts.data?.find((a) => a.id === id)?.name ?? String(id),
    partner: (id: unknown) =>
      id === null || id === undefined
        ? "なし"
        : (partners.data?.find((p) => p.id === id)?.name ?? String(id)),
  };

  return (
    <section aria-label="ルールの履歴" className="grid gap-3 rounded-md border px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="font-medium">ルールの履歴: {rule.normalizedContent}</h2>
        <Button variant="ghost" onClick={onClose}>
          閉じる
        </Button>
      </div>
      <ApiErrorMessage error={history.error} />
      {history.isPending && !history.error && (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      )}
      {history.data && (
        <ul className="grid gap-2 text-sm">
          {history.data.map((h) => {
            const diff = changes(h, names);
            return (
              <li key={h.id} className="grid gap-0.5 rounded-md border px-3 py-2">
                <span>
                  <span className="font-medium">{RULE_ACTION_LABELS[h.action]}</span>{" "}
                  <span className="text-muted-foreground">{h.at.slice(0, 10)}</span>
                </span>
                {diff.map((d) => (
                  <span key={d} className="text-muted-foreground">
                    {d}
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
