import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { accountsQuery } from "@/features/accounts/api";
import { postSeedRules, type RuleView } from "./api";
import { PURPOSE_LABELS } from "./labels";

export type SeedPreview = { created: number; skipped: number; rules: RuleView[] };

/**
 * ルールの初期作成の案（H:§5.2、FR-023）。過去の確定仕訳から作れるルールを、作る前に見せる。
 * 「この案で作る」で実行する（案の件数は、実行のときに数え直す）
 */
export function SeedRulesPanel({
  entityId,
  preview,
  onCreated,
  onClose,
}: {
  entityId: string;
  preview: SeedPreview;
  onCreated: (created: number) => void;
  onClose: () => void;
}) {
  const accounts = useQuery(accountsQuery(entityId));
  const create = useMutation({
    mutationFn: () => postSeedRules(entityId, false),
    onSuccess: (result) => onCreated(result.created),
  });

  return (
    <section aria-label="作成の案" className="grid gap-3 rounded-md border px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <h2 className="font-medium">過去の仕訳から作るルールの案</h2>
          {preview.created === 0 ? (
            <p className="text-sm text-muted-foreground">作れるルールはありません。</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {preview.created} 件のルールを作れます
              {preview.skipped > 0 && `（すでにあるルール ${preview.skipped} 件は作りません）`}。
              同じ内容の仕訳が 2 件以上あり、4 分の 3 以上が同じ科目・税区分・取引先のものだけです。
            </p>
          )}
        </div>
        <Button variant="ghost" onClick={onClose}>
          閉じる
        </Button>
      </div>
      {preview.rules.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {preview.rules.map((r) => (
            <li key={r.normalizedContent} className="rounded-md border px-3 py-1.5">
              {r.normalizedContent} →{" "}
              {accounts.data?.find((a) => a.id === r.counterAccountId)?.name ?? "（科目）"}（
              {PURPOSE_LABELS[r.purpose]}、根拠の仕訳 {r.hits} 件）
            </li>
          ))}
        </ul>
      )}
      <ApiErrorMessage error={create.error} />
      {preview.created > 0 && (
        <div>
          <Button disabled={create.isPending} onClick={() => create.mutate()}>
            この案で作る
          </Button>
        </div>
      )}
    </section>
  );
}
