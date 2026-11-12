import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeContent } from "../../src/statements/normalize.ts";
import type { JournalDraft } from "../../src/types.ts";
import { createJournal } from "../../src/usecases/create-journal.ts";
import {
  listRules,
  pauseRule,
  resumeRule,
  ruleHistory,
  seedRulesFromJournals,
  updateRule,
} from "../../src/usecases/inference-rules.ts";
import {
  acknowledgeChange,
  approveCandidate,
  excludeStatement,
  unexcludeStatement,
} from "../../src/usecases/statement-approval.ts";
import { buildCandidates, listStatements } from "../../src/usecases/statements.ts";
import { codeOf, unwrap } from "../result.ts";
import { FaultInjectingStatementUnitOfWork, snapshotOf } from "../statement-fault-injection.ts";
import { pastedRowArb } from "../statements-arbitraries.ts";
import { type StatementsCtx, setupStatements } from "../statements-setup.ts";

// 006 T019（R9、§1.6・§1.7、FR-022〜024）。ルールの学習・候補への組み込み・管理、INV-41・47

let ctx: StatementsCtx;
beforeEach(() => {
  ctx = setupStatements();
  ctx.mapAll();
});

const rules = () => ctx.uow.statements.state.rules;
const history = () => ctx.uow.statements.state.ruleHistory;
const candidateOf = (id: string) =>
  ctx.uow.statements.state.candidates.find((c) => c.statementId === id);
const bankAccountId = () =>
  ctx.uow.statements.state.accounts.find((a) => a.name === "サンプル銀行")?.id;

const approveWith = (
  content: string,
  counterId = ctx.a.rent,
  input: Record<string, unknown> = {},
) => {
  const id = ctx.idOf(content);
  return unwrap(
    approveCandidate(ctx.deps, id, { draft: ctx.shapeDraft(id, "business", counterId), ...input }),
  );
};

describe("承認からの学習", () => {
  it("承認するとルールを作る（hits 1、承認した口座、相手の科目・判定）。結果の rule に確信度つきで返し、履歴と監査に残す", () => {
    ctx.importRows([ctx.row({ content: "ショップ001", amount: -1200 })]);
    const approved = approveWith("ショップ001");

    expect(rules()).toHaveLength(1);
    expect(rules()[0]).toMatchObject({
      normalizedContent: normalizeContent("ショップ001"),
      statementAccountId: bankAccountId(),
      counterAccountId: ctx.a.rent,
      purpose: "business",
      hits: 1,
      overrides: 0,
      status: "active",
      origin: "approval",
    });
    expect(approved.rule).toMatchObject({ id: rules()[0]?.id, hits: 1, confidence: 60 });
    expect(history()).toHaveLength(1);
    expect(history()[0]).toMatchObject({
      ruleId: rules()[0]?.id,
      action: "create",
      beforeJson: null,
      statementId: ctx.idOf("ショップ001"),
    });
    const audit = ctx.uow.statements.audits.filter((a) => a.targetType === "inference_rule");
    expect(audit.map((a) => a.action)).toEqual(["create"]);
  });

  it("同じ内容を同じ内容で承認するたびに hits が増える。内容が違えば overrides が増え、承認の内容に置き換わる", () => {
    ctx.importRows([
      ctx.row({ content: "ショップ001" }),
      ctx.row({ content: "ショップ002", date: "2026-05-11" }),
      ctx.row({ content: "ショップ003", date: "2026-05-12" }),
    ]);
    approveWith("ショップ001");
    approveWith("ショップ002");
    expect(rules()).toHaveLength(1);
    expect(rules()[0]).toMatchObject({ hits: 2, overrides: 0, counterAccountId: ctx.a.rent });

    const changed = approveWith("ショップ003", ctx.a.supplies);
    expect(rules()[0]).toMatchObject({ hits: 2, overrides: 1, counterAccountId: ctx.a.supplies });
    expect(changed.rule?.confidence).toBe(50 + 20 - 20);
    expect(history().map((h) => h.action)).toEqual(["create", "update", "update"]);
    const last = history()[2];
    expect(JSON.parse(last?.beforeJson ?? "null")).toMatchObject({ counterAccountId: ctx.a.rent });
    expect(JSON.parse(last?.afterJson ?? "null")).toMatchObject({
      counterAccountId: ctx.a.supplies,
    });
  });

  it("承認のたびに学ぶ。作ったルールは managedBy auto（T018・R9）", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" })]);
    const approved = approveWith("ショップ001");
    expect(approved.rule).toMatchObject({ managedBy: "auto" });
    expect(rules()).toHaveLength(1);
    expect(rules()[0]?.managedBy).toBe("auto");
  });

  it("managedBy が user のルールは承認で変えない（ルール・履歴・監査が増えず、結果に rule がない。INV-71）", () => {
    ctx.importRows([
      ctx.row({ content: "ショップ001" }),
      ctx.row({ content: "ショップ002", date: "2026-05-11" }),
    ]);
    approveWith("ショップ001");
    const id = rules()[0]?.id ?? "";
    unwrap(updateRule(ctx.deps, id, { counterAccountId: ctx.a.supplies }));
    const before = structuredClone(rules());
    const historyBefore = history().length;
    const ruleAudits = () =>
      ctx.uow.statements.audits.filter((a) => a.targetType === "inference_rule").length;
    const auditBefore = ruleAudits();

    const approved = approveWith("ショップ002", ctx.a.rent);
    expect(approved.rule).toBeUndefined();
    expect(rules()).toEqual(before);
    expect(history()).toHaveLength(historyBefore);
    expect(ruleAudits()).toBe(auditBefore);
  });

  it("updateRule・pauseRule・resumeRule で managedBy が user になる（戻さない）。変更がなければ auto のまま", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" }), ctx.row({ content: "ショップ002" })]);
    approveWith("ショップ001");
    const id = rules()[0]?.id ?? "";
    unwrap(updateRule(ctx.deps, id, { counterAccountId: ctx.a.rent }));
    expect(rules()[0]?.managedBy).toBe("auto");

    const paused = unwrap(pauseRule(ctx.deps, id));
    expect(paused.managedBy).toBe("user");
    expect(rules()[0]?.managedBy).toBe("user");
    expect(unwrap(resumeRule(ctx.deps, id)).managedBy).toBe("user");
    unwrap(updateRule(ctx.deps, id, { taxCategory: "PURCHASE_8R" }));
    expect(rules()[0]?.managedBy).toBe("user");
  });

  it("科目を直すと user になる", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" })]);
    approveWith("ショップ001");
    const id = rules()[0]?.id ?? "";
    expect(unwrap(updateRule(ctx.deps, id, { counterAccountId: ctx.a.supplies })).managedBy).toBe(
      "user",
    );
  });

  it("口座が違えば別のルール。判定（purpose）と取引先の入力が学習に使われる", () => {
    const partner = ctx.addPartner();
    ctx.importRows([
      ctx.row({ content: "ショップ001" }),
      ctx.row({ content: "ショップ002", accountName: "テストカードA" }),
    ]);
    approveWith("ショップ001", ctx.a.rent, { partnerId: partner.id });
    approveWith("ショップ002");
    expect(rules()).toHaveLength(2);
    expect(rules().find((r) => r.statementAccountId === bankAccountId())?.partnerId).toBe(
      partner.id,
    );
    expect(rules().find((r) => r.statementAccountId !== bankAccountId())?.partnerId).toBeNull();
  });

  it("私用の判定で承認すると、私用のルール（相手は事業主貸）になる。purpose の入力が優先", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" }), ctx.row({ content: "ショップ002" })]);
    const id = ctx.idOf("ショップ001");
    unwrap(approveCandidate(ctx.deps, id, { draft: ctx.shapeDraft(id, "private") }));
    expect(rules()[0]).toMatchObject({ purpose: "private", counterAccountId: ctx.a.drawing });

    const id2 = ctx.idOf("ショップ002");
    unwrap(
      approveCandidate(ctx.deps, id2, {
        draft: ctx.shapeDraft(id2, "business", ctx.a.rent),
        purpose: "private",
      }),
    );
    expect(rules()[0]?.purpose).toBe("private");
  });

  it("存在しない取引先は VALIDATION で、何も書かない", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" })]);
    const id = ctx.idOf("ショップ001");
    const r = approveCandidate(ctx.deps, id, {
      draft: ctx.shapeDraft(id, "business"),
      partnerId: "no-such-partner",
    });
    expect(codeOf(r)).toBe("VALIDATION");
    expect(ctx.ledger.state.journals).toHaveLength(0);
    expect(rules()).toHaveLength(0);
  });

  it("既存の仕訳への結びつき（match）からは学ばない", () => {
    const posted = unwrap(
      createJournal(ctx.ledgerDeps, {
        date: "2026-05-10",
        memo: "家賃",
        lines: [
          { side: "debit", accountId: ctx.a.rent, amount: 1200 },
          { side: "credit", accountId: ctx.a.bank, amount: 1200 },
        ],
      } satisfies JournalDraft),
    ).journal;
    ctx.importRows([ctx.row({ content: "ショップ001", amount: -1200 })]);
    unwrap(buildCandidates(ctx.deps));
    const line = posted.lines.find((l) => l.side === "credit");
    unwrap(
      approveCandidate(ctx.deps, ctx.idOf("ショップ001"), {
        match: { journalId: posted.id, lineId: line?.id ?? "" },
      }),
    );
    expect(rules()).toHaveLength(0);
  });
});

describe("候補へのルールの組み込み（match → transfer → rule → none）", () => {
  it("学習したルールで、同じ内容の新しい明細の候補を作る（方法 rule、確信度、根拠、仕訳の案）", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" })]);
    approveWith("ショップ001");
    ctx.importRows([ctx.row({ content: "ショップ002", date: "2026-05-20", amount: -3300 })]);
    const built = unwrap(buildCandidates(ctx.deps));
    expect(built.needsAi).toEqual([]);

    const c = candidateOf(ctx.idOf("ショップ002"));
    expect(c).toMatchObject({
      method: "rule",
      purpose: "business",
      confidence: 60,
      ruleId: rules()[0]?.id,
    });
    expect(c?.reason).toContain("1 件");
    const draft = JSON.parse(c?.draftJson ?? "null") as JournalDraft;
    expect(draft.date).toBe("2026-05-20");
    expect(draft.lines.find((l) => l.side === "debit")).toMatchObject({
      accountId: ctx.a.rent,
      amount: 3300,
    });
    // 承認すると、直した内容ではなく候補どおりに登録でき、hits が増える
    unwrap(approveCandidate(ctx.deps, ctx.idOf("ショップ002")));
    expect(rules()[0]?.hits).toBe(2);
  });

  it("直して承認した後は、直した内容で次の候補が作られる", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" })]);
    approveWith("ショップ001", ctx.a.rent);
    ctx.importRows([ctx.row({ content: "ショップ002", date: "2026-05-11" })]);
    unwrap(buildCandidates(ctx.deps));
    const second = ctx.idOf("ショップ002");
    unwrap(
      approveCandidate(ctx.deps, second, {
        draft: ctx.shapeDraft(second, "business", ctx.a.supplies),
      }),
    );
    ctx.importRows([ctx.row({ content: "ショップ003", date: "2026-05-12" })]);
    unwrap(buildCandidates(ctx.deps));
    const c = candidateOf(ctx.idOf("ショップ003"));
    expect(c?.method).toBe("rule");
    expect(c?.confidence).toBe(50 + 10 * 1 - 20 * 1); // hits 1 + overrides 1 → 40
    expect(
      (JSON.parse(c?.draftJson ?? "null") as JournalDraft).lines.some(
        (l) => l.accountId === ctx.a.supplies,
      ),
    ).toBe(true);
  });

  it("ルールの変更・承認で、同じ内容の未処理の候補（rule・none）を作り直す", () => {
    ctx.importRows([
      ctx.row({ content: "ショップ001" }),
      ctx.row({ content: "ショップ002", date: "2026-05-11" }),
    ]);
    unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf("ショップ002"))?.method).toBe("none");
    approveWith("ショップ001");
    expect(candidateOf(ctx.idOf("ショップ002"))?.method).toBe("rule");
    const rule = rules()[0];
    unwrap(updateRule(ctx.deps, rule?.id ?? "", { counterAccountId: ctx.a.supplies }));
    const draft = JSON.parse(
      candidateOf(ctx.idOf("ショップ002"))?.draftJson ?? "null",
    ) as JournalDraft;
    expect(draft.lines.some((l) => l.accountId === ctx.a.supplies)).toBe(true);
    unwrap(pauseRule(ctx.deps, rule?.id ?? ""));
    expect(candidateOf(ctx.idOf("ショップ002"))?.method).toBe("none");
  });

  it("口座のルールを優先し、停止中のルールは使わず、別の口座のルールは使わない", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" })]);
    approveWith("ショップ001");
    ctx.importRows([
      ctx.row({ content: "ショップ002", date: "2026-05-11" }),
      ctx.row({ content: "ショップ003", date: "2026-05-11", accountName: "テストカードA" }),
    ]);
    unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf("ショップ002"))?.method).toBe("rule");
    expect(candidateOf(ctx.idOf("ショップ003"))?.method).toBe("none"); // 銀行のルールはカードに使わない
    unwrap(pauseRule(ctx.deps, rules()[0]?.id ?? ""));
    unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf("ショップ002"))?.method).toBe("none");
  });

  it("私用の判定のルールは、事業の口座では事業主貸の案、私用の口座では候補なし（AI に回さない）", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" })]);
    const id = ctx.idOf("ショップ001");
    unwrap(approveCandidate(ctx.deps, id, { draft: ctx.shapeDraft(id, "private") }));
    // 私用の判定のルールをすべての口座に広げる（編集ではなく、初期作成相当）
    ctx.uow.statements.state.rules[0] = {
      ...(rules()[0] as NonNullable<ReturnType<typeof rules>[0]>),
      statementAccountId: null,
    };
    ctx.importRows([
      ctx.row({ content: "ショップ002", date: "2026-05-11" }),
      ctx.row({ content: "ショップ003", date: "2026-05-11", accountName: "テスト現金" }),
    ]);
    const built = unwrap(buildCandidates(ctx.deps));
    const bank = candidateOf(ctx.idOf("ショップ002"));
    expect(bank).toMatchObject({ method: "rule", purpose: "private" });
    expect(
      (JSON.parse(bank?.draftJson ?? "null") as JournalDraft).lines.some(
        (l) => l.accountId === ctx.a.drawing,
      ),
    ).toBe(true);
    expect(candidateOf(ctx.idOf("ショップ003"))?.method).toBe("none");
    expect(built.needsAi).not.toContain(ctx.idOf("ショップ003"));
  });

  it("相手の科目が使用停止になったルールは使わない", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" })]);
    approveWith("ショップ001");
    const acc = ctx.masters.getAccount(ctx.a.rent);
    if (acc === undefined) throw new Error("科目がない");
    ctx.masters.updateAccount({ ...acc, isActive: false });
    ctx.importRows([ctx.row({ content: "ショップ002", date: "2026-05-11" })]);
    unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf("ショップ002"))?.method).toBe("none");
  });
});

describe("対のない引落: ルールでカードが決まれば transfer の候補", () => {
  const CARD_CONTENT = "カード引落 テストカードA";
  const cardSub = () => {
    const sub = {
      id: "sub-card-a",
      accountId: ctx.a.payable,
      name: "テストカードA",
      isActive: true,
    };
    ctx.masters.insertSubAccount(sub);
    return sub;
  };
  const payment = (date: string) =>
    ctx.row({ content: CARD_CONTENT, date, amount: -50_000, transferFlag: true });

  it("ルールがなければ none（AI に回す）", () => {
    ctx.importRows([payment("2026-06-10")]);
    const built = unwrap(buildCandidates(ctx.deps));
    expect(candidateOf(ctx.idOf(CARD_CONTENT))?.method).toBe("none");
    expect(built.needsAi).toEqual([ctx.idOf(CARD_CONTENT)]);
  });

  it("未払金（カードの補助科目）を相手にするルールがあれば、借 未払金 / 貸 普通預金 の transfer の候補にする", () => {
    const sub = cardSub();
    ctx.importRows([payment("2026-05-10")]);
    const first = ctx.idOf(CARD_CONTENT);
    unwrap(
      approveCandidate(ctx.deps, first, {
        draft: {
          date: "2026-05-10",
          memo: CARD_CONTENT,
          lines: [
            {
              side: "debit",
              accountId: ctx.a.payable,
              subAccountId: sub.id,
              amount: 50_000,
              taxCategory: "OUT_OF_SCOPE",
            },
            { side: "credit", accountId: ctx.a.bank, amount: 50_000, taxCategory: "OUT_OF_SCOPE" },
          ],
        },
      }),
    );
    expect(rules()[0]).toMatchObject({
      counterAccountId: ctx.a.payable,
      counterSubAccountId: sub.id,
    });

    ctx.importRows([payment("2026-06-10")]);
    const built = unwrap(buildCandidates(ctx.deps));
    const second = ctx.statements().find((s) => s.date === "2026-06-10");
    const c = candidateOf(second?.id ?? "");
    expect(c).toMatchObject({ method: "transfer", purpose: "business", confidence: 60 });
    const draft = JSON.parse(c?.draftJson ?? "null") as JournalDraft;
    expect(draft.lines).toEqual([
      {
        side: "debit",
        accountId: ctx.a.payable,
        subAccountId: sub.id,
        amount: 50_000,
        taxCategory: "OUT_OF_SCOPE",
      },
      { side: "credit", accountId: ctx.a.bank, amount: 50_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
    expect(built.needsAi).not.toContain(second?.id);
    // 承認できる
    unwrap(approveCandidate(ctx.deps, second?.id ?? ""));
    expect(ctx.activeLinks(second?.id)).toHaveLength(1);
  });

  it("相手が未払金でないルールなら、通常のルールの候補（method rule）のまま", () => {
    ctx.importRows([payment("2026-05-10")]);
    approveWith(CARD_CONTENT, ctx.a.supplies);
    ctx.importRows([payment("2026-06-10")]);
    unwrap(buildCandidates(ctx.deps));
    const second = ctx.statements().find((s) => s.date === "2026-06-10");
    expect(candidateOf(second?.id ?? "")?.method).toBe("rule");
  });
});

describe("ルールの初期作成・一覧・編集・停止・再開・履歴", () => {
  const postExpense = (description: string, counterId = ctx.a.rent, date = "2026-03-01") =>
    unwrap(
      createJournal(ctx.ledgerDeps, {
        date,
        memo: "手入力",
        lines: [
          { side: "debit", accountId: counterId, amount: 1000, description },
          { side: "credit", accountId: ctx.a.bank, amount: 1000 },
        ],
      }),
    );

  it("dryRun は案だけを返して何も書かない。実行すると作り、同じキーのルールがあれば skipped", () => {
    postExpense("ショップ 001");
    postExpense("ショップ 002");
    postExpense("単発の店");

    const dry = unwrap(seedRulesFromJournals(ctx.deps, { dryRun: true }));
    expect(dry.created).toBe(1);
    expect(dry.rules?.map((r) => r.normalizedContent)).toEqual(["ショップ#"]);
    expect(rules()).toHaveLength(0);
    expect(history()).toHaveLength(0);

    const done = unwrap(seedRulesFromJournals(ctx.deps));
    expect(done).toMatchObject({ created: 1, skipped: 0 });
    expect(rules()[0]).toMatchObject({
      normalizedContent: "ショップ#",
      statementAccountId: null,
      origin: "seed",
      managedBy: "auto",
      hits: 2,
      counterAccountId: ctx.a.rent,
    });
    expect(history().map((h) => h.action)).toEqual(["create"]);
    expect(ctx.uow.statements.audits.some((a) => a.action === "seed")).toBe(true);

    const again = unwrap(seedRulesFromJournals(ctx.deps));
    expect(again).toMatchObject({ created: 0, skipped: 1 });
    expect(rules()).toHaveLength(1);
  });

  it("初期作成のルールで、まだ口座のルールがない明細の候補を作れる。口座別のルールが優先される", () => {
    postExpense("ショップ 001");
    postExpense("ショップ 002");
    unwrap(seedRulesFromJournals(ctx.deps));
    ctx.importRows([ctx.row({ content: "ショップ777", date: "2026-05-11" })]);
    unwrap(buildCandidates(ctx.deps));
    const c = candidateOf(ctx.idOf("ショップ777"));
    expect(c).toMatchObject({ method: "rule", confidence: 70 });
    expect(c?.reason).toContain("2 件");
  });

  it("managedBy が user のルールは seedRulesFromJournals で変えない（同じ内容があれば飛ばす）", () => {
    postExpense("ショップ 001");
    postExpense("ショップ 002");
    unwrap(seedRulesFromJournals(ctx.deps));
    const id = rules()[0]?.id ?? "";
    unwrap(pauseRule(ctx.deps, id));
    unwrap(updateRule(ctx.deps, id, { counterAccountId: ctx.a.supplies }));
    const before = structuredClone(rules());
    for (let i = 3; i <= 10; i++) postExpense(`ショップ 00${i}`, ctx.a.supplies);
    const again = unwrap(seedRulesFromJournals(ctx.deps));
    expect(again).toMatchObject({ created: 0, skipped: 1 });
    expect(rules()).toEqual(before);
    expect(rules()[0]).toMatchObject({ managedBy: "user", status: "paused" });
  });

  it("listRules は status で絞り込める。確信度つき", () => {
    postExpense("ショップ 001");
    postExpense("ショップ 002");
    unwrap(seedRulesFromJournals(ctx.deps));
    const id = rules()[0]?.id ?? "";
    expect(unwrap(listRules(ctx.deps))[0]).toMatchObject({ id, confidence: 70, status: "active" });
    unwrap(pauseRule(ctx.deps, id));
    expect(unwrap(listRules(ctx.deps, { status: "active" }))).toEqual([]);
    expect(unwrap(listRules(ctx.deps, { status: "paused" }))).toHaveLength(1);
  });

  it("updateRule は内容を直し（hits・overrides は変えない）、履歴 edit と監査を残す。変更がなければ何も書かない", () => {
    postExpense("ショップ 001");
    postExpense("ショップ 002");
    unwrap(seedRulesFromJournals(ctx.deps));
    const id = rules()[0]?.id ?? "";
    const partner = ctx.addPartner();
    const updated = unwrap(
      updateRule(ctx.deps, id, {
        counterAccountId: ctx.a.supplies,
        partnerId: partner.id,
        purpose: "business",
        descriptionTemplate: "消耗品",
      }),
    );
    expect(updated).toMatchObject({
      counterAccountId: ctx.a.supplies,
      partnerId: partner.id,
      descriptionTemplate: "消耗品",
      hits: 2,
      overrides: 0,
    });
    expect(history().map((h) => h.action)).toEqual(["create", "edit"]);
    expect(history()[1]).toMatchObject({ statementId: null });
    const before = history().length;
    unwrap(updateRule(ctx.deps, id, { counterAccountId: ctx.a.supplies }));
    expect(history()).toHaveLength(before);
  });

  it("updateRule の検査: ルールがない、科目がない・使用停止、補助科目が別の科目のもの、取引先がない", () => {
    postExpense("ショップ 001");
    postExpense("ショップ 002");
    unwrap(seedRulesFromJournals(ctx.deps));
    const id = rules()[0]?.id ?? "";
    expect(codeOf(updateRule(ctx.deps, "nope", {}))).toBe("INFERENCE_RULE_NOT_FOUND");
    expect(codeOf(updateRule(ctx.deps, id, { counterAccountId: "nope" }))).toBe(
      "ACCOUNT_NOT_FOUND",
    );
    const acc = ctx.masters.getAccount(ctx.a.supplies);
    if (acc === undefined) throw new Error("科目がない");
    ctx.masters.updateAccount({ ...acc, isActive: false });
    expect(codeOf(updateRule(ctx.deps, id, { counterAccountId: ctx.a.supplies }))).toBe(
      "ACCOUNT_INACTIVE",
    );
    expect(codeOf(updateRule(ctx.deps, id, { counterSubAccountId: "nope" }))).toBe("VALIDATION");
    expect(codeOf(updateRule(ctx.deps, id, { partnerId: "nope" }))).toBe("VALIDATION");
    expect(rules()[0]?.counterAccountId).toBe(ctx.a.rent);
  });

  it("pause・resume は状態を切り替え、履歴と監査を残す。すでにその状態なら何も書かない。ない ID は 404", () => {
    postExpense("ショップ 001");
    postExpense("ショップ 002");
    unwrap(seedRulesFromJournals(ctx.deps));
    const id = rules()[0]?.id ?? "";
    expect(unwrap(pauseRule(ctx.deps, id)).status).toBe("paused");
    unwrap(pauseRule(ctx.deps, id));
    expect(unwrap(resumeRule(ctx.deps, id)).status).toBe("active");
    unwrap(resumeRule(ctx.deps, id));
    expect(history().map((h) => h.action)).toEqual(["create", "pause", "resume"]);
    expect(codeOf(pauseRule(ctx.deps, "nope"))).toBe("INFERENCE_RULE_NOT_FOUND");
    expect(codeOf(resumeRule(ctx.deps, "nope"))).toBe("INFERENCE_RULE_NOT_FOUND");
  });

  it("ruleHistory は追記の順で、before・after をオブジェクトにして返す。ない ID は 404", () => {
    ctx.importRows([ctx.row({ content: "ショップ001" })]);
    approveWith("ショップ001");
    const id = rules()[0]?.id ?? "";
    unwrap(pauseRule(ctx.deps, id));
    const h = unwrap(ruleHistory(ctx.deps, id));
    expect(h.map((x) => x.action)).toEqual(["create", "pause"]);
    expect(h[0]).toMatchObject({ before: null, statementId: ctx.idOf("ショップ001") });
    expect(h[1]?.before).toMatchObject({ status: "active" });
    expect(h[1]?.after).toMatchObject({ status: "paused" });
    expect(codeOf(ruleHistory(ctx.deps, "nope"))).toBe("INFERENCE_RULE_NOT_FOUND");
  });
});

// ---- 性質: INV-41・INV-47 ----

const rowsArb = fc.array(pastedRowArb, { minLength: 1, maxLength: 6 });
const idxArb = fc.nat({ max: 20 });

const trialBalance = (c: StatementsCtx) => {
  const sums = new Map<string, number>();
  for (const j of c.ledger.state.journals) {
    if (j.status !== "active") continue;
    for (const l of j.lines) {
      sums.set(`${l.accountId}:${l.side}`, (sums.get(`${l.accountId}:${l.side}`) ?? 0) + l.amount);
    }
  }
  return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b));
};

describe("INV-41: ルールの更新を含め、承認以外の操作列で帳簿は変わらない", () => {
  type Op =
    | { kind: "build" }
    | { kind: "seed"; dryRun: boolean }
    | { kind: "update"; idx: number; supplies: boolean }
    | { kind: "pause"; idx: number }
    | { kind: "resume"; idx: number }
    | { kind: "exclude"; idx: number }
    | { kind: "unexclude"; idx: number }
    | { kind: "ack"; idx: number };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.constant({ kind: "build" as const }),
    fc.record({ kind: fc.constant("seed" as const), dryRun: fc.boolean() }),
    fc.record({ kind: fc.constant("update" as const), idx: idxArb, supplies: fc.boolean() }),
    fc.record({ kind: fc.constant("pause" as const), idx: idxArb }),
    fc.record({ kind: fc.constant("resume" as const), idx: idxArb }),
    fc.record({ kind: fc.constant("exclude" as const), idx: idxArb }),
    fc.record({ kind: fc.constant("unexclude" as const), idx: idxArb }),
    fc.record({ kind: fc.constant("ack" as const), idx: idxArb }),
  );

  it("取込・候補の作成・ルールの作成と更新・停止・再開・除外の列の後も、仕訳帳と試算表は変わらない", () => {
    fc.assert(
      fc.property(
        rowsArb,
        rowsArb,
        fc.array(opArb, { minLength: 1, maxLength: 12 }),
        (rows, more, ops) => {
          const c = setupStatements();
          c.mapAll();
          c.importRows(rows);
          // 帳簿に仕訳とルールがある状態にしておく
          for (const s of c.statements().slice(0, 3)) {
            approveCandidate(c.deps, s.id, { draft: c.shapeDraft(s.id, "business") });
          }
          createJournal(c.ledgerDeps, {
            date: "2026-03-01",
            lines: [
              { side: "debit", accountId: c.a.rent, amount: 1000, description: "店X" },
              { side: "credit", accountId: c.a.bank, amount: 1000 },
            ],
          });
          const journalsBefore = structuredClone(c.ledger.state.journals);
          const trialBefore = trialBalance(c);
          c.importRows(more);
          for (const op of ops) {
            const all = c.statements();
            const target =
              all.length === 0 ? undefined : all[("idx" in op ? op.idx : 0) % all.length];
            const rs = c.uow.statements.state.rules;
            const rule = rs.length === 0 ? undefined : rs[("idx" in op ? op.idx : 0) % rs.length];
            switch (op.kind) {
              case "build":
                buildCandidates(c.deps, undefined, { rebuild: true });
                break;
              case "seed":
                seedRulesFromJournals(c.deps, { dryRun: op.dryRun });
                break;
              case "update":
                if (rule)
                  updateRule(c.deps, rule.id, {
                    counterAccountId: op.supplies ? c.a.supplies : c.a.rent,
                  });
                break;
              case "pause":
                if (rule) pauseRule(c.deps, rule.id);
                break;
              case "resume":
                if (rule) resumeRule(c.deps, rule.id);
                break;
              case "exclude":
                if (target) excludeStatement(c.deps, target.id, {});
                break;
              case "unexclude":
                if (target) unexcludeStatement(c.deps, target.id, { reason: "戻す" });
                break;
              case "ack":
                if (target) {
                  c.uow.statements.markStatementChanged(target.id, JSON.stringify({ amount: 1 }));
                  acknowledgeChange(c.deps, target.id);
                }
                break;
            }
          }
          expect(c.ledger.state.journals).toEqual(journalsBefore);
          expect(trialBalance(c)).toEqual(trialBefore);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("INV-47（ルールの側）: 承認とルールの更新は全部か無か", () => {
  it("任意の書き込みで失敗させると、仕訳・結びつき・ルール・履歴・監査のどれも残らない。成功すれば registered かつルールがある", () => {
    let injected = 0;
    let succeeded = 0;
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 30 }),
        (existingRule, differs, failAt) => {
          let injector: FaultInjectingStatementUnitOfWork | undefined;
          const c = setupStatements({
            wrap: (inner) => {
              injector = new FaultInjectingStatementUnitOfWork(inner);
              return injector;
            },
          });
          c.mapAll();
          c.importRows([
            c.row({ content: "ショップ001" }),
            c.row({ content: "ショップ002", date: "2026-05-11" }),
            c.row({ content: "ショップ003", date: "2026-05-12" }),
          ]);
          if (existingRule) {
            unwrap(
              approveCandidate(c.deps, c.idOf("ショップ001"), {
                draft: c.shapeDraft(c.idOf("ショップ001"), "business"),
              }),
            );
          }
          unwrap(buildCandidates(c.deps));
          const target = c.idOf("ショップ002");
          const draft = c.shapeDraft(target, "business", differs ? c.a.supplies : c.a.rent);
          if (injector === undefined) throw new Error("injector");
          const before = snapshotOf(c.uow);
          injector.failAt = failAt;
          let result: ReturnType<typeof approveCandidate> | undefined;
          let thrown = false;
          try {
            result = approveCandidate(c.deps, target, { draft });
          } catch {
            thrown = true;
          }
          injector.failAt = null;
          if (thrown || result?.ok !== true) {
            if (thrown) injected += 1;
            expect(snapshotOf(c.uow)).toEqual(before);
          } else {
            succeeded += 1;
            const view = unwrap(listStatements(c.deps)).find((v) => v.id === target);
            expect(view?.status).toBe("registered");
            const rule = c.uow.statements.state.rules.find(
              (r) => r.normalizedContent === normalizeContent("ショップ002"),
            );
            expect(rule).toBeDefined();
            expect(rule?.counterAccountId).toBe(differs ? c.a.supplies : c.a.rent);
            expect(c.uow.statements.state.ruleHistory.some((h) => h.ruleId === rule?.id)).toBe(
              true,
            );
          }
        },
      ),
      { numRuns: 80 },
    );
    expect(injected).toBeGreaterThan(0);
    expect(succeeded).toBeGreaterThan(0);
  });
});
