import type { Candidate, Purpose, StatementAccount, StatementStatus } from "@trebuchet/schema";
import { addDays, daysBetween } from "../dates.ts";
import type { JournalChainRef, LedgerRepository, StatementUnitOfWork } from "../ports.ts";
import { journalShape, STATEMENT_ACCOUNT_CODES } from "../statements/journal-shape.ts";
import { createExistingJournalMatcher, MATCH_WINDOW_DAYS } from "../statements/match-existing.ts";
import { ruleConfidence, ruleFor } from "../statements/rules.ts";
import { statementStatus } from "../statements/status.ts";
import {
  createTransferPairFinder,
  inferUnpairedTransfer,
  transferConfidence,
  transferJournal,
} from "../statements/transfer.ts";
import {
  type Account,
  type InferenceRule,
  type Journal,
  type JournalDraft,
  ok,
  type Result,
  type StatementCandidateRecord,
  type StatementLinkRecord,
  type StatementRecord,
} from "../types.ts";

// 候補の作成の中身（006 R5〜R8）。`usecases/statements.ts` の `buildCandidates`・`saveStatementAccount`・
// `listStatements` が使う。UnitOfWork の中（`tx`）で呼ぶ。入れ子の UnitOfWork を作らない

export type StatementTx = Parameters<Parameters<StatementUnitOfWork["run"]>[0]>[0];

/** 明細と、導出した状態・有効な結びつき */
export type StatementState = {
  record: StatementRecord;
  status: StatementStatus;
  /** 失効していない結びつき */
  activeLinks: StatementLinkRecord[];
};

/**
 * 結びつきの仕訳とその訂正の連鎖（`statementStatus` の入力。INV-44）を引く関数。連鎖は `rootIds` の分を
 * `correctionChains` で 1 回に読み、仕訳ごとの連鎖（その仕訳から訂正をたどった先）はメモリでたどる
 */
function journalChains(
  ledger: LedgerRepository,
  rootIds: readonly string[],
): (rootId: string) => JournalChainRef[] {
  const refs = ledger.correctionChains(rootIds);
  const byId = new Map(refs.map((r) => [r.id, r]));
  const correctedBy = new Map<string, string[]>();
  for (const r of refs) {
    if (r.correctsJournalId === null) continue;
    const list = correctedBy.get(r.correctsJournalId) ?? [];
    list.push(r.id);
    correctedBy.set(r.correctsJournalId, list);
  }
  const cache = new Map<string, JournalChainRef[]>();
  return (rootId) => {
    const cached = cache.get(rootId);
    if (cached !== undefined) return cached;
    const chain: JournalChainRef[] = [];
    const seen = new Set<string>();
    const stack = [rootId];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const journal = byId.get(id);
      if (journal === undefined) continue;
      chain.push(journal);
      stack.push(...(correctedBy.get(id) ?? []));
    }
    cache.set(rootId, chain);
    return chain;
  };
}

/**
 * 明細の状態（R15）を導く。保存した状態は持たない。`ids` を渡すとその明細だけ（並びは取り込んだ順のまま。
 * 知らない ID は無視する）。仕訳の連鎖は対象の明細の有効な結びつきの分だけを一括で読む
 */
export function loadStatementStates(
  tx: StatementTx,
  ids?: ReadonlySet<string> | undefined,
): StatementState[] {
  const records = tx.statements
    .listStatements()
    .filter((record) => ids === undefined || ids.has(record.id));
  const activeByStatement = new Map<string, StatementLinkRecord[]>();
  for (const l of tx.statements.listStatementLinks()) {
    if (l.revokedAt !== null || (ids !== undefined && !ids.has(l.statementId))) continue;
    const list = activeByStatement.get(l.statementId) ?? [];
    list.push(l);
    activeByStatement.set(l.statementId, list);
  }
  const rootIds = new Set<string>();
  for (const links of activeByStatement.values()) for (const l of links) rootIds.add(l.journalId);
  const chainOf = journalChains(tx.ledger, [...rootIds]);
  return records.map((record) => {
    const activeLinks = activeByStatement.get(record.id) ?? [];
    const journals = activeLinks.flatMap((l) => chainOf(l.journalId));
    return { record, activeLinks, status: statementStatus(record, activeLinks, journals) };
  });
}

/** 日付の範囲の有効な仕訳（取消済みを除く）。全件をページをたどって集める */
export function journalsBetween(ledger: LedgerRepository, from: string, to: string): Journal[] {
  const items: Journal[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = ledger.findJournals({ dateFrom: from, dateTo: to, limit: 500, cursor });
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
}

/** 候補の中身（明細の ID と作成の日時は書くときに付ける） */
export type CandidateBody = Omit<StatementCandidateRecord, "statementId" | "createdAt">;

export const noneBody = (reason: string): CandidateBody => ({
  method: "none",
  purpose: null,
  confidence: null,
  reason,
  draftJson: null,
  ruleId: null,
  model: null,
});

const transferBody = (
  draft: JournalDraft,
  purpose: Purpose,
  confidence: number,
  reason: string,
): CandidateBody => ({
  method: "transfer",
  purpose,
  confidence,
  reason,
  draftJson: JSON.stringify(draft),
  ruleId: null,
  model: null,
});

export const PRIVATE_ACCOUNT_REASON = "私用の口座の明細です（仕訳にしません。除外してください）";
const AI_METHODS = new Set<string>(["local_ai", "external_ai"]);

export type BuildResult = { built: number; needsAi: string[] };

/**
 * 候補を作る（R8: 既存の仕訳 → 振替の対 → ルール → none。AI は後の段）。
 * `targetIds` のうち、未処理で 0 円でない明細の候補を作り直す。0 円の明細は候補を作らず、あれば消す。
 * AI の候補（`local_ai`・`external_ai`）は、前の段で作れなかったとき `rebuild` でなければ残す（AI の呼び出しは遅い）。
 * `built` は書いた候補の数（none を含む）。`needsAi` は none で、AI に回す明細（`private` の口座も含む）
 */
export function buildCandidatesInTx(
  deps: { clock: { now(): string } },
  tx: StatementTx,
  states: readonly StatementState[],
  targetIds: ReadonlySet<string>,
  rebuild: boolean,
): Result<BuildResult> {
  const accounts = new Map(tx.statements.listStatementAccounts().map((a) => [a.id, a]));
  const existing = new Map(tx.statements.listStatementCandidates().map((c) => [c.statementId, c]));
  const unprocessed = states.filter((s) => s.status === "unprocessed").map((s) => s.record);
  const targets = unprocessed.filter((r) => targetIds.has(r.id));
  const now = deps.clock.now();

  // 既存の仕訳との照合に使う仕訳（対象の日付の前後 7 日）
  const dates = targets
    .filter((r) => r.amount !== 0)
    .map((r) => r.date)
    .sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const journals =
    first === undefined || last === undefined
      ? []
      : journalsBetween(
          tx.ledger,
          addDays(first, -MATCH_WINDOW_DAYS),
          addDays(last, MATCH_WINDOW_DAYS),
        );
  const journalNoOf = new Map(journals.map((j) => [j.id, j.journalNo]));
  const claimedLines = new Set(states.flatMap((s) => s.activeLinks.map((l) => l.journalLineId)));
  const claimed = new Set<string>();
  // 明細ごとに全件を走査しない: 仕訳は行の内容で、振替の対の候補は金額で索引にし、対にした明細は `claimed` で後から除く
  const matchJournal = createExistingJournalMatcher(journals);
  const findPair = createTransferPairFinder(unprocessed);
  const ledgerAccounts = tx.masters.listAccounts();
  const rules = tx.statements.listInferenceRules();

  let built = 0;
  const needsAi: string[] = [];
  const write = (statementId: string, body: CandidateBody) => {
    tx.statements.upsertStatementCandidate({ ...body, statementId, createdAt: now });
    built += 1;
  };

  for (const record of targets) {
    if (claimed.has(record.id)) continue; // 対の相手として書いた
    if (record.amount === 0) {
      if (existing.has(record.id)) tx.statements.deleteStatementCandidate(record.id);
      continue;
    }
    const account = accounts.get(record.statementAccountId) as StatementAccount;

    // 1. 既存の仕訳
    const match = matchJournal(record, account, claimedLines);
    if (match !== undefined) {
      claimedLines.add(match.lineId);
      write(record.id, {
        method: "match",
        purpose: "business",
        confidence: match.confidence,
        reason: `既存の仕訳 No.${journalNoOf.get(match.journalId)}（日付の差 ${match.daysDiff} 日）と一致`,
        draftJson: JSON.stringify({ journalId: match.journalId, lineId: match.lineId }),
        ruleId: null,
        model: null,
      });
      continue;
    }

    // 2. 振替の対
    const pair = findPair(record, claimed);
    if (pair !== undefined) {
      const pairAccount = accounts.get(pair.statementAccountId) as StatementAccount;
      const [mine, theirs] = pairBodies(record, account, pair, pairAccount, ledgerAccounts);
      claimed.add(record.id);
      write(record.id, mine);
      if (targetIds.has(pair.id)) {
        claimed.add(pair.id);
        write(pair.id, theirs);
      }
      continue;
    }

    // 3. ルール（対のない引落は、ルールでカードが決まれば transfer。R9）
    const guess = inferUnpairedTransfer(record);
    const rule = ruleFor(record, rules);
    if (rule !== undefined) {
      const body = ruleCandidateBody(
        record,
        account,
        rule,
        ledgerAccounts,
        guess.kind === "card_payment",
      );
      if (body !== undefined) {
        write(record.id, body);
        continue;
      }
    }

    // 4. （AI は後の段）作れなければ none
    const previous = existing.get(record.id);
    if (!rebuild && previous !== undefined && AI_METHODS.has(previous.method)) continue;
    // private の口座の出金・入金も事業／私用の判定が要るので、AI に回す（US2-5）
    write(
      record.id,
      noneBody(
        guess.kind === "card_payment"
          ? "カードの引落らしいが、どのカードか決められません"
          : "既存の仕訳・振替の対に一致しません",
      ),
    );
    needsAi.push(record.id);
  }
  return ok({ built, needsAi });
}

/**
 * ルールから候補の中身を作る（R9）。相手の科目がない・使用停止、または仕訳の案を作れなければ undefined
 * （次の段へ進む）。私用の口座で私用の判定のルールは、仕訳にならない `none`（AI に回さない）。
 * `cardPayment`（対のない引落がカードの支払いらしい）で、ルールの相手が未払金なら、方法は `transfer`
 * （借 未払金（カードの補助科目）/ 貸 明細の口座。税区分は対象外）
 */
function ruleCandidateBody(
  record: StatementRecord,
  account: StatementAccount,
  rule: InferenceRule,
  ledgerAccounts: readonly Account[],
  cardPayment: boolean,
): CandidateBody | undefined {
  const counter = ledgerAccounts.find((a) => a.id === rule.counterAccountId);
  if (counter === undefined || !counter.isActive) return undefined;
  const confidence = ruleConfidence(rule);
  const evidence =
    rule.origin === "seed"
      ? `過去の同じ内容の仕訳 ${rule.hits} 件と一致`
      : `過去の同じ内容の明細 ${rule.hits} 件と一致`;
  const reason = rule.overrides > 0 ? `${evidence}（修正 ${rule.overrides} 回）` : evidence;

  if (cardPayment && counter.code === STATEMENT_ACCOUNT_CODES.accountsPayable) {
    const shaped = journalShape({
      statement: record,
      account,
      purpose: "business",
      counter: {
        accountId: counter.id,
        subAccountId: rule.counterSubAccountId,
        taxCategory: "OUT_OF_SCOPE",
      },
      accounts: ledgerAccounts,
    });
    if (!shaped.ok || shaped.value === null) return undefined;
    return transferBody(shaped.value.draft, "business", confidence, `カードの引落（${reason}）`);
  }

  const shaped = journalShape({
    statement: record,
    account,
    purpose: rule.purpose,
    counter: {
      accountId: counter.id,
      subAccountId: rule.counterSubAccountId,
      taxCategory: rule.taxCategory,
      partnerId: rule.partnerId,
      description: rule.descriptionTemplate,
    },
    accounts: ledgerAccounts,
  });
  if (!shaped.ok) return undefined;
  if (shaped.value === null) return noneBody(PRIVATE_ACCOUNT_REASON);
  return {
    method: "rule",
    purpose: rule.purpose,
    confidence,
    reason,
    draftJson: JSON.stringify(shaped.value.draft),
    ruleId: rule.id,
    model: null,
  };
}

/**
 * ルールが変わった（作成・更新・停止・再開・初期作成・承認からの学習）とき、その内容の
 * 未処理の明細で、候補が `rule`・`none` のものだけを作り直す（R8）。AI・既存の仕訳・振替の候補は残す。
 * UnitOfWork の中で呼ぶ
 */
export function rebuildRuleCandidates(
  deps: { clock: { now(): string } },
  tx: StatementTx,
  contents: ReadonlySet<string>,
): void {
  if (contents.size === 0) return;
  const states = loadStatementStates(tx);
  const methodOf = new Map(
    tx.statements.listStatementCandidates().map((c) => [c.statementId, c.method]),
  );
  const targetIds = new Set(
    states
      .filter((s) => {
        const method = methodOf.get(s.record.id);
        return (
          s.status === "unprocessed" &&
          contents.has(s.record.normalizedContent) &&
          (method === "rule" || method === "none")
        );
      })
      .map((s) => s.record.id),
  );
  if (targetIds.size > 0) buildCandidatesInTx(deps, tx, states, targetIds, true);
}

/** 振替の対の 2 件分の候補の中身（`[record の側, pair の側]`） */
function pairBodies(
  record: StatementRecord,
  account: StatementAccount,
  pair: StatementRecord,
  pairAccount: StatementAccount,
  ledgerAccounts: readonly { id: string; code: string }[],
): [CandidateBody, CandidateBody] {
  const confidence = transferConfidence(Math.abs(daysBetween(record.date, pair.date)));
  if (account.usage === "private" && pairAccount.usage === "private") {
    const body = noneBody("私用の口座どうしの振替です（仕訳にしません。除外してください）");
    return [body, body];
  }
  if (account.usage === "private" || pairAccount.usage === "private") {
    // 事業の側は R5 の表（事業主貸・事業主借）、private の側は仕訳なし
    const recordIsBusiness = account.usage !== "private";
    const [biz, bizAccount] = recordIsBusiness ? [record, account] : [pair, pairAccount];
    const shaped = journalShape({
      statement: biz,
      account: bizAccount,
      purpose: "private",
      accounts: ledgerAccounts,
    });
    const bizBody =
      shaped.ok && shaped.value !== null
        ? transferBody(
            shaped.value.draft,
            "private",
            confidence,
            "私用の口座との振替（事業主貸・事業主借）",
          )
        : noneBody(shaped.ok ? "仕訳の案を作れません" : shaped.error.message);
    const privateBody = noneBody(PRIVATE_ACCOUNT_REASON);
    return recordIsBusiness ? [bizBody, privateBody] : [privateBody, bizBody];
  }
  const draft = transferJournal(
    { statement: record, account },
    { statement: pair, account: pairAccount },
  );
  const body = draft.ok
    ? transferBody(
        draft.value,
        "business",
        confidence,
        `振替の対（${pairAccount.name} ${pair.date}）`,
      )
    : noneBody(draft.error.message);
  return [body, body];
}

/** 候補の記録を、画面・API の形にする */
export function toCandidateView(c: StatementCandidateRecord): Candidate {
  const parsed = c.draftJson === null ? null : (JSON.parse(c.draftJson) as unknown);
  const matchRef =
    c.method === "match" ? (parsed as { journalId: string; lineId: string } | null) : null;
  return {
    method: c.method,
    purpose: c.purpose,
    confidence: c.confidence,
    reason: c.reason,
    draft: c.method === "match" ? null : (parsed as Candidate["draft"]),
    ...(matchRef === null
      ? {}
      : { match: { journalId: matchRef.journalId, lineId: matchRef.lineId } }),
    ...(c.model === null ? {} : { model: c.model }),
  };
}
