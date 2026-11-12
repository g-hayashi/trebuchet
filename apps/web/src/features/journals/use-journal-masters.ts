import { useQuery } from "@tanstack/react-query";
import { accountsQuery } from "@/features/accounts/api";
import { taxCategoriesQuery, taxSettingsQuery } from "@/features/entities/api";
import { partnersQuery, tagsQuery } from "@/features/masters/api";

/**
 * 仕訳の入力に要るマスタ（科目・取引先・タグ・税設定・税区分）の query の束。
 * loadError は最初のエラー。queries は読み込み中かどうかを見るために並べたもの
 */
export function useJournalMasters(entityId: string) {
  const accounts = useQuery(accountsQuery(entityId));
  const partners = useQuery(partnersQuery(entityId));
  const tags = useQuery(tagsQuery(entityId));
  const taxSettings = useQuery(taxSettingsQuery(entityId));
  const taxCategories = useQuery(taxCategoriesQuery(entityId));
  const queries = [accounts, partners, tags, taxSettings, taxCategories];
  const loadError = queries.find((q) => q.error)?.error;
  return { accounts, partners, tags, taxSettings, taxCategories, queries, loadError };
}
