import type { StatementImportPreview } from "@trebuchet/schema";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatYen } from "@/lib/format";
import { changedFields } from "./changes";

type Row = StatementImportPreview["rows"][number];

const STATUS_LABELS: Record<Row["status"], string> = {
  new: "新規",
  existing: "取込済み",
  changed: "変更あり",
};

const rowTitle = (r: Row) => `${r.date} ${r.accountName} ${r.content}`;

/**
 * 取込のプレビュー（006/FR-002・004〜006）: 期間・件数・合計、読めない行、重複の疑い、変更ありの行の変更前後、
 * 取り込む明細の一覧。口座の対応と確定のボタンは画面（`StatementImportPage`）が置く
 */
export function ImportPreview({ preview }: { preview: StatementImportPreview }) {
  const count = (status: Row["status"]) => preview.rows.filter((r) => r.status === status).length;
  const duplicates = preview.rows.filter((r) => r.warnings.includes("POSSIBLE_DUPLICATE"));
  const changed = preview.rows.filter((r) => r.status === "changed" && r.changed !== undefined);
  const items: [string, string][] = [
    ["期間", `${preview.period.from} 〜 ${preview.period.to}`],
    ["新規", `${preview.countNew}件`],
    ["取込済み", `${count("existing")}件`],
    ["変更あり", `${count("changed")}件`],
    ["読めない行", `${preview.unreadable.length}件`],
    ["入金の合計", `${formatYen(preview.totals.inflow)}円`],
    ["出金の合計", `${formatYen(preview.totals.outflow)}円`],
  ];

  return (
    <div className="grid gap-4">
      <section aria-label="プレビューの要約" className="grid gap-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          {items.map(([term, value]) => (
            <div key={term} className="grid gap-0.5">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {preview.unreadable.length > 0 && (
        <div className="grid gap-1 text-sm">
          <h3 className="font-medium">読めない行（取り込みません）</h3>
          <ul aria-label="読めない行の一覧" className="list-disc pl-5">
            {preview.unreadable.map((u) => (
              <li key={u.line}>
                {u.line} 行目: {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {duplicates.length > 0 && (
        <div className="grid gap-1 text-sm">
          <h3 className="font-medium">重複の疑い（取り込みは妨げません）</h3>
          <p className="text-muted-foreground">
            すでにある明細と、口座・金額・内容が同じで日付が近い（または日付・内容が同じで金額が違う）行です。同じ取引なら、取り込んだ後に除外してください。
          </p>
          <ul aria-label="重複の疑いの一覧" className="grid gap-1">
            {duplicates.map((r) => (
              <li key={r.key} className="rounded-md border border-amber-500/50 px-3 py-1.5">
                {rowTitle(r)}（{formatYen(r.amount)}円）
              </li>
            ))}
          </ul>
        </div>
      )}

      {changed.length > 0 && (
        <div className="grid gap-1 text-sm">
          <h3 className="font-medium">変更あり（取り込むと、新しい内容を確認に出します）</h3>
          <ul aria-label="変更ありの行の一覧" className="grid gap-1">
            {changed.map((r) => (
              <li key={r.key} className="rounded-md border px-3 py-1.5">
                <p className="font-medium">{rowTitle(r)}</p>
                <ul className="list-disc pl-5">
                  {r.changed ? changedFields(r.changed).map((f) => <li key={f}>{f}</li>) : null}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Table aria-label="取り込む明細の一覧">
        <TableHeader>
          <TableRow>
            <TableHead>日付</TableHead>
            <TableHead>口座</TableHead>
            <TableHead>内容</TableHead>
            <TableHead className="text-right">金額</TableHead>
            <TableHead>状態</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell>{r.date}</TableCell>
              <TableCell>{r.accountName}</TableCell>
              <TableCell>{r.content}</TableCell>
              <TableCell className="text-right tabular-nums">{formatYen(r.amount)}</TableCell>
              <TableCell>
                {STATUS_LABELS[r.status]}
                {r.warnings.includes("POSSIBLE_DUPLICATE") && "（重複の疑い）"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
