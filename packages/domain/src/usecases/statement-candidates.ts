import type { Candidate, Purpose, StatementAccount, StatementStatus } from "@trebuchet/schema";
import { addDays, daysBetween } from "../dates.ts";
import type { LedgerRepository, StatementUnitOfWork } from "../ports.ts";
import { journalShape } from "../statements/journal-shape.ts";
import { MATCH_WINDOW_DAYS, matchExistingJournal } from "../statements/match-existing.ts";
import { statementStatus } from "../statements/status.ts";
import {
  findTransferPair,
  inferUnpairedTransfer,
  transferConfidence,
  transferJournal,
} from "../statements/transfer.ts";
import {
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

type StatementTx = Parameters<Parameters<StatementUnitOfWork["run"]>[0]>[0];

/** 明細と、導出した状態・有効な結びつき */
export type StatementState = {
  record: StatementRecord;
  status: StatementStatus;
  /** 失効していない結びつき */
  activeLinks: StatementLinkRecord[];
};

/** 結びつきの仕訳とその訂正の連鎖（`statementStatus` の入力。INV-44） */
function journalChain(
  ledger: LedgerRepository,
  rootId: string,
  cache: Map<string, Journal[]>,
): Journal[] {
  const cached = cache.get(rootId);
  if (cached !== undefined) return cached;
  const chain: Journal[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const journal = ledger.getJournal(id);
    if (journal === undefined) continue;
    chain.push(journal);
    for (const c of ledger.correctingJournalsOf(id)) stack.push(c.id);
  }
  cache.set(rootId, chain);
  return chain;
}

/** すべての明細の状態（R15）を導く。保存した状態は持たない */
export function loadStatementStates(tx: StatementTx): StatementState[] {
  const activeByStatement = new Map<string, StatementLinkRecord[]>();
  for (const l of tx.statements.listStatementLinks()) {
    if (l.revokedAt !== null) continue;
    const list = activeByStatement.get(l.statementId) ?? [];
    list.push(l);
    activeByStatement.set(l.statementId, list);
  }
  const cache = new Map<string, Journal[]>();
  return tx.statements.listStatements().map((record) => {
    const activeLinks = activeByStatement.get(record.id) ?? [];
    const journals = activeLinks.flatMap((l) => journalChain(tx.ledger, l.journalId, cache));
    return { record, activeLinks, status: statementStatus(record, activeLinks, journals) };
  });
}

/** 日付の範囲の有効な仕訳（取消済みを除く）。全件をページをたどって集める */
function journalsBetween(ledger: LedgerRepository, from: string, to: string): Journal[] {
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
type CandidateBody = Omit<StatementCandidateRecord, "statementId" | "createdAt">;

const noneBody = (reason: string): CandidateBody => ({
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

const PRIVATE_ACCOUNT_REASON = "私用の口座の明細です（仕訳にしません。除外してください）";
const AI_METHODS = new Set<string>(["local_ai", "external_ai"]);

export type BuildResult = { built: number; needsAi: string[] };

/**
 * 候補を作る（R8: 既存の仕訳 → 振替の対 → none。ルールの段は US3 が足す）。
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
  const ledgerAccounts = tx.masters.listAccounts();

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
    const match = matchExistingJournal(record, account, journals, claimedLines);
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
    const pool = unprocessed.filter((r) => r.amount !== 0 && !claimed.has(r.id));
    const pair = findTransferPair(record, pool);
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

    // 3. （ルール・AI は後の段）作れなければ none
    const previous = existing.get(record.id);
    if (!rebuild && previous !== undefined && AI_METHODS.has(previous.method)) continue;
    // private の口座の出金・入金も事業／私用の判定が要るので、AI に回す（US2-5）
    const guess = inferUnpairedTransfer(record);
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
