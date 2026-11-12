import { ReceiptDetail } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { RECEIPT_REASON_AUTO_VOIDED } from "../../src/receipts/history.ts";
import type { JournalDraft } from "../../src/types.ts";
import { correctJournal } from "../../src/usecases/correct-journal.ts";
import { createJournal } from "../../src/usecases/create-journal.ts";
import {
  countReceiptsByJournal,
  createJournalFromReceipt,
  linkReceipt,
  listJournalCandidates,
  listJournalReceipts,
  unlinkReceipt,
} from "../../src/usecases/receipt-links.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { FaultInjectingReceiptUnitOfWork, receiptSnapshotOf } from "../receipt-fault-injection.ts";
import { seedReceipt, setupReceiptsWithLedger } from "../receipt-setup.ts";
import { codeOf, must } from "../result.ts";

// T020: 結びつけ・解除・証憑から仕訳の登録・候補・仕訳側の合成（contracts/domain-module.md §3、R5・R6、FR-010〜013）

type Ctx = ReturnType<typeof setupReceiptsWithLedger>;

function draftOf(ctx: Ctx, date: string, amount: number): JournalDraft {
  return {
    date,
    memo: "合成の仕訳",
    lines: [
      { side: "debit", accountId: ctx.accountId("消耗品費"), amount },
      { side: "credit", accountId: ctx.accountId("普通預金"), amount },
    ],
  };
}

/** 帳簿に仕訳を 1 件登録する（001 の createJournal） */
function post(ctx: Ctx, date = "2026-10-20", amount = 1100) {
  return must(
    createJournal(
      { ledger: ctx.ledger, masters: ctx.masters, ids: ctx.ids, clock: ctx.clock },
      draftOf(ctx, date, amount),
    ),
  ).journal;
}

const ledgerDeps = (ctx: Ctx) => ({
  ledger: ctx.ledger,
  masters: ctx.masters,
  ids: ctx.ids,
  clock: ctx.clock,
});

function voidIt(ctx: Ctx, journalId: string) {
  const j = ctx.ledger.getJournal(journalId);
  if (j === undefined) throw new Error("仕訳がない");
  must(voidJournal(ledgerDeps(ctx), journalId, { reason: "取消", version: j.version }));
}

const links = (ctx: Ctx) => ctx.uow.receipts.state.links;
const activeLinks = (ctx: Ctx, receiptId: string) =>
  links(ctx).filter((l) => l.receiptId === receiptId && l.unlinkedAt === null);
const auditsOf = (ctx: Ctx, receiptId: string) => ctx.uow.receipts.listAudit(receiptId);

function setup() {
  const ctx = setupReceiptsWithLedger();
  // 詳細を ReceiptDetail（Zod）で検査するので、ID は UUID の形にする
  const receipt = seedReceipt(ctx.uow, {
    id: "00000000-0000-7000-8001-000000000001",
    amount: 1100,
    transactionDate: "2026-10-20",
  });
  return { ctx, receipt };
}

describe("linkReceipt: 結びつけ", () => {
  it("仕訳に結びつけると linked になり、結びつきの行と link の履歴ができる", () => {
    const { ctx, receipt } = setup();
    const journal = post(ctx);
    ctx.clock.value = "2026-11-01T00:00:00.000Z";
    const detail = must(linkReceipt(ctx.deps, receipt.id, { journalId: journal.id }));

    expect(ReceiptDetail.safeParse(detail).success).toBe(true);
    expect(detail.linkState).toBe("linked");
    expect(detail.journal).toMatchObject({ id: journal.id, journalNo: journal.journalNo });
    expect(activeLinks(ctx, receipt.id)).toEqual([
      expect.objectContaining({
        journalId: journal.id,
        linkedAt: "2026-11-01T00:00:00.000Z",
        unlinkedAt: null,
      }),
    ]);
    const audit = auditsOf(ctx, receipt.id).at(-1);
    expect(audit).toMatchObject({
      targetType: "receipt_link",
      action: "link",
      reason: null,
      beforeJson: null,
      occurredAt: "2026-11-01T00:00:00.000Z",
    });
    expect(JSON.parse(audit?.afterJson ?? "null")).toEqual({
      receiptId: receipt.id,
      journalId: journal.id,
    });
  });

  it("同じ仕訳にもう一度結びつけても何も変わらない（行も履歴も増えない）", () => {
    const { ctx, receipt } = setup();
    const journal = post(ctx);
    must(linkReceipt(ctx.deps, receipt.id, { journalId: journal.id }));
    const before = receiptSnapshotOf(ctx.uow);
    const again = must(linkReceipt(ctx.deps, receipt.id, { journalId: journal.id }));
    expect(again.linkState).toBe("linked");
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
  });

  it("1 件の仕訳に複数の証憑を結びつけられる", () => {
    const { ctx, receipt } = setup();
    const second = seedReceipt(ctx.uow, { id: "r-2" });
    const journal = post(ctx);
    must(linkReceipt(ctx.deps, receipt.id, { journalId: journal.id }));
    must(linkReceipt(ctx.deps, second.id, { journalId: journal.id }));
    expect(ctx.uow.receipts.listActiveLinksByJournal(journal.id)).toHaveLength(2);
  });

  it("締め済みの年度の仕訳にも結びつけられる（結びつきは仕訳を変えない）", () => {
    const { ctx, receipt } = setup();
    const journal = post(ctx, "2025-06-01");
    ctx.closeYear(2025);
    const detail = must(linkReceipt(ctx.deps, receipt.id, { journalId: journal.id }));
    expect(detail.linkState).toBe("linked");
  });

  it("source を問わない（請求書の仕訳にも結びつけられる）", () => {
    const { ctx, receipt } = setup();
    const journal = post(ctx);
    ctx.ledger.state.journals = ctx.ledger.state.journals.map((j) =>
      j.id === journal.id ? { ...j, source: "invoice" as const } : j,
    );
    expect(linkReceipt(ctx.deps, receipt.id, { journalId: journal.id }).ok).toBe(true);
  });

  it.each([
    ["証憑がない", "none", "RECEIPT_NOT_FOUND"],
    ["削除済みの証憑", "deleted", "RECEIPT_DELETED"],
    ["仕訳がない", "nojournal", "JOURNAL_NOT_FOUND"],
    ["取消済みの仕訳", "voided", "JOURNAL_VOIDED"],
  ])("%s は %s で失敗し、何も書かない", (_label, kind, code) => {
    const { ctx, receipt } = setup();
    const journal = post(ctx);
    const deleted = seedReceipt(ctx.uow, { id: "r-del", deletedAt: "2026-10-30T00:00:00.000Z" });
    if (kind === "voided") voidIt(ctx, journal.id);
    const before = receiptSnapshotOf(ctx.uow);
    const target = kind === "none" ? "r-none" : kind === "deleted" ? deleted.id : receipt.id;
    const journalId = kind === "nojournal" ? "j-none" : journal.id;
    const result = linkReceipt(ctx.deps, target, { journalId });
    expect(codeOf(result)).toBe(code);
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
  });
});

describe("linkReceipt: 付け替え（R5）", () => {
  function linked() {
    const { ctx, receipt } = setup();
    const a = post(ctx, "2026-10-20");
    const b = post(ctx, "2026-10-21");
    must(linkReceipt(ctx.deps, receipt.id, { journalId: a.id }));
    return { ctx, receipt, a, b };
  }

  it("linked の証憑を別の仕訳へ replace なしで結ぶと RECEIPT_ALREADY_LINKED（details.journalId は今の仕訳）", () => {
    const { ctx, receipt, a, b } = linked();
    const before = receiptSnapshotOf(ctx.uow);
    const result = linkReceipt(ctx.deps, receipt.id, { journalId: b.id });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_ALREADY_LINKED", details: { journalId: a.id } },
    });
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
  });

  it("replace: true でも理由がなければ（空白だけも）REASON_REQUIRED", () => {
    const { ctx, receipt, b } = linked();
    const before = receiptSnapshotOf(ctx.uow);
    for (const reason of [undefined, "", "   "]) {
      const result = linkReceipt(ctx.deps, receipt.id, {
        journalId: b.id,
        replace: true,
        ...(reason === undefined ? {} : { reason }),
      });
      expect(codeOf(result)).toBe("REASON_REQUIRED");
    }
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
  });

  it("replace: true と理由があれば付け替える。古い結びつきは理由つきで閉じ、履歴の before に前の結びつきが入る", () => {
    const { ctx, receipt, a, b } = linked();
    ctx.clock.value = "2026-11-02T00:00:00.000Z";
    const detail = must(
      linkReceipt(ctx.deps, receipt.id, { journalId: b.id, replace: true, reason: "  誤り  " }),
    );
    expect(detail.journal?.id).toBe(b.id);
    const old = links(ctx).find((l) => l.journalId === a.id);
    expect(old).toMatchObject({
      unlinkedAt: "2026-11-02T00:00:00.000Z",
      unlinkReason: "誤り",
    });
    expect(activeLinks(ctx, receipt.id).map((l) => l.journalId)).toEqual([b.id]);
    const audit = auditsOf(ctx, receipt.id).at(-1);
    expect(audit).toMatchObject({ targetType: "receipt_link", action: "link", reason: "誤り" });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({
      receiptId: receipt.id,
      journalId: a.id,
    });
    expect(JSON.parse(audit?.afterJson ?? "null")).toEqual({
      receiptId: receipt.id,
      journalId: b.id,
    });
  });

  it("仕訳が取り消された結びつき（journal_voided）は、replace も理由もなしで自動で閉じて結び直せる", () => {
    const { ctx, receipt, a, b } = linked();
    voidIt(ctx, a.id);
    expect(must(listJournalReceipts(ctx.deps, a.id)).map((r) => r.linkState)).toEqual([
      "journal_voided",
    ]);
    ctx.clock.value = "2026-11-03T00:00:00.000Z";
    const detail = must(linkReceipt(ctx.deps, receipt.id, { journalId: b.id }));
    expect(detail.linkState).toBe("linked");
    const old = links(ctx).find((l) => l.journalId === a.id);
    expect(old).toMatchObject({
      unlinkedAt: "2026-11-03T00:00:00.000Z",
      unlinkReason: RECEIPT_REASON_AUTO_VOIDED,
    });
    expect(activeLinks(ctx, receipt.id).map((l) => l.journalId)).toEqual([b.id]);
    // 自動の閉じは unlink の履歴（理由は定数）として残る
    const actions = auditsOf(ctx, receipt.id).map((e) => [e.targetType, e.action, e.reason]);
    expect(actions.slice(-2)).toEqual([
      ["receipt_link", "unlink", RECEIPT_REASON_AUTO_VOIDED],
      ["receipt_link", "link", null],
    ]);
  });

  it("取り消された仕訳へ付け替えようとすると JOURNAL_VOIDED（今の結びつきは動かさない）", () => {
    const { ctx, receipt, a, b } = linked();
    voidIt(ctx, b.id);
    const before = receiptSnapshotOf(ctx.uow);
    expect(
      codeOf(linkReceipt(ctx.deps, receipt.id, { journalId: b.id, replace: true, reason: "x" })),
    ).toBe("JOURNAL_VOIDED");
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
    expect(activeLinks(ctx, receipt.id).map((l) => l.journalId)).toEqual([a.id]);
  });
});

describe("仕訳の訂正・取消との関係（INV-64）", () => {
  it("仕訳の訂正の後も同じ journal_id で linked のまま。取消の後は結びつきが残り journal_voided", () => {
    const { ctx, receipt } = setup();
    const journal = post(ctx);
    must(linkReceipt(ctx.deps, receipt.id, { journalId: journal.id }));

    must(
      correctJournal(ledgerDeps(ctx), journal.id, {
        ...draftOf(ctx, "2026-10-22", 2200),
        reason: "訂正",
        version: journal.version,
      }),
    );
    expect(activeLinks(ctx, receipt.id).map((l) => l.journalId)).toEqual([journal.id]);
    expect(must(listJournalReceipts(ctx.deps, journal.id)).map((r) => r.linkState)).toEqual([
      "linked",
    ]);

    voidIt(ctx, journal.id);
    expect(activeLinks(ctx, receipt.id)).toHaveLength(1);
    expect(must(listJournalReceipts(ctx.deps, journal.id)).map((r) => r.linkState)).toEqual([
      "journal_voided",
    ]);
  });

  it("結びつけ・付け替え・解除は仕訳帳（帳簿）を変えない", () => {
    const { ctx, receipt } = setup();
    const a = post(ctx, "2026-10-20");
    const b = post(ctx, "2026-10-21");
    const ledgerBefore = structuredClone(ctx.ledger.state);
    must(linkReceipt(ctx.deps, receipt.id, { journalId: a.id }));
    must(linkReceipt(ctx.deps, receipt.id, { journalId: b.id, replace: true, reason: "付替" }));
    must(unlinkReceipt(ctx.deps, receipt.id, { reason: "解除" }));
    expect(ctx.ledger.state).toEqual(ledgerBefore);
  });
});

describe("unlinkReceipt", () => {
  it("有効な結びつきを理由つきで閉じ、unlink の履歴を残す。結びつきの行は消さない", () => {
    const { ctx, receipt } = setup();
    const journal = post(ctx);
    must(linkReceipt(ctx.deps, receipt.id, { journalId: journal.id }));
    ctx.clock.value = "2026-11-04T00:00:00.000Z";
    const detail = must(unlinkReceipt(ctx.deps, receipt.id, { reason: " 紐づけ誤り " }));
    expect(detail.linkState).toBe("none");
    expect(detail.journal).toBeNull();
    expect(links(ctx)).toHaveLength(1);
    expect(links(ctx)[0]).toMatchObject({
      unlinkedAt: "2026-11-04T00:00:00.000Z",
      unlinkReason: "紐づけ誤り",
    });
    const audit = auditsOf(ctx, receipt.id).at(-1);
    expect(audit).toMatchObject({
      targetType: "receipt_link",
      action: "unlink",
      reason: "紐づけ誤り",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toEqual({
      receiptId: receipt.id,
      journalId: journal.id,
    });
    expect(JSON.parse(audit?.afterJson ?? "null")).toEqual({
      unlinkedAt: "2026-11-04T00:00:00.000Z",
    });
  });

  it("解除した後は結び直せる。取り消された仕訳の結びつきも解除できる", () => {
    const { ctx, receipt } = setup();
    const a = post(ctx);
    must(linkReceipt(ctx.deps, receipt.id, { journalId: a.id }));
    voidIt(ctx, a.id);
    must(unlinkReceipt(ctx.deps, receipt.id, { reason: "取消済み" }));
    const b = post(ctx, "2026-10-21");
    expect(must(linkReceipt(ctx.deps, receipt.id, { journalId: b.id })).linkState).toBe("linked");
  });

  it("理由がなければ REASON_REQUIRED、結びつきがなければ VALIDATION、削除済みは RECEIPT_DELETED、証憑がなければ RECEIPT_NOT_FOUND", () => {
    const { ctx, receipt } = setup();
    const deleted = seedReceipt(ctx.uow, { id: "r-del", deletedAt: "2026-10-30T00:00:00.000Z" });
    const journal = post(ctx);
    must(linkReceipt(ctx.deps, receipt.id, { journalId: journal.id }));
    const before = receiptSnapshotOf(ctx.uow);
    expect(codeOf(unlinkReceipt(ctx.deps, receipt.id, { reason: "  " }))).toBe("REASON_REQUIRED");
    expect(codeOf(unlinkReceipt(ctx.deps, "r-none", { reason: "x" }))).toBe("RECEIPT_NOT_FOUND");
    expect(codeOf(unlinkReceipt(ctx.deps, deleted.id, { reason: "x" }))).toBe("RECEIPT_DELETED");
    const free = seedReceipt(ctx.uow, { id: "r-free" });
    expect(codeOf(unlinkReceipt(ctx.deps, free.id, { reason: "x" }))).toBe("VALIDATION");
    expect(links(ctx)).toHaveLength(before.receipts.links.length);
  });
});

describe("createJournalFromReceipt: 証憑から仕訳を登録", () => {
  it("1 つの UnitOfWork で仕訳を登録して結びつけ、{ journal, receipt } を返す", () => {
    const { ctx, receipt } = setup();
    const result = must(
      createJournalFromReceipt(ctx.deps, receipt.id, { journal: draftOf(ctx, "2026-10-20", 1100) }),
    );
    expect(ctx.ledger.state.journals).toHaveLength(1);
    expect(result.journal).toMatchObject({
      id: ctx.ledger.state.journals[0]?.id,
      status: "active",
      date: "2026-10-20",
    });
    expect(result.receipt.linkState).toBe("linked");
    expect(result.receipt.journal?.id).toBe(result.journal.id);
    expect(activeLinks(ctx, receipt.id).map((l) => l.journalId)).toEqual([result.journal.id]);
    expect(auditsOf(ctx, receipt.id).at(-1)).toMatchObject({
      targetType: "receipt_link",
      action: "link",
    });
  });

  it("仕訳の検査（001 の createJournal）に落ちたら、仕訳も結びつきも履歴も残らない", () => {
    const { ctx, receipt } = setup();
    const before = receiptSnapshotOf(ctx.uow);
    const draft = draftOf(ctx, "2026-10-20", 1100);
    const bad: JournalDraft = {
      ...draft,
      lines: [draft.lines[0] as JournalDraft["lines"][number]],
    };
    const result = createJournalFromReceipt(ctx.deps, receipt.id, { journal: bad });
    expect(result.ok).toBe(false);
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
  });

  it("有効な仕訳に結びついている証憑は RECEIPT_ALREADY_LINKED（仕訳を作らない）", () => {
    const { ctx, receipt } = setup();
    const a = post(ctx);
    must(linkReceipt(ctx.deps, receipt.id, { journalId: a.id }));
    const before = receiptSnapshotOf(ctx.uow);
    const result = createJournalFromReceipt(ctx.deps, receipt.id, {
      journal: draftOf(ctx, "2026-10-21", 500),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_ALREADY_LINKED", details: { journalId: a.id } },
    });
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
  });

  it("結びついた仕訳が取り消されていれば、自動で閉じて新しい仕訳に結ぶ", () => {
    const { ctx, receipt } = setup();
    const a = post(ctx);
    must(linkReceipt(ctx.deps, receipt.id, { journalId: a.id }));
    voidIt(ctx, a.id);
    const result = must(
      createJournalFromReceipt(ctx.deps, receipt.id, { journal: draftOf(ctx, "2026-10-21", 500) }),
    );
    expect(result.receipt.linkState).toBe("linked");
    expect(links(ctx).find((l) => l.journalId === a.id)?.unlinkReason).toBe(
      RECEIPT_REASON_AUTO_VOIDED,
    );
  });

  it("削除済みの証憑・ない証憑は RECEIPT_DELETED・RECEIPT_NOT_FOUND（仕訳を作らない）", () => {
    const { ctx } = setup();
    const deleted = seedReceipt(ctx.uow, { id: "r-del", deletedAt: "2026-10-30T00:00:00.000Z" });
    const before = receiptSnapshotOf(ctx.uow);
    const draft = draftOf(ctx, "2026-10-20", 1100);
    expect(codeOf(createJournalFromReceipt(ctx.deps, deleted.id, { journal: draft }))).toBe(
      "RECEIPT_DELETED",
    );
    expect(codeOf(createJournalFromReceipt(ctx.deps, "r-none", { journal: draft }))).toBe(
      "RECEIPT_NOT_FOUND",
    );
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
  });

  it("途中のどの書き込みで失敗しても、仕訳・結びつき・履歴は全部戻る（INV-64）", () => {
    let threw = 0;
    for (let failAt = 1; failAt <= 12; failAt++) {
      const { ctx, receipt } = setup();
      const fault = new FaultInjectingReceiptUnitOfWork(ctx.uow);
      fault.failAt = failAt;
      const before = receiptSnapshotOf(ctx.uow);
      try {
        const r = createJournalFromReceipt({ ...ctx.deps, uow: fault }, receipt.id, {
          journal: draftOf(ctx, "2026-10-20", 1100),
        });
        expect(r.ok).toBe(true); // 書き込みの回数より後ろなら成功する
        expect(ctx.ledger.state.journals).toHaveLength(1);
      } catch {
        threw += 1;
        expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
      }
    }
    // 仕訳（行・履歴を含む）・結びつき・履歴の最低 4 回の書き込みで失敗を確かめた
    expect(threw).toBeGreaterThanOrEqual(4);
  });
});

describe("listJournalCandidates", () => {
  it("取引年月日の前後 14 日の有効な仕訳を、金額の一致 → 日付の差の順に返す", () => {
    const { ctx, receipt } = setup(); // 2026-10-20、1,100 円
    const near = post(ctx, "2026-10-21", 1100);
    const exactFar = post(ctx, "2026-11-02", 1100);
    const diffNear = post(ctx, "2026-10-20", 900);
    post(ctx, "2026-11-10", 1100); // 範囲の外（+21）
    post(ctx, "2026-10-01", 1100); // 範囲の外（-19）
    const voided = post(ctx, "2026-10-20", 1100);
    voidIt(ctx, voided.id);

    const candidates = must(listJournalCandidates(ctx.deps, receipt.id));
    expect(candidates.map((c) => c.journal.id)).toEqual([near.id, exactFar.id, diffNear.id]);
    expect(candidates[0]).toMatchObject({ total: 1100, daysDiff: 1, amountMatches: true });
  });

  it("取引年月日がなければ受領日（Asia/Tokyo の日付）が基準日", () => {
    const { ctx } = setup();
    // 受領日時 2026-10-31T09:00Z = 2026-10-31 18:00 JST
    const r = seedReceipt(ctx.uow, { id: "r-nodate", transactionDate: null, amount: null });
    const inRange = post(ctx, "2026-10-25", 700);
    post(ctx, "2026-10-10", 700); // 受領日から 21 日前
    expect(must(listJournalCandidates(ctx.deps, r.id)).map((c) => c.journal.id)).toEqual([
      inRange.id,
    ]);
  });

  it("日付が日本時間で翌日にあたる受領日時は、その翌日を基準にする", () => {
    const ctx = setupReceiptsWithLedger();
    const r = seedReceipt(ctx.uow, {
      id: "r-late",
      transactionDate: null,
      amount: null,
      receivedAt: "2026-10-31T16:00:00.000Z", // JST では 2026-11-01
    });
    const edge = post(ctx, "2026-11-15"); // 11-01 から +14（範囲の端）。UTC の日付なら +15 で外れる
    expect(must(listJournalCandidates(ctx.deps, r.id)).map((c) => c.journal.id)).toEqual([edge.id]);
  });

  it("範囲に 50 件を超える仕訳があっても、上位 20 件に正しい候補が入る", () => {
    const { ctx, receipt } = setup();
    for (let i = 0; i < 60; i++) post(ctx, "2026-10-20", 100 + i);
    const target = post(ctx, "2026-11-03", 1100); // 一致（+14）
    const candidates = must(listJournalCandidates(ctx.deps, receipt.id));
    expect(candidates).toHaveLength(20);
    expect(candidates[0]?.journal.id).toBe(target.id);
  });

  it("証憑がなければ RECEIPT_NOT_FOUND", () => {
    const { ctx } = setup();
    expect(codeOf(listJournalCandidates(ctx.deps, "r-none"))).toBe("RECEIPT_NOT_FOUND");
  });
});

describe("listJournalReceipts・countReceiptsByJournal（仕訳側の合成。R6）", () => {
  it("有効な結びつきの証憑だけを返し、閉じた結びつきは数えない", () => {
    const { ctx, receipt } = setup();
    const second = seedReceipt(ctx.uow, { id: "r-2" });
    const third = seedReceipt(ctx.uow, { id: "r-3" });
    const a = post(ctx, "2026-10-20");
    const b = post(ctx, "2026-10-21");
    post(ctx, "2026-10-22"); // 結びつきなし
    must(linkReceipt(ctx.deps, receipt.id, { journalId: a.id }));
    must(linkReceipt(ctx.deps, second.id, { journalId: a.id }));
    must(linkReceipt(ctx.deps, third.id, { journalId: b.id }));
    must(unlinkReceipt(ctx.deps, second.id, { reason: "解除" }));

    expect(must(listJournalReceipts(ctx.deps, a.id)).map((r) => r.id)).toEqual([receipt.id]);
    expect(must(listJournalReceipts(ctx.deps, b.id)).map((r) => r.id)).toEqual([third.id]);
    const counts = must(countReceiptsByJournal(ctx.deps, [a.id, b.id, "j-none"]));
    expect(counts.get(a.id)).toBe(1);
    expect(counts.get(b.id)).toBe(1);
    expect(counts.has("j-none")).toBe(false);
  });

  it("listJournalReceipts は仕訳がなければ JOURNAL_NOT_FOUND", () => {
    const { ctx } = setup();
    expect(codeOf(listJournalReceipts(ctx.deps, "j-none"))).toBe("JOURNAL_NOT_FOUND");
  });
});
