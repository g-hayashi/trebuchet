import type { AccountCategory, ReportSection } from "@trebuchet/schema";

export const CATEGORY_LABELS: Record<AccountCategory, string> = {
  asset: "資産",
  liability: "負債",
  equity: "純資産",
  revenue: "収益",
  expense: "費用",
};

export const SECTION_LABELS: Record<ReportSection, string> = {
  BS_ASSET: "資産",
  BS_LIABILITY: "負債",
  BS_EQUITY: "純資産",
  PL_SALES: "売上",
  PL_COGS: "売上原価",
  PL_EXPENSE: "経費",
  PL_OTHER: "その他の損益",
};

/** 科目の区分ごとに選べる決算書の区分（packages/domain の ALLOWED_SECTIONS と同じ） */
const ALLOWED_SECTIONS: Record<AccountCategory, readonly ReportSection[]> = {
  asset: ["BS_ASSET"],
  liability: ["BS_LIABILITY"],
  equity: ["BS_EQUITY", "BS_ASSET"],
  revenue: ["PL_SALES", "PL_OTHER"],
  expense: ["PL_COGS", "PL_EXPENSE", "PL_OTHER"],
};

export function sectionsForCategory(category: AccountCategory): readonly ReportSection[] {
  return ALLOWED_SECTIONS[category];
}

export type AccountGroup<A> = { section: ReportSection; label: string; accounts: A[] };

/** 科目を決算書の順（sortOrder）に並べ、決算書の区分ごとにまとめる */
export function groupAccountsBySection<
  A extends { reportSection: ReportSection; sortOrder: number },
>(accounts: readonly A[]): AccountGroup<A>[] {
  const groups = new Map<ReportSection, AccountGroup<A>>();
  for (const account of [...accounts].sort((a, b) => a.sortOrder - b.sortOrder)) {
    let group = groups.get(account.reportSection);
    if (group === undefined) {
      group = {
        section: account.reportSection,
        label: SECTION_LABELS[account.reportSection],
        accounts: [],
      };
      groups.set(account.reportSection, group);
    }
    group.accounts.push(account);
  }
  return [...groups.values()];
}
