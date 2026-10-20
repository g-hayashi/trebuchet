import type { BlueReturn, BlueReturnWarning } from "@trebuchet/schema";
import { formatSignedAmount } from "../reports/warnings.ts";
import type { Account, FiscalPeriod, PostedLine } from "../types.ts";

/** 雑収入の科目コード（初期セットの雑収入）。売上高と同じ区分（PL_SALES）にあるので、コードで分ける */
export const MISC_INCOME_ACCOUNT_CODE = "4020";

type Monthly = BlueReturn["page2"]["monthly"];
type SalesPartners = BlueReturn["page3"]["salesPartners"];
type Range = Pick<FiscalPeriod, "startDate" | "endDate">;

/** 売上先の集計。salesPartners は BlueReturn の3ページ、duplicateNames は同名の別の取引先 */
export type SalesPartnersSummary = SalesPartners & {
  duplicateNames: { name: string; partnerIds: string[] }[];
};

type Kind = "sales" | "otherIncome";

/**
 * 売上の科目の分類（欄1 に入る科目だけ。欄1 = 売上・その他の損益の区分の合計）。
 * 雑収入の科目コード、または「その他」の区分の科目は雑収入、残りの売上の区分の科目は売上高
 */
function incomeKinds(accounts: readonly Account[]): Map<string, Kind> {
  const kinds = new Map<string, Kind>();
  for (const a of accounts) {
    if (a.reportSection === "PL_OTHER") kinds.set(a.id, "otherIncome");
    else if (a.reportSection === "PL_SALES") {
      kinds.set(a.id, a.code === MISC_INCOME_ACCOUNT_CODE ? "otherIncome" : "sales");
    }
  }
  return kinds;
}

/** 貸方を正とする金額（借方の売上・訂正は差し引く） */
const creditNet = (l: Pick<PostedLine, "side" | "amount">) =>
  l.side === "credit" ? l.amount : -l.amount;

/** 有効（取消済みでない）で期間内の行。buildProfitAndLoss と同じ条件 */
const inRange = (l: PostedLine, range: Range) =>
  l.status === "active" && l.date >= range.startDate && l.date <= range.endDate;

/**
 * 月別の売上高・雑収入・計（FR-024、R10）。月ごとに貸方−借方（借方の売上は差し引く）。
 * 月は行の日付の月（個人の年度は暦年）。months は常に1〜12月の12件
 */
export function summarizeMonthlySales(
  lines: readonly PostedLine[],
  accounts: readonly Account[],
  range: Range,
): Monthly {
  const kinds = incomeKinds(accounts);
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    sales: 0,
    otherIncome: 0,
    total: 0,
  }));
  for (const l of lines) {
    const kind = kinds.get(l.accountId);
    if (kind === undefined || !inRange(l, range)) continue;
    const row = months[Number(l.date.slice(5, 7)) - 1];
    if (row === undefined) continue;
    row[kind] += creditNet(l);
    row.total += creditNet(l);
  }
  const sales = months.reduce((s, m) => s + m.sales, 0);
  const otherIncome = months.reduce((s, m) => s + m.otherIncome, 0);
  return { months, total: { sales, otherIncome, total: sales + otherIncome } };
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 売上先の明細（FR-025〜026、R10）。売上高の行を取引先ごとに貸方−借方で集計し、金額の降順
 * （同額は取引先名、取引先 ID の順）に `rows` 行まで個別に出す。合計が 0 以下の取引先は個別に出さない
 * （「上記以外」に入る）。残りの取引先・取引先のない売上高の行・雑収入を「上記以外の売上先の計」
 * （others）にまとめる。合計（個別の行 + others）は欄1 と一致する（INV-24）。
 * withoutPartner は取引先のない売上高の行の件数と金額（なければ null）。
 * duplicateNames は、売上先に現れる同名の別の取引先
 */
export function summarizeSalesPartners(
  lines: readonly PostedLine[],
  accounts: readonly Account[],
  range: Range,
  rows: number,
): SalesPartnersSummary {
  const kinds = incomeKinds(accounts);
  const byPartner = new Map<string, { partnerId: string; name: string; amount: number }>();
  let withoutCount = 0;
  let withoutAmount = 0;
  let otherIncome = 0;
  for (const l of lines) {
    const kind = kinds.get(l.accountId);
    if (kind === undefined || !inRange(l, range)) continue;
    if (kind === "otherIncome") {
      otherIncome += creditNet(l);
    } else if (l.partnerId === null) {
      withoutCount += 1;
      withoutAmount += creditNet(l);
    } else {
      const entry = byPartner.get(l.partnerId) ?? {
        partnerId: l.partnerId,
        name: l.partnerName ?? "",
        amount: 0,
      };
      entry.amount += creditNet(l);
      byPartner.set(l.partnerId, entry);
    }
  }

  const sorted = [...byPartner.values()].sort(
    (a, b) => b.amount - a.amount || byName(a.name, b.name) || byName(a.partnerId, b.partnerId),
  );
  const individual = sorted.filter((p) => p.amount > 0).slice(0, rows);
  const listed = new Set(individual.map((p) => p.partnerId));
  const remainder = sorted
    .filter((p) => !listed.has(p.partnerId))
    .reduce((s, p) => s + p.amount, 0);

  const idsByName = new Map<string, string[]>();
  for (const p of sorted) idsByName.set(p.name, [...(idsByName.get(p.name) ?? []), p.partnerId]);
  const duplicateNames = [...idsByName]
    .filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ name, partnerIds: [...ids].sort(byName) }))
    .sort((a, b) => byName(a.name, b.name));

  const others = remainder + withoutAmount + otherIncome;
  return {
    rows: individual,
    others,
    total: individual.reduce((s, p) => s + p.amount, 0) + others,
    withoutPartner: withoutCount === 0 ? null : { count: withoutCount, amount: withoutAmount },
    duplicateNames,
  };
}

/**
 * 売上まわりの警告（FR-026）。月別の合計・売上先の合計が欄1 と違えば SALES_TOTAL_MISMATCH（差額）、
 * 取引先のない売上があれば SALES_WITHOUT_PARTNER（件数と金額）、同名の別の取引先は
 * DUPLICATE_PARTNER_NAME（名前と取引先 ID）。同名は名前の順
 */
export function salesWarnings(input: {
  line1: number;
  monthly: Monthly;
  partners: SalesPartnersSummary;
}): BlueReturnWarning[] {
  const { line1, monthly, partners } = input;
  const out: BlueReturnWarning[] = [];
  const mismatch = (target: "monthly" | "partners", label: string, total: number) => {
    if (total === line1) return;
    out.push({
      code: "SALES_TOTAL_MISMATCH",
      message: `${label}の合計（${formatSignedAmount(total)} 円）が欄1（${formatSignedAmount(line1)} 円）と一致しません（差額 ${formatSignedAmount(total - line1)} 円）`,
      details: { target, line1, total, difference: total - line1 },
    });
  };
  mismatch("monthly", "月別売上", monthly.total.total);
  mismatch(
    "partners",
    "売上先の明細",
    partners.rows.reduce((s, r) => s + r.amount, 0) + partners.others,
  );
  if (partners.withoutPartner !== null) {
    const { count, amount } = partners.withoutPartner;
    out.push({
      code: "SALES_WITHOUT_PARTNER",
      message: `取引先が付いていない売上の行が ${count} 件（${formatSignedAmount(amount)} 円）あります。「上記以外の売上先の計」に含めています`,
      details: { count, amount },
    });
  }
  for (const { name, partnerIds } of partners.duplicateNames) {
    out.push({
      code: "DUPLICATE_PARTNER_NAME",
      message: `同じ名前（${name}）の別の取引先が ${partnerIds.length} 件あります。売上先の明細では別々の行になります`,
      details: { name, partnerIds },
    });
  }
  return out;
}
