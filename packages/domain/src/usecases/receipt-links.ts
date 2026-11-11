import type { ReceiptDetail, ReceiptSummary } from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import { addDays } from "../dates.ts";
import type { ReceiptStore, TenantTx } from "../ports.ts";
import {
  type JournalCandidate,
  RECEIPT_CANDIDATE_WINDOW_DAYS,
  rankJournalCandidates,
} from "../receipts/candidates.ts";
import { RECEIPT_REASON_AUTO_VOIDED } from "../receipts/history.ts";
import { candidatesOf, compareReadingWithJournal } from "../receipts/reading.ts";
import {
  domainError,
  err,
  type Journal,
  type JournalDraft,
  journalNotFoundError,
  ok,
  type ReceiptLinkRow,
  type ReceiptRow,
  type Result,
  receiptNotFoundError,
  validation,
} from "../types.ts";
import { createJournal } from "./create-journal.ts";
import { checkReason } from "./journal-edit.ts";
import {
  type ReceiptDeps,
  receiptDetailOf,
  receiptSummaryOf,
  writeReadingComparison,
} from "./receipts.ts";

// 証憑と仕訳の結びつき（010 US3。contracts/domain-module.md §3、research R5・R6、FR-010〜013、INV-64）。
// 結びつきは仕訳（`journal_id`）単位。仕訳を訂正しても同じ `journal_id` のまま、取消しても残る（状態を導く）。
// 書き込みはすべて 1 つの `uow.run` の中（`linkInTx` は `tx` を受け、`uow.run` を入れ子にしない）

type LinkTx = TenantTx<{ receipts: ReceiptStore }>;

const CANDIDATE_PAGE = 200;

const notFound = receiptNotFoundError;
const deleted = () => domainError("RECEIPT_DELETED", "削除済みの証憑は変更できません");

/** 結びつけられる証憑（ある・削除済みでない）を読む */
function loadLinkable(tx: LinkTx, receiptId: string): Result<ReceiptRow> {
  const receipt = tx.receipts.getReceipt(receiptId);
  if (receipt === undefined) return err(notFound());
  if (receipt.deletedAt !== null) return err(deleted());
  return ok(receipt);
}

/** 有効な結びつきの仕訳が取り消されているか（取り消されていれば結び直すときに自動で閉じる） */
const isVoidedLink = (tx: LinkTx, link: ReceiptLinkRow): boolean =>
  tx.ledger.getJournal(link.journalId)?.status === "voided";

const alreadyLinked = (link: ReceiptLinkRow) =>
  domainError("RECEIPT_ALREADY_LINKED", "証憑はすでに別の仕訳に結びついています", {
    journalId: link.journalId,
  });

export type LinkInput = {
  journalId: string;
  /** 有効な仕訳に結びついている証憑を別の仕訳へ付け替える。理由が要る */
  replace?: boolean | undefined;
  reason?: string | undefined;
};

/**
 * 結びつけの規則（`linkReceipt` と `createJournalFromReceipt` が共有。`uow.run` は開かない）。
 * 証憑（削除済み → `RECEIPT_DELETED`）→ 仕訳（`JOURNAL_NOT_FOUND`・`JOURNAL_VOIDED`）→ 今の結びつき:
 * 同じ仕訳なら何もしない。`linked` で別の仕訳なら `replace` と理由がなければ `RECEIPT_ALREADY_LINKED`・
 * `REASON_REQUIRED`。`journal_voided` なら自動で閉じる。新しい結びつきと履歴を書く
 */
function linkInTx(
  tx: LinkTx,
  deps: ReceiptDeps,
  receiptId: string,
  input: LinkInput,
): Result<ReceiptRow> {
  const loaded = loadLinkable(tx, receiptId);
  if (!loaded.ok) return loaded;
  const receipt = loaded.value;

  const journal = tx.ledger.getJournal(input.journalId);
  if (journal === undefined) {
    return err(journalNotFoundError(input.journalId));
  }
  if (journal.status === "voided") {
    return err(
      domainError("JOURNAL_VOIDED", "取り消した仕訳には結びつけられません", {
        journalId: journal.id,
      }),
    );
  }

  const current = tx.receipts.getActiveLink(receipt.id);
  if (current?.journalId === journal.id) return ok(receipt);

  const now = deps.clock.now();
  let replaced: { link: ReceiptLinkRow; reason: string } | undefined;
  let autoClosed: ReceiptLinkRow | undefined;
  if (current !== undefined) {
    if (isVoidedLink(tx, current)) {
      autoClosed = current;
    } else {
      if (input.replace !== true) return err(alreadyLinked(current));
      const reason = checkReason(input.reason ?? "");
      if (!reason.ok) return reason;
      replaced = { link: current, reason: reason.value };
    }
  }

  if (autoClosed !== undefined) {
    tx.receipts.closeLink(autoClosed.id, now, RECEIPT_REASON_AUTO_VOIDED);
    tx.receipts.appendAudit(
      auditEntry(deps, {
        targetType: "receipt_link",
        targetId: autoClosed.id,
        action: "unlink",
        reason: RECEIPT_REASON_AUTO_VOIDED,
        before: { receiptId: receipt.id, journalId: autoClosed.journalId },
        after: { unlinkedAt: now },
        at: now,
      }),
    );
  }
  if (replaced !== undefined) {
    tx.receipts.closeLink(replaced.link.id, now, replaced.reason);
  }

  const link: ReceiptLinkRow = {
    id: deps.ids.next(),
    receiptId: receipt.id,
    journalId: journal.id,
    linkedAt: now,
    unlinkedAt: null,
    unlinkReason: null,
  };
  tx.receipts.insertLink(link);
  tx.receipts.appendAudit(
    auditEntry(deps, {
      targetType: "receipt_link",
      targetId: link.id,
      action: "link",
      reason: replaced?.reason ?? null,
      before:
        replaced === undefined
          ? null
          : { receiptId: receipt.id, journalId: replaced.link.journalId },
      after: { receiptId: receipt.id, journalId: journal.id },
      at: now,
    }),
  );
  return ok(receipt);
}

/** 証憑を仕訳に結びつける（FR-011・013）。付け替えは `replace: true` と理由が要る */
export function linkReceipt(
  deps: ReceiptDeps,
  receiptId: string,
  input: LinkInput,
): Result<ReceiptDetail> {
  return deps.uow.run((tx) => {
    const linked = linkInTx(tx, deps, receiptId, input);
    if (!linked.ok) return linked;
    return ok(receiptDetailOf(tx, deps, linked.value));
  });
}

/** 有効な結びつきを理由つきで閉じる（行は消さない。FR-013）。結びつきがなければ `VALIDATION` */
export function unlinkReceipt(
  deps: ReceiptDeps,
  receiptId: string,
  input: { reason: string },
): Result<ReceiptDetail> {
  return deps.uow.run((tx) => {
    const loaded = loadLinkable(tx, receiptId);
    if (!loaded.ok) return loaded;
    const reason = checkReason(input.reason);
    if (!reason.ok) return reason;
    const link = tx.receipts.getActiveLink(receiptId);
    if (link === undefined) {
      return validation("結びついた仕訳がありません", { receiptId });
    }
    const now = deps.clock.now();
    tx.receipts.closeLink(link.id, now, reason.value);
    tx.receipts.appendAudit(
      auditEntry(deps, {
        targetType: "receipt_link",
        targetId: link.id,
        action: "unlink",
        reason: reason.value,
        before: { receiptId, journalId: link.journalId },
        after: { unlinkedAt: now },
        at: now,
      }),
    );
    return ok(receiptDetailOf(tx, deps, loaded.value));
  });
}

export type CreateJournalFromReceiptInput = {
  journal: JournalDraft;
  /** 証憑の読み取りの記録（`receipt_readings`）の ID。あれば科目・税区分の比べを書く（R14） */
  readingId?: string | undefined;
};

/**
 * 証憑から仕訳を登録して結びつける（FR-010）。1 つの `uow.run` の中で、006 の `approveCandidate` と同じく
 * `tx` の帳簿で 001 の `createJournal` を呼び、同じ `tx` で `linkInTx`（`replace` なし）を呼ぶ。
 * 有効な仕訳に結びついていれば、仕訳を作る前に `RECEIPT_ALREADY_LINKED`。どこで失敗しても全部巻き戻る。
 * `readingId` があれば、その証憑の読み取りの `account_match`・`tax_match` に、登録した仕訳との比べを
 * まだ書いていない列だけ書く（値の保存の比べとは別の列。L2）。その証憑の読み取りでなければ `VALIDATION`
 */
export function createJournalFromReceipt(
  deps: ReceiptDeps,
  receiptId: string,
  input: CreateJournalFromReceiptInput,
): Result<{ journal: Journal; receipt: ReceiptDetail }> {
  return deps.uow.run((tx) => {
    const loaded = loadLinkable(tx, receiptId);
    if (!loaded.ok) return loaded;
    const current = tx.receipts.getActiveLink(receiptId);
    if (current !== undefined && !isVoidedLink(tx, current)) return err(alreadyLinked(current));
    const reading =
      input.readingId === undefined
        ? undefined
        : tx.receipts.listReadings(receiptId).find((r) => r.id === input.readingId);
    if (input.readingId !== undefined && reading === undefined) {
      return validation("読み取りの記録が見つかりません", { field: "readingId" });
    }

    const posted = createJournal(
      { ledger: tx.ledger, masters: tx.masters, ids: deps.ids, clock: deps.clock },
      input.journal,
    );
    if (!posted.ok) return posted;
    const journal = posted.value.journal;
    const linked = linkInTx(tx, deps, receiptId, { journalId: journal.id });
    if (!linked.ok) return linked;
    if (reading !== undefined) {
      const codes = new Map(tx.masters.listAccounts().map((a) => [a.id, a.code]));
      const comparison = compareReadingWithJournal(candidatesOf(reading), {
        lines: journal.lines.map((l) => ({
          accountCode: codes.get(l.accountId) ?? "",
          taxCategory: l.taxCategory,
        })),
      });
      writeReadingComparison(tx, reading, comparison, deps.clock.now());
    }
    return ok({ journal, receipt: receiptDetailOf(tx, deps, linked.value) });
  });
}

/**
 * 結びつける仕訳の候補（R6）。基準日（取引年月日、なければ受領日。`deps.dateOf`）の前後
 * `RECEIPT_CANDIDATE_WINDOW_DAYS` 日の有効な仕訳を `findJournals` で全部引き、`rankJournalCandidates` で並べる
 */
export function listJournalCandidates(
  deps: ReceiptDeps,
  receiptId: string,
): Result<JournalCandidate[]> {
  return deps.uow.run((tx) => {
    const receipt = tx.receipts.getReceipt(receiptId);
    if (receipt === undefined) return err(notFound());
    const receivedDate = deps.dateOf(receipt.receivedAt);
    const base = receipt.transactionDate ?? receivedDate;
    const dateFrom = addDays(base, -RECEIPT_CANDIDATE_WINDOW_DAYS);
    const dateTo = addDays(base, RECEIPT_CANDIDATE_WINDOW_DAYS);
    const journals: Journal[] = [];
    let cursor: string | undefined;
    do {
      const page = tx.ledger.findJournals({ dateFrom, dateTo, limit: CANDIDATE_PAGE, cursor });
      journals.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return ok(rankJournalCandidates(receipt, journals, receivedDate));
  });
}

/** 仕訳に有効に結びついている証憑（仕訳の詳細の合成用。R6）。削除済みの証憑は含まない */
export function listJournalReceipts(
  deps: ReceiptDeps,
  journalId: string,
): Result<ReceiptSummary[]> {
  return deps.uow.run((tx) => {
    if (tx.ledger.getJournal(journalId) === undefined) {
      return err(journalNotFoundError(journalId));
    }
    const summaries: ReceiptSummary[] = [];
    for (const link of tx.receipts.listActiveLinksByJournal(journalId)) {
      const receipt = tx.receipts.getReceipt(link.receiptId);
      if (receipt === undefined || receipt.deletedAt !== null) continue;
      summaries.push(receiptSummaryOf(tx, deps, receipt));
    }
    return ok(summaries);
  });
}

/** 仕訳ごとの有効な結びつきの数（仕訳の一覧の合成用。R6）。結びつきのない仕訳は載らない */
export function countReceiptsByJournal(
  deps: ReceiptDeps,
  journalIds: readonly string[],
): Result<Map<string, number>> {
  return deps.uow.run((tx) => ok(tx.receipts.countActiveLinksByJournal(journalIds)));
}
