import { useQuery } from "@tanstack/react-query";
import type { ReceiptHistoryEntry } from "@trebuchet/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { formatDateTime } from "@/lib/format";
import { receiptFileUrl, receiptHistoryQuery } from "./api";
import { CATEGORY_LABELS, HISTORY_ACTION_LABELS, HISTORY_VALUE_LABELS } from "./labels";

type Values = Record<string, unknown>;

const asValues = (value: unknown): Values | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Values)
    : undefined;

const UNSET = "未入力";

/** 履歴の値の表示。区分は表示名、金額は 3 桁区切り、null は「未入力」 */
function valueText(key: keyof typeof HISTORY_VALUE_LABELS, value: unknown): string {
  if (value === null || value === undefined || value === "") return UNSET;
  if (key === "category" && (value === "paper_scan" || value === "electronic")) {
    return CATEGORY_LABELS[value];
  }
  if (key === "amount" && typeof value === "number") return `${value.toLocaleString("ja-JP")} 円`;
  return String(value);
}

/** 訂正で変わった項目（前後の値が違うものだけ） */
function changesOf(entry: ReceiptHistoryEntry): { label: string; before: string; after: string }[] {
  const before = asValues(entry.before);
  const after = asValues(entry.after);
  if (before === undefined || after === undefined) return [];
  return (Object.keys(HISTORY_VALUE_LABELS) as (keyof typeof HISTORY_VALUE_LABELS)[])
    .filter((key) => before[key] !== after[key])
    .map((key) => ({
      label: HISTORY_VALUE_LABELS[key],
      before: valueText(key, before[key]),
      after: valueText(key, after[key]),
    }));
}

/** 差し替えの前後のファイルの版（履歴の `sha256`・`fileVersion`） */
function fileOf(value: unknown): { sha256: string; fileVersion: number } | undefined {
  const v = asValues(value);
  return typeof v?.sha256 === "string" && typeof v.fileVersion === "number"
    ? { sha256: v.sha256, fileVersion: v.fileVersion }
    : undefined;
}

function EntryBody({
  entityId,
  receiptId,
  entry,
}: {
  entityId: string;
  receiptId: string;
  entry: ReceiptHistoryEntry;
}) {
  if (entry.action === "update") {
    return (
      <div className="mt-1 grid gap-0.5">
        {changesOf(entry).map((c) => (
          <div key={c.label}>
            {c.label}: {c.before} → {c.after}
          </div>
        ))}
      </div>
    );
  }
  if (entry.action === "replace_file") {
    const files = [fileOf(entry.before), fileOf(entry.after)].filter((f) => f !== undefined);
    return (
      <p className="mt-1 flex flex-wrap gap-3">
        {files.map((f) => (
          <a
            key={f.sha256}
            href={receiptFileUrl(entityId, receiptId, f.sha256, "original")}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            版 {f.fileVersion} を開く
          </a>
        ))}
      </p>
    );
  }
  return null;
}

/**
 * 証憑の履歴（US5、FR-018・SC-005）。追加・訂正・差し替え・削除・結びつけを古い順に、
 * 日時・理由・訂正の前後の値・差し替え前のファイルへのリンクで示す。削除済みの証憑でも開ける
 */
export function ReceiptHistory({ entityId, receiptId }: { entityId: string; receiptId: string }) {
  const query = useQuery(receiptHistoryQuery(entityId, receiptId));
  return (
    <section aria-label="履歴">
      <Card>
        <CardHeader>
          <CardTitle>履歴</CardTitle>
        </CardHeader>
        <CardContent>
          <ApiErrorMessage error={query.error} />
          {query.isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {query.data && (
            <ol className="grid gap-3 text-sm">
              {query.data.map((entry, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 履歴は追記のみで並びが変わらず、同じ時刻の記録がありうる（ID を持たない）
                <li key={`${entry.occurredAt}-${i}`} className="grid gap-0.5 border-b pb-2">
                  <div>
                    <span className="font-medium">{HISTORY_ACTION_LABELS[entry.action]}</span>{" "}
                    <time dateTime={entry.occurredAt} className="text-muted-foreground">
                      {formatDateTime(entry.occurredAt)}
                    </time>
                  </div>
                  {entry.reason && <div>理由: {entry.reason}</div>}
                  <EntryBody entityId={entityId} receiptId={receiptId} entry={entry} />
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
