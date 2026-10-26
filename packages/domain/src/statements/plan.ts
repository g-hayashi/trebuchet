import { addDays } from "../dates.ts";
import { assignKeys } from "./keys.ts";
import { normalizeContent } from "./normalize.ts";
import type { PastedRow } from "./paste.ts";

/** 取込の計画（006 R3・R14、FR-004〜006）。純関数。帳簿・DB には触れない */

/** 計画が突き合わせる、保存済みの明細（口座は名前で持つ） */
export type ExistingStatement = {
  id: string;
  stableKey: string;
  externalId: string | null;
  accountName: string;
  date: string;
  amount: number;
  content: string;
  categoryMajor: string | null;
  categoryMinor: string | null;
  memo: string | null;
};

export type PlannedRowStatus = "new" | "existing" | "changed";

/** 変更ありの変更前後（内容の項目。値がなければ null） */
export type StatementContent = {
  accountName: string;
  date: string;
  amount: number;
  content: string;
  categoryMajor: string | null;
  categoryMinor: string | null;
  memo: string | null;
};

export type PlannedStatementRow = {
  key: string;
  row: PastedRow;
  status: PlannedRowStatus;
  /** `changed` の行が指す保存済みの明細 */
  existingId?: string;
  changed?: { before: StatementContent; after: StatementContent };
  warnings: "POSSIBLE_DUPLICATE"[];
};

export type StatementImportPlan = {
  rows: PlannedStatementRow[];
  /** `statement_accounts` にない保有金融機関の名前（重複なし、名前順） */
  unmappedAccounts: string[];
  /** 入出金の合計（入金は正の合計、出金は負の合計の絶対値）。読めた行すべて */
  totals: { inflow: number; outflow: number };
  /** 行の日付の範囲。行がなければ null */
  period: { from: string; to: string } | null;
  countNew: number;
  countExisting: number;
  countChanged: number;
};

/** 重複の疑いで見る日付の幅（日。R3） */
const DUPLICATE_WINDOW_DAYS = 3;

const contentOfRow = (row: PastedRow): StatementContent => ({
  accountName: row.accountName,
  date: row.date,
  amount: row.amount,
  content: row.content,
  categoryMajor: row.categoryMajor ?? null,
  categoryMinor: row.categoryMinor ?? null,
  memo: row.memo ?? null,
});

const contentOfExisting = (e: ExistingStatement): StatementContent => ({
  accountName: e.accountName,
  date: e.date,
  amount: e.amount,
  content: e.content,
  categoryMajor: e.categoryMajor,
  categoryMinor: e.categoryMinor,
  memo: e.memo,
});

const sameContent = (a: StatementContent, b: StatementContent): boolean =>
  a.accountName === b.accountName &&
  a.date === b.date &&
  a.amount === b.amount &&
  a.content === b.content &&
  a.categoryMajor === b.categoryMajor &&
  a.categoryMinor === b.categoryMinor &&
  a.memo === b.memo;

/**
 * 貼り付けた行を、保存済みの明細と突き合わせて計画にする。
 * - キーが保存済みと同じ → `existing`（external_id が同じで内容が違えば `changed`）
 * - external_id が保存済みと同じで内容が違う → `changed`（変更前後つき）
 * - それ以外 → `new`。保存済みの明細と「口座・金額・内容が同じで日付が 3 日以内」または
 *   「口座・日付・内容が同じで金額が違う」なら警告 `POSSIBLE_DUPLICATE`
 *
 * 同じ入力を取り込んだ後の 2 回目は `new` が 0 件になり、行の順を入れ替えても `new` の集合は同じ（INV-40）
 */
export function planStatementImport(
  rows: readonly PastedRow[],
  existing: readonly ExistingStatement[],
  accounts: readonly { name: string }[],
): StatementImportPlan {
  const keys = assignKeys(rows);
  const byKey = new Map(existing.map((e) => [e.stableKey, e]));
  const byExternalId = new Map<string, ExistingStatement>();
  for (const e of existing) {
    if (e.externalId !== null) byExternalId.set(e.externalId, e);
  }
  // 重複の疑いの検索用: 口座と正規化した内容が同じ保存済みの明細
  const bySameContent = new Map<string, ExistingStatement[]>();
  for (const e of existing) {
    const k = contentGroup(e.accountName, e.content);
    const list = bySameContent.get(k) ?? [];
    list.push(e);
    bySameContent.set(k, list);
  }

  const planned: PlannedStatementRow[] = rows.map((row, i) => {
    const key = keys[i] as string;
    const after = contentOfRow(row);

    const sameExternal =
      row.externalId === undefined ? undefined : byExternalId.get(row.externalId);
    const stored = sameExternal ?? byKey.get(key);
    if (stored !== undefined) {
      const before = contentOfExisting(stored);
      if (sameExternal !== undefined && !sameContent(before, after)) {
        return {
          key,
          row,
          status: "changed",
          existingId: stored.id,
          changed: { before, after },
          warnings: [],
        };
      }
      return { key, row, status: "existing", existingId: stored.id, warnings: [] };
    }
    return {
      key,
      row,
      status: "new",
      warnings: isPossibleDuplicate(
        row,
        bySameContent.get(contentGroup(row.accountName, row.content)) ?? [],
      )
        ? ["POSSIBLE_DUPLICATE"]
        : [],
    };
  });

  const known = new Set(accounts.map((a) => a.name));
  const unmapped = [...new Set(rows.map((r) => r.accountName).filter((n) => !known.has(n)))].sort();

  let inflow = 0;
  let outflow = 0;
  for (const r of rows) {
    if (r.amount > 0) inflow += r.amount;
    else outflow -= r.amount;
  }
  const dates = rows.map((r) => r.date).sort();
  const from = dates[0];
  const to = dates[dates.length - 1];

  return {
    rows: planned,
    unmappedAccounts: unmapped,
    totals: { inflow, outflow },
    period: from === undefined || to === undefined ? null : { from, to },
    countNew: planned.filter((r) => r.status === "new").length,
    countExisting: planned.filter((r) => r.status === "existing").length,
    countChanged: planned.filter((r) => r.status === "changed").length,
  };
}

/** 重複の疑いで突き合わせる単位（口座の名前と正規化した内容が同じ明細）のキー */
export const contentGroup = (accountName: string, content: string): string =>
  `${accountName}\u0000${normalizeContent(content)}`;

/**
 * 口座・正規化した内容が同じ明細（`sameContent`）のうち、`target` と重複の疑いのあるもの（R3）:
 * 金額が同じで日付が 3 日以内、または日付が同じで金額が違う。
 * 取込の計画（新規の行）と、明細の一覧の `duplicateOf` が同じ判定を使う
 */
export function possibleDuplicatesOf<T extends { date: string; amount: number }>(
  target: { date: string; amount: number },
  sameContent: readonly T[],
): T[] {
  const from = addDays(target.date, -DUPLICATE_WINDOW_DAYS);
  const to = addDays(target.date, DUPLICATE_WINDOW_DAYS);
  return sameContent.filter((e) =>
    e.amount === target.amount ? e.date >= from && e.date <= to : e.date === target.date,
  );
}

/** 口座・正規化した内容が同じ保存済みの明細に、重複の疑いのあるものがあるか（R3） */
const isPossibleDuplicate = (row: PastedRow, sameContent: readonly ExistingStatement[]): boolean =>
  possibleDuplicatesOf(row, sameContent).length > 0;
