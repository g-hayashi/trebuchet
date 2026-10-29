import type { StatementAccountSuggestion } from "@trebuchet/schema";
import type { Account, SubAccount } from "../types.ts";
import { STATEMENT_ACCOUNT_CODES } from "./journal-shape.ts";

/**
 * 取込元の口座（明細の口座）の対応の推定（007 R9、FR-013・015）。語の表による規則で、AI を使わない。
 * 比べるときは NFKC・英字の大小を無視した部分一致
 */

type InferredKind = "card" | "bank" | "cash";

/**
 * 種類ごとの帳簿の科目のコード（005/R10 と同じく、科目はコードで引く）。
 * 未払金（カード）・普通預金（銀行）・現金
 */
export const KIND_ACCOUNT_CODES = {
  card: STATEMENT_ACCOUNT_CODES.accountsPayable,
  bank: STATEMENT_ACCOUNT_CODES.ordinaryDeposit,
  cash: STATEMENT_ACCOUNT_CODES.cash,
} as const;

/** 種類を決める手がかりの語（表の順に手がかりとして返す）。電子マネー（Suica など）は科目を決められないので持たない */
export const ACCOUNT_CUES: Readonly<Record<InferredKind, readonly string[]>> = {
  card: ["カード", "クレジット", "CARD", "VISA", "MASTER", "JCB", "AMEX", "ダイナース"],
  bank: ["銀行", "信用金庫", "信金", "信用組合", "労働金庫", "ゆうちょ", "普通", "預金", "BANK"],
  cash: ["現金", "財布", "サイフ"],
};

/** 用途を決める手がかりの語。名前だけを見る。両方に当たれば推定しない */
export const USAGE_CUES = {
  business: ["事業", "ビジネス", "法人", "BUSINESS"],
  private: ["個人用", "家計", "私用"],
} as const;

const KINDS: readonly InferredKind[] = ["card", "bank", "cash"];

const fold = (s: string): string => s.normalize("NFKC").toLowerCase();

/** `text` に含まれる語（表の順。表記は表のまま） */
const cuesIn = (text: string, cues: readonly string[]): string[] => {
  const folded = fold(text);
  return cues.filter((cue) => folded.includes(fold(cue)));
};

/** 手がかりの語が当たった種類と語。種類ごとに 1 つ以上当たったものだけ */
const kindsIn = (text: string): Map<InferredKind, string[]> => {
  const found = new Map<InferredKind, string[]>();
  for (const kind of KINDS) {
    const hits = cuesIn(text, ACCOUNT_CUES[kind]);
    if (hits.length > 0) found.set(kind, hits);
  }
  return found;
};

/** 名前で種類が決まればその種類と語。名前が決めきれなければ（2 種類以上）null。どれも当たらなければ大項目を見る */
function decideKind(
  name: string,
  categoryMajors: readonly string[],
): { kind: InferredKind; cues: string[] } | null {
  const byName = kindsIn(name);
  if (byName.size >= 2) return null;
  const [named] = [...byName];
  if (named !== undefined) return { kind: named[0], cues: named[1] };

  const byMajor = new Map<InferredKind, string[]>();
  for (const major of categoryMajors) {
    for (const kind of kindsIn(major).keys()) {
      byMajor.set(kind, [...(byMajor.get(kind) ?? []), `大項目: ${major}`]);
    }
  }
  if (byMajor.size !== 1) return null;
  const [decided] = [...byMajor];
  return decided === undefined ? null : { kind: decided[0], cues: decided[1] };
}

/** 名前が互いに含み合う（どちらかがもう一方に含まれる）有効な補助科目が 1 つだけなら、その ID */
function decideSubAccount(
  name: string,
  accountId: string,
  subAccounts: readonly SubAccount[],
): string | null {
  const folded = fold(name).trim();
  if (folded === "") return null;
  const hits = subAccounts.filter((s) => {
    if (s.accountId !== accountId || !s.isActive) return false;
    const subName = fold(s.name).trim();
    return subName !== "" && (folded.includes(subName) || subName.includes(folded));
  });
  return hits.length === 1 ? (hits[0]?.id ?? null) : null;
}

function decideUsage(name: string): "business" | "private" | null {
  const business = cuesIn(name, USAGE_CUES.business).length > 0;
  const personal = cuesIn(name, USAGE_CUES.private).length > 0;
  if (business === personal) return null;
  return business ? "business" : "private";
}

/**
 * 口座の名前と、その口座の行の大項目の一覧から、種類・科目・補助科目・用途の案を決める（純関数）。
 * 種類は名前の手がかりで決め、名前で決まらない（どれも当たらない）ときだけ大項目を同じ表で見る。
 * 2 つ以上の種類が当たる・どれも当たらない・電子マネーなど科目を決められない口座は `null`（種類だけ other の案にもしない）。
 * 科目は `KIND_ACCOUNT_CODES` のコードの科目が事業体にあって有効なときだけ。
 * 補助科目は、決めた科目の有効な補助科目のうち名前の包含が 1 つだけのとき。用途は名前に明確な語があるときだけ。
 * `cues` は当たった語（大項目で決まったときは `大項目: <名前>`）。何も保存しない
 */
export function inferStatementAccount(
  name: string,
  categoryMajors: readonly string[],
  accounts: readonly Pick<Account, "id" | "code" | "isActive">[],
  subAccounts: readonly SubAccount[],
): StatementAccountSuggestion | null {
  const decided = decideKind(name, categoryMajors);
  if (decided === null) return null;
  const account = accounts.find((a) => a.code === KIND_ACCOUNT_CODES[decided.kind]);
  if (account === undefined || !account.isActive) return null;
  return {
    kind: decided.kind,
    accountId: account.id,
    subAccountId: decideSubAccount(name, account.id, subAccounts),
    usage: decideUsage(name),
    cues: decided.cues,
  };
}
