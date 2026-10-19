import type { MappingRow } from "@trebuchet/schema";
import {
  FREEE_ACCOUNT_ALIASES,
  FREEE_CARD_ACCOUNT_CODE,
  FREEE_CARD_SUFFIX,
  FREEE_TAX_PROPOSALS,
  FREEE_UNMAPPABLE_ACCOUNTS,
} from "../../seed/freee-aliases.ts";
import type { Account, SubAccount, TaxCategory } from "../../types.ts";
import type { AccountMapping, TaxMapping } from "../types.ts";
import { normalizeName } from "./read.ts";

/** ファイルに出てくる名前（科目名・税区分名） */
export type MappingNames = { accounts: readonly string[]; taxes: readonly string[] };

export type SavedMappings = {
  accounts: readonly AccountMapping[];
  taxes: readonly TaxMapping[];
};

/** 名前ごとの対応先（status: saved = 保存済み、proposed = 初期案、unmapped = 未定） */
export type MappingProposal = { accounts: MappingRow[]; taxes: MappingRow[] };

/** 仕訳行の帳簿の科目と補助科目。補助科目は既存の ID か、新しく作る名前のどちらか */
export type ResolvedLineAccount = {
  accountId: string;
  subAccountId?: string | undefined;
  subAccountName?: string | undefined;
};

function uniqueNormalized(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeName(raw);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function findSubAccount(
  subAccounts: readonly SubAccount[],
  accountId: string,
  name: string,
): SubAccount | undefined {
  const wanted = normalizeName(name);
  return subAccounts.find((s) => s.accountId === accountId && normalizeName(s.name) === wanted);
}

/** 補助科目の名前を、既存の補助科目があればその ID に、なければ作る名前にする */
function subAccountTarget(
  subAccounts: readonly SubAccount[],
  accountId: string,
  name: string,
): Pick<ResolvedLineAccount, "subAccountId" | "subAccountName"> {
  const existing = findSubAccount(subAccounts, accountId, name);
  return existing === undefined
    ? { subAccountName: normalizeName(name) }
    : { subAccountId: existing.id };
}

function accountRow(
  name: string,
  saved: ReadonlyMap<string, AccountMapping>,
  accounts: readonly Account[],
  subAccounts: readonly SubAccount[],
): MappingRow {
  const unmapped: MappingRow = { sourceName: name, status: "unmapped" };
  if (FREEE_UNMAPPABLE_ACCOUNTS.includes(name)) return unmapped;

  const s = saved.get(name);
  if (s !== undefined && accounts.some((a) => a.id === s.accountId)) {
    const row: MappingRow = { sourceName: name, status: "saved", accountId: s.accountId };
    if (s.subAccountId !== undefined) return { ...row, subAccountId: s.subAccountId };
    if (s.subAccountName !== undefined) {
      return { ...row, ...subAccountTarget(subAccounts, s.accountId, s.subAccountName) };
    }
    return row;
  }

  const active = accounts.filter((a) => a.isActive);
  const proposed = (accountId: string): MappingRow => ({
    sourceName: name,
    status: "proposed",
    accountId,
  });
  const sameName = active.find((a) => normalizeName(a.name) === name);
  if (sameName !== undefined) return proposed(sameName.id);

  const aliasCode = FREEE_ACCOUNT_ALIASES[name];
  const alias = aliasCode === undefined ? undefined : active.find((a) => a.code === aliasCode);
  if (alias !== undefined) return proposed(alias.id);

  if (name.endsWith(FREEE_CARD_SUFFIX)) {
    const card = active.find((a) => a.code === FREEE_CARD_ACCOUNT_CODE);
    if (card !== undefined) {
      return { ...proposed(card.id), ...subAccountTarget(subAccounts, card.id, name) };
    }
  }
  return unmapped;
}

function taxRow(
  name: string,
  saved: ReadonlyMap<string, TaxMapping>,
  taxCategories: readonly TaxCategory[],
): MappingRow {
  const exists = (code: string) => taxCategories.some((c) => c.code === code);
  const s = saved.get(name);
  if (s !== undefined && exists(s.taxCategory)) {
    return { sourceName: name, status: "saved", taxCategory: s.taxCategory };
  }
  const proposal = FREEE_TAX_PROPOSALS[name];
  if (proposal !== undefined && exists(proposal)) {
    return { sourceName: name, status: "proposed", taxCategory: proposal };
  }
  return { sourceName: name, status: "unmapped" };
}

/**
 * ファイルに出てくる名前ごとに対応先を決める（FR-007〜009, research R13）。
 * 科目: 「損益」は常に未定 > 保存済み（対応先の科目が存在するもの）> 同名の有効な科目 > 言い換え > カードの規則 > 未定。
 * 税区分: 保存済み > 初期案 > 未定。名前は normalizeName で正規化し、重複を除いて初出の順に並べる
 */
export function proposeMappings(
  names: MappingNames,
  saved: SavedMappings,
  accounts: readonly Account[],
  subAccounts: readonly SubAccount[],
  taxCategories: readonly TaxCategory[],
): MappingProposal {
  const savedAccounts = new Map(saved.accounts.map((m) => [normalizeName(m.sourceName), m]));
  const savedTaxes = new Map(saved.taxes.map((m) => [normalizeName(m.sourceName), m]));
  return {
    accounts: uniqueNormalized(names.accounts).map((n) =>
      accountRow(n, savedAccounts, accounts, subAccounts),
    ),
    taxes: uniqueNormalized(names.taxes).map((n) => taxRow(n, savedTaxes, taxCategories)),
  };
}

/**
 * 対応表の行と freee の補助科目名から、仕訳行の科目と補助科目を決める（research R13 の補助科目）。
 * 対応表の行の補助科目を優先し、なければ freee の補助科目名（科目名と違うとき）を対応先の科目の同名の補助科目にする。
 * 対応先のない行は undefined
 */
export function resolveLineAccount(
  row: MappingRow,
  freeeAccountName: string,
  freeeSubAccountName: string | undefined,
  subAccounts: readonly SubAccount[],
): ResolvedLineAccount | undefined {
  const accountId = row.accountId;
  if (row.status === "unmapped" || accountId === undefined) return undefined;
  if (row.subAccountId !== undefined) return { accountId, subAccountId: row.subAccountId };
  if (row.subAccountName !== undefined) {
    return { accountId, ...subAccountTarget(subAccounts, accountId, row.subAccountName) };
  }
  const subName = freeeSubAccountName === undefined ? "" : normalizeName(freeeSubAccountName);
  if (subName === "" || subName === normalizeName(freeeAccountName)) return { accountId };
  return { accountId, ...subAccountTarget(subAccounts, accountId, subName) };
}
