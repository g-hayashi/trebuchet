import { ACCOUNT_READINGS } from "@trebuchet/schema";

type SearchableAccount = { code: string; name: string; isSystem: boolean };

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().trim();

/** 名前・コードと、初期科目だけ読みの部分一致で探す（011 R5、D3）。 */
export function matchesAccount(account: SearchableAccount, query: string): boolean {
  const needle = normalize(query);
  return [
    account.name,
    account.code,
    ...(account.isSystem ? [ACCOUNT_READINGS[account.code] ?? ""] : []),
  ].some((value) => normalize(value).includes(needle));
}

export function filterAccounts<T extends SearchableAccount>(
  accounts: readonly T[],
  query: string,
): T[] {
  return accounts.filter((account) => matchesAccount(account, query));
}
