import { beforeEach, describe, expect, it } from "vitest";
import type { JournalDraft } from "../../src/types.ts";
import { createJournal } from "../../src/usecases/create-journal.ts";
import {
  acknowledgeChange,
  approveBulk,
  approveCandidate,
  excludeStatement,
  unexcludeStatement,
  unlinkStatement,
} from "../../src/usecases/statement-approval.ts";
import {
  buildCandidates,
  listStatements,
  saveStatementSettings,
} from "../../src/usecases/statements.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { codeOf, type StatementsCtx, setupStatements, unwrap } from "../statements-setup.ts";

// 006 T015（R5〜R7・R15・R16、§1.5、FR-014〜018・020・021・021a）。承認・除外・結びつきの取消

let ctx: StatementsCtx;
beforeEach(() => {
  ctx = setupStatements();
});

const journals = () => ctx.ledger.state.journals;
const statusOf = (id: string) => unwrap(listStatements(ctx.deps)).find((v) => v.id === id)?.status;
const viewOf = (id: string) => {
  const v = unwrap(listStatements(ctx.deps)).find((x) => x.id === id);
  if (v === undefined) throw new Error("明細がない");
  return v;
};
const audits = () => ctx.uow.statements.audits;

const rentDraft = (date = "2026-05-10", amount = 80_000): JournalDraft => ({
  date,
  memo: "家賃",
  lines: [
    { side: "debit", accountId: ctx.a.rent, amount },
    { side: "credit", accountId: ctx.a.bank, amount },
  ],
});
const voidIt = (journalId: string) => {
  const j = ctx.ledger.getJournal(journalId);
  if (j === undefined) throw new Error("仕訳がない");
  return unwrap(voidJournal(ctx.ledgerDeps, journalId, { reason: "取消", version: j.version }));
};

describe("approveCandidate: 仕訳の登録（created）", () => {
  it("直した案で承認すると、出所 statement の仕訳が 1 件でき、明細の口座の行に結びつく（INV-42）", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "文房具", amount: -1_200 })]);
    const id = ctx.idOf("文房具");
    const r = unwrap(
      approveCandidate(ctx.deps, id, { draft: ctx.shapeDraft(id, "business", ctx.a.supplies) }),
    );
    expect(journals()).toHaveLength(1);
    expect(r.journal).toMatchObject({ source: "statement", status: "active" });
    expect(r.pairLink).toBeNull();
    const line = r.journal?.lines.find((l) => l.id === r.link.journalLineId);
    expect(line).toMatchObject({ side: "credit", accountId: ctx.a.bank, amount: 1_200 });
    expect(r.link).toMatchObject({
      statementId: id,
      journalId: r.journal?.id,
      kind: "created",
      revokedAt: null,
    });
    expect(ctx.activeLinks()).toHaveLength(1);
    expect(statusOf(id)).toBe("registered");
    expect(audits().some((a) => a.targetType === "statement_link" && a.action === "create")).toBe(
      true,
    );
  });

  it("入金は借方の行に結びつく。private の口座は事業主貸・事業主借の行に結びつく", () => {
    ctx.mapBank();
    ctx.mapPrivate();
    ctx.importRows([
      ctx.row({ content: "入金A", amount: 3_000 }),
      ctx.row({ accountName: "テスト現金", content: "私用口座の仕入", amount: -700 }),
    ]);
    const inflow = ctx.idOf("入金A");
    const a = unwrap(
      approveCandidate(ctx.deps, inflow, { draft: ctx.shapeDraft(inflow, "business") }),
    );
    expect(a.journal?.lines.find((l) => l.id === a.link.journalLineId)).toMatchObject({
      side: "debit",
      accountId: ctx.a.bank,
    });
    const priv = ctx.idOf("私用口座の仕入");
    const b = unwrap(approveCandidate(ctx.deps, priv, { draft: ctx.shapeDraft(priv, "business") }));
    expect(b.journal?.lines.find((l) => l.id === b.link.journalLineId)).toMatchObject({
      side: "credit",
      accountId: ctx.a.contribution,
      amount: 700,
    });
  });

  it("候補の案のまま承認できる（振替の対は 2 件が同じ仕訳の別々の行に結びつく。INV-43）", () => {
    ctx.mapBank();
    ctx.mapCard();
    ctx.importRows([
      ctx.row({ content: "カード引落", amount: -30_000, transferFlag: true }),
      ctx.row({
        accountName: "テストカードA",
        content: "お支払い",
        amount: 30_000,
        transferFlag: true,
        date: "2026-05-12",
      }),
    ]);
    unwrap(buildCandidates(ctx.deps));
    const out = ctx.idOf("カード引落");
    const inn = ctx.idOf("お支払い");
    const r = unwrap(approveCandidate(ctx.deps, out));
    expect(journals()).toHaveLength(1);
    expect(r.pairLink).toMatchObject({ statementId: inn, journalId: r.journal?.id });
    expect(r.pairLink?.journalLineId).not.toBe(r.link.journalLineId);
    expect(r.journal?.lines.find((l) => l.id === r.link.journalLineId)).toMatchObject({
      side: "credit",
      accountId: ctx.a.bank,
    });
    expect(r.journal?.lines.find((l) => l.id === r.pairLink?.journalLineId)).toMatchObject({
      side: "debit",
      accountId: ctx.a.payable,
    });
    expect(statusOf(out)).toBe("registered");
    expect(statusOf(inn)).toBe("registered");
    // 対の相手を続けて承認しても二重にならない
    expect(codeOf(approveCandidate(ctx.deps, inn))).toBe("STATEMENT_ALREADY_REGISTERED");
    expect(journals()).toHaveLength(1);
  });

  it("対の相手がすでに登録・除外済みなら、自分の側だけ結びつく", () => {
    ctx.mapBank();
    ctx.mapCard();
    ctx.importRows([
      ctx.row({ content: "カード引落", amount: -30_000, transferFlag: true }),
      ctx.row({ accountName: "テストカードA", content: "お支払い", amount: 30_000 }),
    ]);
    unwrap(buildCandidates(ctx.deps));
    unwrap(excludeStatement(ctx.deps, ctx.idOf("お支払い"), {}));
    const r = unwrap(approveCandidate(ctx.deps, ctx.idOf("カード引落")));
    expect(r.pairLink).toBeNull();
    expect(statusOf(ctx.idOf("お支払い"))).toBe("excluded");
  });

  it("直した案の、明細の口座の行の合計が明細の金額と違えば STATEMENT_AMOUNT_MISMATCH（何も書かない）", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    const id = ctx.idOf("家賃");
    const r = approveCandidate(ctx.deps, id, { draft: rentDraft("2026-05-10", 79_000) });
    expect(codeOf(r)).toBe("STATEMENT_AMOUNT_MISMATCH");
    if (!r.ok) expect(r.error.details).toMatchObject({ expected: -80_000, actual: -79_000 });
    expect(journals()).toHaveLength(0);
    expect(ctx.links()).toHaveLength(0);
    // 明細の口座の行がない案も同じ
    const noLine = approveCandidate(ctx.deps, id, {
      draft: {
        date: "2026-05-10",
        lines: [
          { side: "debit", accountId: ctx.a.rent, amount: 80_000 },
          { side: "credit", accountId: ctx.a.cash, amount: 80_000 },
        ],
      },
    });
    expect(codeOf(noLine)).toBe("STATEMENT_AMOUNT_MISMATCH");
  });

  it("貸借が合わない案は UNBALANCED、締め済みの期間の日付は PERIOD_CLOSED（何も書かない）", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    const id = ctx.idOf("家賃");
    const bad: JournalDraft = {
      date: "2026-05-10",
      lines: [
        { side: "debit", accountId: ctx.a.rent, amount: 70_000 },
        { side: "credit", accountId: ctx.a.bank, amount: 80_000 },
      ],
    };
    expect(codeOf(approveCandidate(ctx.deps, id, { draft: bad }))).toBe("UNBALANCED");
    ctx.closeYear(2026);
    expect(codeOf(approveCandidate(ctx.deps, id, { draft: rentDraft() }))).toBe("PERIOD_CLOSED");
    expect(journals()).toHaveLength(0);
    expect(ctx.links()).toHaveLength(0);
  });

  it("税区分を省かれた行は 001 の既定で補う（承認が失敗しない）", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    const id = ctx.idOf("家賃");
    const r = unwrap(approveCandidate(ctx.deps, id, { draft: rentDraft() }));
    for (const l of r.journal?.lines ?? []) expect(l.taxCategory).toBeTruthy();
  });

  it("候補も入力もなければ VALIDATION。知らない ID は STATEMENT_NOT_FOUND。補正元つきの案は VALIDATION", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    const id = ctx.idOf("家賃");
    expect(codeOf(approveCandidate(ctx.deps, id))).toBe("VALIDATION");
    unwrap(buildCandidates(ctx.deps)); // none の候補
    expect(codeOf(approveCandidate(ctx.deps, id))).toBe("VALIDATION");
    expect(codeOf(approveCandidate(ctx.deps, "no-such-id"))).toBe("STATEMENT_NOT_FOUND");
    expect(
      codeOf(
        approveCandidate(ctx.deps, id, {
          draft: { ...rentDraft(), correctsJournalId: "x" },
        }),
      ),
    ).toBe("VALIDATION");
    expect(
      codeOf(
        approveCandidate(ctx.deps, id, {
          draft: rentDraft(),
          match: { journalId: "j", lineId: "l" },
        }),
      ),
    ).toBe("VALIDATION");
    expect(ctx.links()).toHaveLength(0);
  });

  it("登録済みは STATEMENT_ALREADY_REGISTERED、除外済みは STATEMENT_EXCLUDED", () => {
    ctx.mapBank();
    ctx.importRows([
      ctx.row({ content: "家賃", amount: -80_000 }),
      ctx.row({ content: "除外する", amount: -100 }),
    ]);
    const id = ctx.idOf("家賃");
    unwrap(approveCandidate(ctx.deps, id, { draft: rentDraft() }));
    expect(codeOf(approveCandidate(ctx.deps, id, { draft: rentDraft() }))).toBe(
      "STATEMENT_ALREADY_REGISTERED",
    );
    const ex = ctx.idOf("除外する");
    unwrap(excludeStatement(ctx.deps, ex, {}));
    expect(codeOf(approveCandidate(ctx.deps, ex, { draft: ctx.shapeDraft(ex, "business") }))).toBe(
      "STATEMENT_EXCLUDED",
    );
    expect(journals()).toHaveLength(1);
  });

  it("訂正（締め済みの仕訳の訂正）では registered のまま、取消で unprocessed に戻る（INV-44）", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000, date: "2025-05-10" })], 2025);
    const id = ctx.idOf("家賃");
    const r = unwrap(approveCandidate(ctx.deps, id, { draft: rentDraft("2025-05-10") }));
    const journalId = r.journal?.id ?? "";
    expect(statusOf(id)).toBe("registered");
    // 2025 年度を締めて、2026 年に訂正仕訳を起票する（元の仕訳は残る）
    ctx.closeYear(2025);
    unwrap(
      createJournal(
        ctx,
        { ...rentDraft("2026-01-05", 81_000), correctsJournalId: journalId },
        { source: "statement" },
      ),
    );
    expect(ctx.ledger.getJournal(journalId)?.status).toBe("active");
    expect(statusOf(id)).toBe("registered");
    expect(ctx.activeLinks()).toHaveLength(1);
  });
});

describe("approveCandidate: 取消のあとの再承認（R15）", () => {
  it("仕訳を取り消すと unprocessed に戻り、再承認すると古い結びつきが失効し、有効な結びつきは 1 件", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    const id = ctx.idOf("家賃");
    const first = unwrap(approveCandidate(ctx.deps, id, { draft: rentDraft() }));
    voidIt(first.journal?.id ?? "");
    expect(statusOf(id)).toBe("unprocessed");

    const second = unwrap(approveCandidate(ctx.deps, id, { draft: rentDraft("2026-05-11") }));
    expect(statusOf(id)).toBe("registered");
    expect(ctx.links()).toHaveLength(2);
    expect(ctx.activeLinks()).toHaveLength(1);
    expect(ctx.activeLinks()[0]?.journalId).toBe(second.journal?.id);
    const revoked = ctx.links().find((l) => l.revokedAt !== null);
    expect(revoked).toMatchObject({ journalId: first.journal?.id });
    expect(revoked?.revokedReason).toBeTruthy();
    expect(audits().some((a) => a.targetType === "statement_link" && a.action === "revoke")).toBe(
      true,
    );
  });

  it("再承認が失敗したら、失効も巻き戻る（INV-47）", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    const id = ctx.idOf("家賃");
    const first = unwrap(approveCandidate(ctx.deps, id, { draft: rentDraft() }));
    voidIt(first.journal?.id ?? "");
    ctx.closeYear(2026);
    expect(codeOf(approveCandidate(ctx.deps, id, { draft: rentDraft() }))).toBe("PERIOD_CLOSED");
    expect(ctx.links()).toHaveLength(1);
    expect(ctx.links()[0]?.revokedAt).toBeNull();
    expect(journals()).toHaveLength(1);
  });
});

describe("approveCandidate: 既存の仕訳との結びつき（matched。R7、FR-021a）", () => {
  const addRent = (date = "2026-05-12") =>
    unwrap(createJournal(ctx, rentDraft(date), { source: "recurring" })).journal;

  it("match の候補を承認すると、仕訳は作らず結びつくだけ（journal は null）", () => {
    ctx.mapBank();
    const j = addRent();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    unwrap(buildCandidates(ctx.deps));
    const id = ctx.idOf("家賃");
    const r = unwrap(approveCandidate(ctx.deps, id));
    expect(r.journal).toBeNull();
    expect(journals()).toHaveLength(1);
    const credit = j.lines.find((l) => l.side === "credit");
    expect(r.link).toMatchObject({ kind: "matched", journalId: j.id, journalLineId: credit?.id });
    expect(statusOf(id)).toBe("registered");
    expect(viewOf(id).links).toEqual([{ journalId: j.id, kind: "matched" }]);
  });

  it("入力の match（利用者が選んだ仕訳）でも結べる。科目・向き・金額が違えば拒否する", () => {
    ctx.mapBank();
    const j = addRent();
    ctx.importRows([
      ctx.row({ content: "家賃", amount: -80_000 }),
      ctx.row({ content: "金額違い", amount: -79_000 }),
      ctx.row({ content: "向き違い", amount: 80_000 }),
    ]);
    const debit = j.lines.find((l) => l.side === "debit");
    const credit = j.lines.find((l) => l.side === "credit");
    const ref = { journalId: j.id, lineId: credit?.id ?? "" };
    expect(codeOf(approveCandidate(ctx.deps, ctx.idOf("金額違い"), { match: ref }))).toBe(
      "STATEMENT_AMOUNT_MISMATCH",
    );
    expect(codeOf(approveCandidate(ctx.deps, ctx.idOf("向き違い"), { match: ref }))).toBe(
      "VALIDATION",
    );
    // 明細の口座でない科目の行
    expect(
      codeOf(
        approveCandidate(ctx.deps, ctx.idOf("家賃"), {
          match: { journalId: j.id, lineId: debit?.id ?? "" },
        }),
      ),
    ).toBe("VALIDATION");
    expect(
      codeOf(
        approveCandidate(ctx.deps, ctx.idOf("家賃"), {
          match: { journalId: j.id, lineId: "no-such-line" },
        }),
      ),
    ).toBe("VALIDATION");
    expect(
      codeOf(
        approveCandidate(ctx.deps, ctx.idOf("家賃"), {
          match: { journalId: "no-such-journal", lineId: "x" },
        }),
      ),
    ).toBe("JOURNAL_NOT_FOUND");
    expect(ctx.links()).toHaveLength(0);
    unwrap(approveCandidate(ctx.deps, ctx.idOf("家賃"), { match: ref }));
  });

  it("別の明細がすでに結びついた行には JOURNAL_LINE_ALREADY_LINKED（INV-43）", () => {
    ctx.mapBank();
    const j = addRent();
    ctx.importRows([
      ctx.row({ content: "家賃", amount: -80_000 }),
      ctx.row({ content: "家賃の二重", amount: -80_000, date: "2026-05-11" }),
    ]);
    const credit = j.lines.find((l) => l.side === "credit");
    const ref = { journalId: j.id, lineId: credit?.id ?? "" };
    unwrap(approveCandidate(ctx.deps, ctx.idOf("家賃"), { match: ref }));
    expect(codeOf(approveCandidate(ctx.deps, ctx.idOf("家賃の二重"), { match: ref }))).toBe(
      "JOURNAL_LINE_ALREADY_LINKED",
    );
    expect(ctx.activeLinks()).toHaveLength(1);
    expect(statusOf(ctx.idOf("家賃の二重"))).toBe("unprocessed");
  });

  it("取消済みの仕訳には結べない", () => {
    ctx.mapBank();
    const j = addRent();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    const credit = j.lines.find((l) => l.side === "credit");
    voidIt(j.id);
    expect(
      codeOf(
        approveCandidate(ctx.deps, ctx.idOf("家賃"), {
          match: { journalId: j.id, lineId: credit?.id ?? "" },
        }),
      ),
    ).toBe("VALIDATION");
  });

  it("private の口座の明細は既存の仕訳に結べない", () => {
    ctx.mapPrivate();
    const j = addRent();
    ctx.importRows([ctx.row({ accountName: "テスト現金", content: "私用", amount: -80_000 })]);
    const credit = j.lines.find((l) => l.side === "credit");
    expect(
      codeOf(
        approveCandidate(ctx.deps, ctx.idOf("私用"), {
          match: { journalId: j.id, lineId: credit?.id ?? "" },
        }),
      ),
    ).toBe("VALIDATION");
  });
});

describe("approveBulk（FR-018）", () => {
  const seed = () => {
    ctx.mapBank();
    ctx.mapCard();
    // 一致する既存の仕訳が 2 件（日付の差で確信度が違う）と、振替の対
    unwrap(createJournal(ctx, rentDraft("2026-05-10"), { source: "recurring" }));
    unwrap(createJournal(ctx, rentDraft("2026-06-17", 50_000), { source: "recurring" }));
    ctx.importRows([
      ctx.row({ content: "家賃近い", amount: -80_000, date: "2026-05-10" }),
      ctx.row({ content: "家賃遠い", amount: -50_000, date: "2026-06-10" }),
      ctx.row({ content: "候補なし", amount: -999, date: "2026-07-01" }),
      ctx.row({ content: "引落", amount: -30_000, date: "2026-08-01", transferFlag: true }),
      ctx.row({
        accountName: "テストカードA",
        content: "支払い",
        amount: 30_000,
        date: "2026-08-02",
        transferFlag: true,
      }),
    ]);
    unwrap(buildCandidates(ctx.deps));
  };

  it("しきい値（既定 80）以上だけを明細ごとに承認する。対の相手は二重に数えない", () => {
    seed();
    const r = unwrap(approveBulk(ctx.deps));
    // 家賃近い（95）、引落（93）と支払い（対の相手）。家賃遠い（日付差 7 日 = 60）は未満
    expect([...r.approved].sort()).toEqual(
      [ctx.idOf("家賃近い"), ctx.idOf("引落"), ctx.idOf("支払い")].sort(),
    );
    expect(r.failed).toEqual([]);
    expect(statusOf(ctx.idOf("家賃遠い"))).toBe("unprocessed");
    expect(statusOf(ctx.idOf("候補なし"))).toBe("unprocessed");
    expect(journals().filter((j) => j.source === "statement")).toHaveLength(1);
  });

  it("threshold を渡す・設定のしきい値を使う", () => {
    seed();
    unwrap(saveStatementSettings(ctx.deps, { bulkThreshold: 50, externalThreshold: 60 }));
    const r = unwrap(approveBulk(ctx.deps));
    expect(r.approved).toContain(ctx.idOf("家賃遠い"));
    expect(r.approved).not.toContain(ctx.idOf("候補なし"));
    const none = unwrap(approveBulk(ctx.deps, { threshold: 100 }));
    expect(none).toEqual({ approved: [], failed: [] });
  });

  it("statementIds を渡すと対象を絞る。失敗は理由つきで残し、ほかは承認する", () => {
    seed();
    const ids = [ctx.idOf("家賃近い"), ctx.idOf("候補なし"), ctx.idOf("家賃遠い"), "no-such-id"];
    const r = unwrap(approveBulk(ctx.deps, { statementIds: ids }));
    expect(r.approved).toEqual([ctx.idOf("家賃近い")]);
    expect(r.failed.map((f) => f.statementId).sort()).toEqual(
      [ctx.idOf("候補なし"), ctx.idOf("家賃遠い"), "no-such-id"].sort(),
    );
    expect(r.failed.find((f) => f.statementId === "no-such-id")?.code).toBe("STATEMENT_NOT_FOUND");
    for (const f of r.failed) expect(f.message).not.toBe("");
  });

  it("承認の途中の失敗（締め済み）は、その明細が理由つきで failed に残り、ほかは承認される", () => {
    seed();
    // 2025 年の振替の対（候補を作ってから、その年度を締める）
    ctx.importRows(
      [
        ctx.row({ content: "旧引落", amount: -10_000, date: "2025-08-01", transferFlag: true }),
        ctx.row({
          accountName: "テストカードA",
          content: "旧支払い",
          amount: 10_000,
          date: "2025-08-02",
          transferFlag: true,
        }),
      ],
      2025,
    );
    unwrap(buildCandidates(ctx.deps));
    ctx.closeYear(2025);
    const r = unwrap(approveBulk(ctx.deps));
    expect(r.approved).toContain(ctx.idOf("家賃近い"));
    expect(r.failed.map((f) => f.statementId).sort()).toEqual(
      [ctx.idOf("旧引落"), ctx.idOf("旧支払い")].sort(),
    );
    for (const f of r.failed) expect(f.code).toBe("PERIOD_CLOSED");
    expect(statusOf(ctx.idOf("旧引落"))).toBe("unprocessed");
  });
});

describe("excludeStatement・unexcludeStatement（FR-017）", () => {
  it("除外すると excluded、除外の取消で unprocessed に戻る。仕訳は作らない（INV-41）", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "私用の買い物", amount: -500 })]);
    const id = ctx.idOf("私用の買い物");
    const ex = unwrap(excludeStatement(ctx.deps, id, { reason: "私用" }));
    expect(ex.status).toBe("excluded");
    expect(ctx.statements()[0]).toMatchObject({ excludedReason: "私用" });
    expect(ctx.statements()[0]?.excludedAt).toBe(ctx.clock.now());
    const back = unwrap(unexcludeStatement(ctx.deps, id, { reason: "誤り" }));
    expect(back.status).toBe("unprocessed");
    expect(ctx.statements()[0]).toMatchObject({ excludedAt: null, excludedReason: null });
    expect(journals()).toHaveLength(0);
    expect(audits().map((a) => a.action)).toEqual(expect.arrayContaining(["exclude", "unexclude"]));
    const unexclude = audits().find((a) => a.action === "unexclude");
    expect(unexclude?.reason).toBe("誤り");
  });

  it("理由は除外では任意（null）、除外の取消では必須（REASON_REQUIRED）", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "A" }), ctx.row({ content: "B" })]);
    const a = ctx.idOf("A");
    unwrap(excludeStatement(ctx.deps, a, {}));
    expect(ctx.statements().find((s) => s.id === a)?.excludedReason).toBeNull();
    expect(codeOf(unexcludeStatement(ctx.deps, a, { reason: "  " }))).toBe("REASON_REQUIRED");
    expect(statusOf(a)).toBe("excluded");
    // 除外していない明細の取消は VALIDATION
    expect(codeOf(unexcludeStatement(ctx.deps, ctx.idOf("B"), { reason: "x" }))).toBe("VALIDATION");
  });

  it("登録済みは除外できない（STATEMENT_ALREADY_REGISTERED）。除外済みをもう一度除外しても変わらない", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 }), ctx.row({ content: "B" })]);
    const id = ctx.idOf("家賃");
    unwrap(approveCandidate(ctx.deps, id, { draft: rentDraft() }));
    expect(codeOf(excludeStatement(ctx.deps, id, {}))).toBe("STATEMENT_ALREADY_REGISTERED");
    const b = ctx.idOf("B");
    unwrap(excludeStatement(ctx.deps, b, { reason: "最初" }));
    unwrap(excludeStatement(ctx.deps, b, { reason: "二回目" }));
    expect(ctx.statements().find((s) => s.id === b)?.excludedReason).toBe("最初");
    expect(codeOf(excludeStatement(ctx.deps, "no-such-id", {}))).toBe("STATEMENT_NOT_FOUND");
  });
});

describe("acknowledgeChange（FR-005）", () => {
  it("変更ありの印を消す（changed_ack_at を書き、監査に残す）。変更がなければ VALIDATION", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "変更前", amount: -500 })]);
    const id = ctx.idOf("変更前");
    expect(codeOf(acknowledgeChange(ctx.deps, id))).toBe("VALIDATION");
    ctx.uow.statements.markStatementChanged(id, JSON.stringify({ amount: -600 }));
    expect(viewOf(id).changed).not.toBeNull();
    const v = unwrap(acknowledgeChange(ctx.deps, id));
    expect(v.changed).toBeNull();
    expect(ctx.statements()[0]?.changedAckAt).toBe(ctx.clock.now());
    expect(audits().some((a) => a.action === "acknowledge" && a.targetId === id)).toBe(true);
    expect(codeOf(acknowledgeChange(ctx.deps, id))).toBe("VALIDATION");
    expect(codeOf(acknowledgeChange(ctx.deps, "no-such-id"))).toBe("STATEMENT_NOT_FOUND");
  });
});

describe("unlinkStatement（FR-021a）", () => {
  it("matched の結びつきだけを理由つきで外す。明細は unprocessed に戻り、仕訳は残る", () => {
    ctx.mapBank();
    const j = unwrap(createJournal(ctx, rentDraft(), { source: "recurring" })).journal;
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    const credit = j.lines.find((l) => l.side === "credit");
    const id = ctx.idOf("家賃");
    unwrap(
      approveCandidate(ctx.deps, id, { match: { journalId: j.id, lineId: credit?.id ?? "" } }),
    );
    expect(codeOf(unlinkStatement(ctx.deps, id, { reason: " " }))).toBe("REASON_REQUIRED");
    const v = unwrap(unlinkStatement(ctx.deps, id, { reason: "誤って結びつけた" }));
    expect(v.status).toBe("unprocessed");
    expect(v.links).toEqual([]);
    expect(ctx.links()[0]).toMatchObject({
      revokedReason: "誤って結びつけた",
    });
    expect(ctx.links()[0]?.revokedAt).toBe(ctx.clock.now());
    expect(ctx.ledger.getJournal(j.id)?.status).toBe("active");
    const unlinkAudit = audits().find((a) => a.action === "unlink");
    expect(unlinkAudit?.reason).toBe("誤って結びつけた");
    // 外した行には、別の明細を結べる
    ctx.importRows([ctx.row({ content: "別", amount: -80_000, date: "2026-05-11" })]);
    unwrap(
      approveCandidate(ctx.deps, ctx.idOf("別"), {
        match: { journalId: j.id, lineId: credit?.id ?? "" },
      }),
    );
  });

  it("created の結びつき・結びつきのない明細は VALIDATION、知らない明細は STATEMENT_NOT_FOUND", () => {
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 }), ctx.row({ content: "B" })]);
    const id = ctx.idOf("家賃");
    unwrap(approveCandidate(ctx.deps, id, { draft: rentDraft() }));
    expect(codeOf(unlinkStatement(ctx.deps, id, { reason: "x" }))).toBe("VALIDATION");
    expect(statusOf(id)).toBe("registered");
    expect(codeOf(unlinkStatement(ctx.deps, ctx.idOf("B"), { reason: "x" }))).toBe("VALIDATION");
    expect(codeOf(unlinkStatement(ctx.deps, "no-such-id", { reason: "x" }))).toBe(
      "STATEMENT_NOT_FOUND",
    );
  });
});
