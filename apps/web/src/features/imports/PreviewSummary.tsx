import type { ImportPreview } from "@trebuchet/schema";
import { formatYen } from "@/lib/format";
import type { Account } from "@/lib/queries";
import { WARNING_LABELS } from "./labels";

const ENCODING_LABELS: Record<ImportPreview["file"]["encoding"], string> = {
  "utf-8": "UTF-8",
  shift_jis: "Shift_JIS",
};

/** プレビューの要約（FR-003）: 期間・件数・合計、新しく作るもの、警告の一覧 */
export function PreviewSummary({
  preview,
  accounts,
}: {
  preview: ImportPreview;
  accounts: readonly Account[] | undefined;
}) {
  const dates = preview.items.map((i) => i.date).sort();
  const period = dates.length > 0 ? `${dates[0]} 〜 ${dates[dates.length - 1]}` : "—";
  const { counts, totals, toCreate } = preview;
  const accountName = (id: string) => accounts?.find((a) => a.id === id)?.name ?? id;
  const journalNo = (id: string) =>
    preview.items.find((i) => i.freeeJournalId === id)?.freeeJournalNo ?? id;
  const items: [string, string][] = [
    ["期間", period],
    ["新規", `${counts.new}件`],
    ["取込済み", `${counts.already}件`],
    ["対象外", `${counts.excluded}件`],
    ["取込不可", `${counts.rejected}件`],
    ["警告", `${counts.warnings}件`],
    ["借方合計", `${formatYen(totals.debit)}円`],
    ["貸方合計", `${formatYen(totals.credit)}円`],
  ];
  const creates = [
    ...toCreate.subAccounts.map((s) => `補助科目: ${accountName(s.accountId)} ／ ${s.name}`),
    ...toCreate.partners.map((p) => `取引先: ${p}`),
    ...toCreate.tags.map((t) => `メモタグ: ${t}`),
  ];

  return (
    <section aria-label="プレビューの要約" className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        {preview.file.name}（{ENCODING_LABELS[preview.file.encoding]}、{preview.file.rowCount}
        行）。新規・合計は、新しく登録する仕訳のものです。
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        {items.map(([term, value]) => (
          <div key={term} className="grid gap-0.5">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-1 text-sm">
        <h3 className="font-medium">取込と同時に新しく作るもの</h3>
        {creates.length > 0 ? (
          <ul className="list-disc pl-5">
            {creates.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">ありません。</p>
        )}
      </div>
      {preview.warnings.length > 0 && (
        <div className="grid gap-1 text-sm">
          <h3 className="font-medium">警告（取込は妨げません）</h3>
          <ul aria-label="警告の一覧" className="grid gap-1">
            {preview.warnings.map((w, index) => (
              <li
                // 同じ仕訳に同じコードの警告が重なることがあるため、順番も使う
                // biome-ignore lint/suspicious/noArrayIndexKey: 警告は並べ替えない
                key={`${w.code}-${w.freeeJournalId ?? ""}-${index}`}
                className="rounded-md border border-amber-500/50 px-3 py-1.5"
              >
                <span className="font-medium">{WARNING_LABELS[w.code]}</span>
                {w.freeeJournalId && (
                  <span className="ml-2 text-muted-foreground">
                    仕訳 {journalNo(w.freeeJournalId)}
                  </span>
                )}
                <span className="ml-2">{w.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
