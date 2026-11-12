import { beforeEach, describe, expect, it } from "vitest";
import { matchConfidence } from "../../src/statements/match-existing.ts";
import type { StatementRow } from "../../src/statements/table.ts";
import { transferConfidence } from "../../src/statements/transfer.ts";
import type { JournalDraft, StatementCandidateRecord } from "../../src/types.ts";
import { createJournal } from "../../src/usecases/create-journal.ts";
import { buildCandidates, listStatements } from "../../src/usecases/statements.ts";
import { unwrap } from "../result.ts";
import { type StatementsCtx, setupStatements } from "../statements-setup.ts";

// 006 T014（R5〜R8、§1.4、FR-012・013・019・021a）。候補の作成・作り直し・一覧

let ctx: StatementsCtx;
beforeEach(() => {
  ctx = setupStatements();
});

const row = (over: Partial<StatementRow> = {}): StatementRow => ({
  accountName: "サンプル銀行",
  date: "2026-05-10",
  content: "ショップ001",
  amount: -1200,
  transferFlag: false,
  ...over,
});

const all = () => ctx.uow.statements.listStatements();
const candidateOf = (id: string): StatementCandidateRecord | undefined =>
  ctx.uow.statements.listStatementCandidates().find((c) => c.statementId === id);
const draftOf = (id: string) => JSON.parse(candidateOf(id)?.draftJson ?? "null") as JournalDraft;
const linesOf = (id: string) =>
  draftOf(id).lines.map((l) => ({ side: l.side, accountId: l.accountId, amount: l.amount }));

const rentDraft = (date = "2026-05-10", amount = 80_000): JournalDraft => ({
  date,
  memo: "家賃",
  lines: [
    { side: "debit", accountId: ctx.a.rent, amount },
    { side: "credit", accountId: ctx.a.bank, amount },
  ],
});
const addRentJournal = (date?: string) =>
  unwrap(createJournal(ctx, rentDraft(date), { source: "recurring" })).journal;

describe("buildCandidates: 既存の仕訳との照合（R7）", () => {
  it("同じ口座・向き・金額で日付が近い有効な仕訳があれば match の候補（draft は仕訳と行の ID）", () => {
    ctx.mapBank();
    const j = addRentJournal("2026-05-12");
    ctx.importRows([row({ content: "家賃", amount: -80_000 })]);
    const r = unwrap(buildCandidates(ctx.deps));
    expect(r).toEqual({ built: 1, needsAi: [] });
    const id = ctx.idOf("家賃");
    const c = candidateOf(id);
    expect(c).toMatchObject({
      method: "match",
      purpose: "business",
      confidence: matchConfidence(2),
      ruleId: null,
      model: null,
    });
    const creditLine = j.lines.find((l) => l.side === "credit");
    expect(JSON.parse(c?.draftJson ?? "null")).toEqual({ journalId: j.id, lineId: creditLine?.id });
  });

  it("取消済みの仕訳は対象外（none になり、AI が要る）", () => {
    ctx.mapBank();
    const j = addRentJournal();
    ctx.ledger.voidJournal(j.id, j.version, "2026-05-11T00:00:00.000Z");
    ctx.importRows([row({ content: "家賃", amount: -80_000 })]);
    const r = unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf("家賃"))?.method).toBe("none");
    expect(r.needsAi).toEqual([ctx.idOf("家賃")]);
  });

  it("同じ仕訳の行に、2 件の明細が一致しない（先の明細だけが結びつく候補になる）", () => {
    ctx.mapBank();
    addRentJournal();
    ctx.importRows([
      row({ content: "家賃", amount: -80_000, date: "2026-05-10" }),
      row({ content: "家賃 2", amount: -80_000, date: "2026-05-11" }),
    ]);
    unwrap(buildCandidates(ctx.deps));
    const methods = all().map((s) => candidateOf(s.id)?.method);
    expect(methods.filter((m) => m === "match")).toHaveLength(1);
    expect(methods.filter((m) => m === "none")).toHaveLength(1);
  });

  it("結びつき済みの行は対象外", () => {
    ctx.mapBank();
    const j = addRentJournal();
    ctx.importRows([
      row({ content: "家賃", amount: -80_000 }),
      row({ content: "別の明細", amount: -80_000 }),
    ]);
    const creditLine = j.lines.find((l) => l.side === "credit");
    ctx.uow.statements.insertStatementLink({
      id: ctx.ids.next(),
      statementId: ctx.idOf("家賃"),
      journalId: j.id,
      journalLineId: creditLine?.id ?? "",
      kind: "matched",
      createdAt: "2026-05-11T00:00:00.000Z",
      revokedAt: null,
      revokedReason: null,
    });
    unwrap(buildCandidates(ctx.deps));
    // 登録済みの明細は候補を作らず、別の明細は一致する行がない
    expect(candidateOf(ctx.idOf("家賃"))).toBeUndefined();
    expect(candidateOf(ctx.idOf("別の明細"))?.method).toBe("none");
  });
});

describe("buildCandidates: 振替の対（R6）", () => {
  const pairRows = () => [
    row({ content: "カード引落", amount: -30_000, transferFlag: true, date: "2026-05-10" }),
    row({
      accountName: "テストカードA",
      content: "お支払い",
      amount: 30_000,
      transferFlag: true,
      date: "2026-05-12",
    }),
  ];

  it("銀行の出金とカードの入金が対になり、両方に同じ仕訳の案（借 未払金 / 貸 普通預金、出金の日付）", () => {
    ctx.mapBank();
    ctx.mapCard();
    ctx.importRows(pairRows());
    const r = unwrap(buildCandidates(ctx.deps));
    expect(r).toEqual({ built: 2, needsAi: [] });
    const out = ctx.idOf("カード引落");
    const inn = ctx.idOf("お支払い");
    for (const id of [out, inn]) {
      expect(candidateOf(id)).toMatchObject({
        method: "transfer",
        purpose: "business",
        confidence: transferConfidence(2),
      });
      expect(linesOf(id)).toEqual([
        { side: "debit", accountId: ctx.a.payable, amount: 30_000 },
        { side: "credit", accountId: ctx.a.bank, amount: 30_000 },
      ]);
      expect(draftOf(id).date).toBe("2026-05-10");
    }
  });

  it("1 件の対に 2 件が名乗り出ても、対は 1 組だけ（残りは対のない明細）", () => {
    ctx.mapBank();
    ctx.mapCard();
    ctx.importRows([
      row({ content: "引落A", amount: -30_000, date: "2026-05-10" }),
      row({ content: "引落B", amount: -30_000, date: "2026-05-11" }),
      row({ accountName: "テストカードA", content: "入金", amount: 30_000, date: "2026-05-10" }),
    ]);
    const r = unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf("引落A"))?.method).toBe("transfer");
    expect(candidateOf(ctx.idOf("入金"))?.method).toBe("transfer");
    expect(candidateOf(ctx.idOf("引落B"))?.method).toBe("none");
    expect(r.needsAi).toEqual([ctx.idOf("引落B")]);
  });

  it("片方が private の口座なら、事業の側は事業主貸・事業主借の案（purpose = private）、private の側は none", () => {
    ctx.mapBank();
    ctx.mapPrivate();
    ctx.importRows([
      row({ content: "生活費へ", amount: -5000, transferFlag: true }),
      row({ accountName: "テスト現金", content: "受取", amount: 5000, transferFlag: true }),
    ]);
    const r = unwrap(buildCandidates(ctx.deps));
    const bankSide = ctx.idOf("生活費へ");
    expect(candidateOf(bankSide)).toMatchObject({ method: "transfer", purpose: "private" });
    expect(linesOf(bankSide)).toEqual([
      { side: "debit", accountId: ctx.accountId("事業主貸"), amount: 5000 },
      { side: "credit", accountId: ctx.a.bank, amount: 5000 },
    ]);
    expect(candidateOf(ctx.idOf("受取"))?.method).toBe("none");
    // 振替の対として作った候補は AI に回さない
    expect(r.needsAi).toEqual([]);
  });

  it("対のない引落（振替の印つき・カードらしい内容）は none で、AI が要る。振替の印がなければ推定しない", () => {
    ctx.mapBank();
    ctx.importRows([
      row({ content: "カード引落 テストカードA", amount: -45_000, transferFlag: true }),
      row({ content: "ショップ001", amount: -400 }),
    ]);
    const r = unwrap(buildCandidates(ctx.deps));
    const unpaired = candidateOf(ctx.idOf("カード引落 テストカードA"));
    expect(unpaired?.method).toBe("none");
    expect(unpaired?.reason).toContain("カード");
    expect(candidateOf(ctx.idOf("ショップ001"))?.reason).not.toContain("カード");
    expect(r.needsAi.sort()).toEqual(
      [ctx.idOf("カード引落 テストカードA"), ctx.idOf("ショップ001")].sort(),
    );
  });
});

describe("buildCandidates: none・対象・作り直し", () => {
  it("どの段でも作れなければ none（purpose・confidence・draft は null）。AI が要る", () => {
    ctx.mapBank();
    ctx.importRows([row()]);
    const r = unwrap(buildCandidates(ctx.deps));
    const c = candidateOf(ctx.idOf("ショップ001"));
    expect(c).toMatchObject({
      method: "none",
      purpose: null,
      confidence: null,
      draftJson: null,
      ruleId: null,
    });
    expect(c?.reason).not.toBe("");
    expect(r).toEqual({ built: 1, needsAi: [ctx.idOf("ショップ001")] });
  });

  it("private の口座の none も AI に回す（私用の口座の出金も事業／私用の判定が要る。US2-5）", () => {
    ctx.mapBank();
    ctx.mapPrivate();
    ctx.importRows([
      row({ accountName: "テスト現金", content: "私用の口座の支払い", amount: -2_000 }),
      row({ content: "銀行の支払い", amount: -500 }),
    ]);
    const r = unwrap(buildCandidates(ctx.deps));
    const id = ctx.idOf("私用の口座の支払い");
    expect(candidateOf(id)).toMatchObject({ method: "none", purpose: null, draftJson: null });
    expect(candidateOf(id)?.reason).not.toContain("除外してください");
    expect([...r.needsAi].sort()).toEqual([id, ctx.idOf("銀行の支払い")].sort());
  });

  it("0 円は候補を作らない（AI にも回さない）", () => {
    ctx.mapBank();
    ctx.importRows([row({ amount: 0 })]);
    const r = unwrap(buildCandidates(ctx.deps));
    expect(r).toEqual({ built: 0, needsAi: [] });
    expect(ctx.uow.statements.listStatementCandidates()).toHaveLength(0);
  });

  it("未処理だけが対象（登録済み・除外済みは作らない）", () => {
    ctx.mapBank();
    const j = addRentJournal();
    ctx.importRows([
      row({ content: "登録済み", amount: -80_000 }),
      row({ content: "除外済み", amount: -300 }),
      row({ content: "未処理", amount: -500 }),
    ]);
    const credit = j.lines.find((l) => l.side === "credit");
    ctx.uow.statements.insertStatementLink({
      id: ctx.ids.next(),
      statementId: ctx.idOf("登録済み"),
      journalId: j.id,
      journalLineId: credit?.id ?? "",
      kind: "matched",
      createdAt: "2026-05-11T00:00:00.000Z",
      revokedAt: null,
      revokedReason: null,
    });
    const excluded = ctx.uow.statements.state.statements.find((s) => s.content === "除外済み");
    if (excluded !== undefined) excluded.excludedAt = "2026-05-11T00:00:00.000Z";
    const r = unwrap(buildCandidates(ctx.deps));
    expect(r.built).toBe(1);
    expect(candidateOf(ctx.idOf("登録済み"))).toBeUndefined();
    expect(candidateOf(ctx.idOf("除外済み"))).toBeUndefined();
    expect(candidateOf(ctx.idOf("未処理"))?.method).toBe("none");
  });

  it("statementIds を渡すと、その明細だけ。知らない ID は STATEMENT_NOT_FOUND で何も書かない", () => {
    ctx.mapBank();
    ctx.importRows([row({ content: "A" }), row({ content: "B" })]);
    unwrap(buildCandidates(ctx.deps, [ctx.idOf("A")]));
    expect(ctx.uow.statements.listStatementCandidates().map((c) => c.statementId)).toEqual([
      ctx.idOf("A"),
    ]);
    const bad = buildCandidates(ctx.deps, [ctx.idOf("B"), "no-such-id"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("STATEMENT_NOT_FOUND");
    expect(ctx.uow.statements.listStatementCandidates()).toHaveLength(1);
  });

  it("もう一度呼ぶと作り直す（あとから仕訳が増えれば match になる）", () => {
    ctx.mapBank();
    ctx.importRows([row({ content: "家賃", amount: -80_000 })]);
    unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf("家賃"))?.method).toBe("none");
    addRentJournal();
    const r = unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf("家賃"))?.method).toBe("match");
    expect(r.needsAi).toEqual([]);
    expect(ctx.uow.statements.listStatementCandidates()).toHaveLength(1);
  });

  it("AI の候補は、前の段で作れなければ残す（rebuild なら作り直す）。前の段で作れれば上書き", () => {
    ctx.mapBank();
    ctx.importRows([row({ content: "家賃", amount: -80_000 }), row({ content: "ショップ001" })]);
    const ai = (statementId: string): StatementCandidateRecord => ({
      statementId,
      method: "local_ai",
      purpose: "business",
      confidence: 70,
      reason: "AI の推定",
      draftJson: JSON.stringify(rentDraft()),
      ruleId: null,
      model: "fm",
      createdAt: "2026-05-11T00:00:00.000Z",
    });
    ctx.uow.statements.upsertStatementCandidate(ai(ctx.idOf("家賃")));
    ctx.uow.statements.upsertStatementCandidate(ai(ctx.idOf("ショップ001")));

    addRentJournal();
    const kept = unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf("家賃"))?.method).toBe("match");
    expect(candidateOf(ctx.idOf("ショップ001"))?.method).toBe("local_ai");
    expect(kept.needsAi).toEqual([]);

    const rebuilt = unwrap(buildCandidates(ctx.deps, undefined, { rebuild: true }));
    expect(candidateOf(ctx.idOf("ショップ001"))?.method).toBe("none");
    expect(rebuilt.needsAi).toEqual([ctx.idOf("ショップ001")]);
  });
});

describe("saveStatementAccount: 未処理の候補の作り直し（rebuilt）", () => {
  it("科目の対応を変えると、その口座の未処理の候補を作り直す。件数を rebuilt で返す", () => {
    ctx.mapBank();
    addRentJournal();
    ctx.importRows([row({ content: "家賃", amount: -80_000 }), row({ content: "ショップ001" })]);
    unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf("家賃"))?.method).toBe("match");

    // 同じ口座の対応を現金に変えると、仕訳の照合は外れる
    const saved = ctx.mapAccount("サンプル銀行", { accountId: ctx.a.cash });
    expect(saved.rebuilt).toBe(2);
    expect(candidateOf(ctx.idOf("家賃"))?.method).toBe("none");
  });

  it("対の相手の口座の対応を変えると、対の相手の候補の案も作り直す", () => {
    ctx.mapBank();
    ctx.mapCard();
    ctx.importRows([
      row({ content: "カード引落", amount: -30_000, transferFlag: true }),
      row({
        accountName: "テストカードA",
        content: "お支払い",
        amount: 30_000,
        transferFlag: true,
      }),
    ]);
    unwrap(buildCandidates(ctx.deps));
    const other = ctx.accountId("売掛金");
    const saved = ctx.mapAccount("テストカードA", {
      kind: "card",
      usage: "mixed",
      accountId: other,
      subAccountId: undefined,
    });
    expect(saved.rebuilt).toBe(2);
    expect(linesOf(ctx.idOf("カード引落"))[0]?.accountId).toBe(other);
    expect(linesOf(ctx.idOf("お支払い"))[0]?.accountId).toBe(other);
  });

  it("変更がなければ作り直さない（rebuilt 0）。AI の候補は他の口座には触れない", () => {
    ctx.mapBank();
    ctx.mapCard();
    ctx.importRows([row(), row({ accountName: "テストカードA", content: "ショップ002" })]);
    unwrap(buildCandidates(ctx.deps));
    ctx.uow.statements.upsertStatementCandidate({
      statementId: ctx.idOf("ショップ002"),
      method: "external_ai",
      purpose: "business",
      confidence: 80,
      reason: "AI",
      draftJson: JSON.stringify(rentDraft()),
      ruleId: null,
      model: "m",
      createdAt: "2026-05-11T00:00:00.000Z",
    });
    expect(ctx.mapBank().rebuilt).toBe(0);
    const changed = ctx.mapAccount("サンプル銀行", { accountId: ctx.a.cash });
    expect(changed.rebuilt).toBe(1);
    expect(candidateOf(ctx.idOf("ショップ002"))?.method).toBe("external_ai");
  });
});

describe("listStatements（StatementView）", () => {
  it("口座名・用途・状態・候補・結びつき・変更ありを持つ。日付の新しい順", () => {
    ctx.mapBank();
    ctx.mapPrivate();
    const j = addRentJournal();
    ctx.importRows([
      row({ content: "家賃", amount: -80_000, date: "2026-05-10" }),
      row({ content: "ショップ001", date: "2026-05-20" }),
      row({ accountName: "テスト現金", content: "私用", amount: -100, date: "2026-05-15" }),
    ]);
    unwrap(buildCandidates(ctx.deps));
    const credit = j.lines.find((l) => l.side === "credit");
    ctx.uow.statements.insertStatementLink({
      id: ctx.ids.next(),
      statementId: ctx.idOf("家賃"),
      journalId: j.id,
      journalLineId: credit?.id ?? "",
      kind: "matched",
      createdAt: "2026-05-11T00:00:00.000Z",
      revokedAt: null,
      revokedReason: null,
    });
    const views = unwrap(listStatements(ctx.deps));
    expect(views.map((v) => v.content)).toEqual(["ショップ001", "私用", "家賃"]);
    const [shop, priv, rentView] = views;
    expect(shop).toMatchObject({
      accountName: "サンプル銀行",
      usage: "business",
      status: "unprocessed",
      changed: null,
      links: [],
      candidate: { method: "none", purpose: null, confidence: null, draft: null },
    });
    expect(priv).toMatchObject({ usage: "private", status: "unprocessed" });
    expect(rentView).toMatchObject({
      status: "registered",
      links: [{ journalId: j.id, kind: "matched" }],
    });
  });

  it("match の候補は match { journalId, lineId }、transfer の候補は draft を持つ", () => {
    ctx.mapBank();
    ctx.mapCard();
    const j = addRentJournal();
    ctx.importRows([
      row({ content: "家賃", amount: -80_000 }),
      row({ content: "カード引落", amount: -30_000, transferFlag: true, date: "2026-05-20" }),
      row({
        accountName: "テストカードA",
        content: "お支払い",
        amount: 30_000,
        transferFlag: true,
        date: "2026-05-20",
      }),
    ]);
    unwrap(buildCandidates(ctx.deps));
    const views = unwrap(listStatements(ctx.deps));
    const byContent = (c: string) => views.find((v) => v.content === c);
    const credit = j.lines.find((l) => l.side === "credit");
    expect(byContent("家賃")?.candidate).toMatchObject({
      method: "match",
      match: { journalId: j.id, lineId: credit?.id },
      draft: null,
    });
    expect(byContent("カード引落")?.candidate?.draft?.lines).toHaveLength(2);
  });

  it("仕訳を取り消すと unprocessed に戻り、除外は excluded（INV-44）。結びつきは有効なものだけ返す", () => {
    ctx.mapBank();
    const j = addRentJournal();
    ctx.importRows([
      row({ content: "家賃", amount: -80_000 }),
      row({ content: "除外", amount: -1 }),
    ]);
    const credit = j.lines.find((l) => l.side === "credit");
    ctx.uow.statements.insertStatementLink({
      id: ctx.ids.next(),
      statementId: ctx.idOf("家賃"),
      journalId: j.id,
      journalLineId: credit?.id ?? "",
      kind: "created",
      createdAt: "2026-05-11T00:00:00.000Z",
      revokedAt: null,
      revokedReason: null,
    });
    const ex = ctx.uow.statements.state.statements.find((s) => s.content === "除外");
    if (ex !== undefined) ex.excludedAt = "2026-05-11T00:00:00.000Z";
    expect(
      unwrap(listStatements(ctx.deps))
        .map((v) => v.status)
        .sort(),
    ).toEqual(["excluded", "registered"]);
    ctx.ledger.voidJournal(j.id, j.version, "2026-05-12T00:00:00.000Z");
    const link = ctx.uow.statements.state.links[0];
    if (link !== undefined) {
      link.revokedAt = "2026-05-12T00:00:00.000Z";
      link.revokedReason = "取消";
    }
    const views = unwrap(listStatements(ctx.deps));
    expect(views.find((v) => v.content === "家賃")).toMatchObject({
      status: "unprocessed",
      links: [],
    });
  });

  it("changed: 新しい内容があり未確認のときだけ { before, after }。確認済みなら null", () => {
    ctx.mapBank();
    ctx.importRows([row({ content: "変更前", amount: -500 })]);
    const id = ctx.idOf("変更前");
    const after = {
      accountName: "サンプル銀行",
      date: "2026-05-10",
      amount: -600,
      content: "変更後",
      categoryMajor: null,
      categoryMinor: null,
      memo: null,
    };
    ctx.uow.statements.markStatementChanged(id, JSON.stringify(after));
    const view = unwrap(listStatements(ctx.deps))[0];
    expect(view?.changed).toEqual({
      before: {
        accountName: "サンプル銀行",
        date: "2026-05-10",
        amount: -500,
        content: "変更前",
        categoryMajor: null,
        categoryMinor: null,
        memo: null,
      },
      after,
    });
    const target = ctx.uow.statements.state.statements[0];
    if (target !== undefined) target.changedAckAt = "2026-05-12T00:00:00.000Z";
    expect(unwrap(listStatements(ctx.deps))[0]?.changed).toBeNull();
  });

  it("status・accountId・from・to で絞る（status = changed は変更ありの印）", () => {
    ctx.mapBank();
    const card = ctx.mapCard();
    ctx.importRows([
      row({ content: "銀行の5月", date: "2026-05-10" }),
      row({ content: "銀行の6月", date: "2026-06-10" }),
      row({ accountName: "テストカードA", content: "カードの6月", date: "2026-06-12" }),
    ]);
    const content = (q: Parameters<typeof listStatements>[1]) =>
      unwrap(listStatements(ctx.deps, q))
        .map((v) => v.content)
        .sort();
    expect(content({ from: "2026-06-01" })).toEqual(["カードの6月", "銀行の6月"]);
    expect(content({ to: "2026-05-31" })).toEqual(["銀行の5月"]);
    expect(content({ accountId: card.account.id })).toEqual(["カードの6月"]);
    expect(content({ status: "registered" })).toEqual([]);
    expect(content({ status: "unprocessed" })).toHaveLength(3);
    expect(content({ status: "changed" })).toEqual([]);
    ctx.uow.statements.markStatementChanged(ctx.idOf("銀行の5月"), JSON.stringify({ amount: -1 }));
    expect(content({ status: "changed" })).toEqual(["銀行の5月"]);
  });
});
