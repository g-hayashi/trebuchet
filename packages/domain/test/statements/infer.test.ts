import { beforeEach, describe, expect, it } from "vitest";
import { buildAiPayload } from "../../src/statements/mask.ts";
import type { PastedRow } from "../../src/statements/paste.ts";
import type { JournalDraft } from "../../src/types.ts";
import { type DomainError, domainError, err, ok, type Result } from "../../src/types.ts";
import { type InferenceDeps, inferWithAi } from "../../src/usecases/inference.ts";
import {
  buildCandidates,
  commitStatementImport,
  previewStatementImport,
  saveStatementAccount,
  saveStatementSettings,
} from "../../src/usecases/statements.ts";
import { FakeSuggestionProvider, fakeStatementUnitOfWork } from "../fakes.ts";
import { setupBase } from "../ledger-setup.ts";
import { formatMfmePaste } from "../statements-arbitraries.ts";

// 006 T024（R8、FR-025〜028）。端末内 → 外部の順、しきい値、外部に渡る内容、候補の保存

function setup() {
  const base = setupBase();
  const uow = fakeStatementUnitOfWork(base.ledger, base.masters);
  const local = new FakeSuggestionProvider({ available: true });
  const external = new FakeSuggestionProvider({ available: true });
  const deps: InferenceDeps = {
    uow,
    clock: base.clock,
    local,
    external,
    externalEnabled: true,
    models: { local: "local-model", external: "external-model" },
  };
  const statementDeps = { uow, ids: base.ids, clock: base.clock };
  return {
    ...base,
    uow,
    deps,
    statementDeps,
    local,
    external,
    bank: base.accountId("普通預金"),
    rentCode: base.masters.listAccounts().find((a) => a.name === "地代家賃")?.code ?? "",
    shaSeq: 0,
  };
}
type Ctx = ReturnType<typeof setup>;

let ctx: Ctx;
beforeEach(() => {
  ctx = setup();
});

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const errorOf = <T>(r: Result<T>): DomainError => {
  if (r.ok) throw new Error("成功した");
  return r.error;
};

const mapAccount = (name: string, over: Record<string, unknown> = {}) =>
  unwrap(
    saveStatementAccount(ctx.statementDeps, name, {
      usage: "business",
      kind: "bank",
      accountId: ctx.bank,
      ...over,
    } as never),
  );
const mapBank = () => mapAccount("サンプル銀行");
const mapPrivate = () =>
  mapAccount("テスト現金", { kind: "cash", usage: "private", accountId: undefined });

const row = (over: Partial<PastedRow> = {}): PastedRow => ({
  accountName: "サンプル銀行",
  date: "2026-05-10",
  content: "ショップ001",
  amount: -1200,
  transferFlag: false,
  ...over,
});

/** 取り込んで候補を作る（ルールがないので none） */
const importRows = (rows: PastedRow[]) => {
  ctx.shaSeq += 1;
  const sha256 = ctx.shaSeq.toString(16).padStart(64, "0");
  const source = { kind: "paste" as const, text: formatMfmePaste(rows), year: 2026 };
  const preview = unwrap(previewStatementImport(ctx.statementDeps, { source, sha256 }));
  unwrap(
    commitStatementImport(ctx.statementDeps, {
      source,
      sha256,
      expected: { inputSha256: sha256, countNew: preview.countNew },
    }),
  );
  unwrap(buildCandidates(ctx.statementDeps));
};

const idOf = (content: string) => {
  const s = ctx.uow.statements.listStatements().find((x) => x.content === content);
  if (s === undefined) throw new Error(`明細がない: ${content}`);
  return s.id;
};
const candidateOf = (id: string) =>
  ctx.uow.statements.listStatementCandidates().find((c) => c.statementId === id);

const suggestion = (over: Record<string, unknown> = {}) => ({
  accountCode: ctx.rentCode,
  taxCategory: "PURCHASE_10",
  purpose: "business",
  confidence: 80,
  reason: "同じ種類の店",
  ...over,
});
const respond = (p: FakeSuggestionProvider, over: Record<string, unknown> = {}) =>
  p.respondWith(ok(suggestion(over)));

describe("inferWithAi: 端末内 → 外部（R8）", () => {
  it("端末内が使えて確信度がしきい値以上なら、端末内の候補にする（外部は呼ばない）", async () => {
    mapBank();
    importRows([row()]);
    respond(ctx.local, { confidence: 70 });
    const id = idOf("ショップ001");
    const r = unwrap(await inferWithAi(ctx.deps, [id]));
    expect(r).toEqual({
      results: [{ statementId: id, method: "local_ai", confidence: 70 }],
      localAvailable: true,
      externalUsed: false,
    });
    expect(ctx.external.calls).toHaveLength(0);
    const c = candidateOf(id);
    expect(c).toMatchObject({
      method: "local_ai",
      purpose: "business",
      confidence: 70,
      reason: "同じ種類の店",
      ruleId: null,
      model: "local-model",
    });
    const draft = JSON.parse(c?.draftJson ?? "null") as JournalDraft;
    expect(draft.lines.map((l) => ({ side: l.side, amount: l.amount }))).toEqual([
      { side: "debit", amount: 1200 },
      { side: "credit", amount: 1200 },
    ]);
    expect(draft.lines[0]).toMatchObject({ taxCategory: "PURCHASE_10" });
    expect(draft.lines[1]?.accountId).toBe(ctx.bank);
  });

  it("確信度がしきい値ちょうどなら端末内のまま。しきい値の設定（T014）を読む", async () => {
    mapBank();
    importRows([row({ content: "店A" }), row({ content: "店B" })]);
    respond(ctx.local, { confidence: 60 });
    await inferWithAi(ctx.deps, [idOf("店A")]);
    expect(ctx.external.calls).toHaveLength(0);

    unwrap(saveStatementSettings(ctx.statementDeps, { bulkThreshold: 80, externalThreshold: 90 }));
    respond(ctx.local, { confidence: 80 });
    respond(ctx.external, { confidence: 95 });
    const r = unwrap(await inferWithAi(ctx.deps, [idOf("店B")]));
    expect(ctx.external.calls).toHaveLength(1);
    expect(r.externalUsed).toBe(true);
    expect(candidateOf(idOf("店B"))).toMatchObject({
      method: "external_ai",
      confidence: 95,
      model: "external-model",
    });
  });

  it("端末内の確信度がしきい値未満で外部が有効なら、外部の結果にする", async () => {
    mapBank();
    importRows([row()]);
    respond(ctx.local, { confidence: 59 });
    respond(ctx.external, { confidence: 85, reason: "外部の根拠" });
    const id = idOf("ショップ001");
    const r = unwrap(await inferWithAi(ctx.deps, [id]));
    expect(r.results).toEqual([{ statementId: id, method: "external_ai", confidence: 85 }]);
    expect(r).toMatchObject({ localAvailable: true, externalUsed: true });
    expect(candidateOf(id)).toMatchObject({ method: "external_ai", reason: "外部の根拠" });
  });

  it("端末内の確信度が低くても外部が無効なら、端末内の結果のまま", async () => {
    mapBank();
    importRows([row()]);
    respond(ctx.local, { confidence: 10 });
    const id = idOf("ショップ001");
    ctx.deps.externalEnabled = false;
    const r = unwrap(await inferWithAi(ctx.deps, [id]));
    expect(r.results).toEqual([{ statementId: id, method: "local_ai", confidence: 10 }]);
    expect(r.externalUsed).toBe(false);
    expect(ctx.external.calls).toHaveLength(0);
  });

  it("外部の出力が使えないときは、端末内の結果を残す", async () => {
    mapBank();
    importRows([row()]);
    respond(ctx.local, { confidence: 10 });
    respond(ctx.external, { accountCode: "9999" });
    const id = idOf("ショップ001");
    const r = unwrap(await inferWithAi(ctx.deps, [id]));
    expect(r.results[0]).toEqual({ statementId: id, method: "local_ai", confidence: 10 });
    expect(r.externalUsed).toBe(true);
  });

  it("端末内が使えず外部が有効なら、外部へ送る", async () => {
    mapBank();
    importRows([row()]);
    ctx.local.setAvailable(false);
    respond(ctx.external);
    const id = idOf("ショップ001");
    const r = unwrap(await inferWithAi(ctx.deps, [id]));
    expect(r).toEqual({
      results: [{ statementId: id, method: "external_ai", confidence: 80 }],
      localAvailable: false,
      externalUsed: true,
    });
    expect(ctx.local.calls).toHaveLength(0);
  });

  it("端末内の出力が使えない（科目が一覧にない・エラー）ときも、外部が有効なら外部へ", async () => {
    mapBank();
    importRows([row({ content: "店A" }), row({ content: "店B" })]);
    respond(ctx.local, { accountCode: "9999" });
    respond(ctx.external);
    const a = unwrap(await inferWithAi(ctx.deps, [idOf("店A")]));
    expect(a.results[0]?.method).toBe("external_ai");
    ctx.local.respondWith(err(domainError("VALIDATION", "接続できません")));
    const b = unwrap(await inferWithAi(ctx.deps, [idOf("店B")]));
    expect(b.results[0]?.method).toBe("external_ai");
  });

  it("どちらも使えない・使えない出力なら none（候補に理由を残す。外部が無効なら外部を呼ばない）", async () => {
    mapBank();
    importRows([row({ content: "店A" }), row({ content: "店B" })]);
    ctx.local.setAvailable(false);
    ctx.deps.externalEnabled = false;
    const a = unwrap(await inferWithAi(ctx.deps, [idOf("店A")]));
    expect(a).toEqual({
      results: [{ statementId: idOf("店A"), method: "none", confidence: null }],
      localAvailable: false,
      externalUsed: false,
    });
    expect(ctx.local.calls).toHaveLength(0);
    expect(ctx.external.calls).toHaveLength(0);
    expect(candidateOf(idOf("店A"))?.method).toBe("none");

    // 外部が有効でも、接続先の設定がそろっていない（available が false）なら呼ばない
    ctx.deps.externalEnabled = true;
    ctx.external.setAvailable(false);
    const b = unwrap(await inferWithAi(ctx.deps, [idOf("店B")]));
    expect(b.results[0]?.method).toBe("none");
    expect(ctx.external.calls).toHaveLength(0);

    // 出力が使えなければ none。理由に失敗の内容を残す
    ctx.local.setAvailable(true);
    respond(ctx.local, { taxCategory: "UNKNOWN" });
    const c = unwrap(await inferWithAi(ctx.deps, [idOf("店B")]));
    expect(c.results[0]).toEqual({ statementId: idOf("店B"), method: "none", confidence: null });
    const saved = candidateOf(idOf("店B"));
    expect(saved).toMatchObject({
      method: "none",
      purpose: null,
      confidence: null,
      draftJson: null,
    });
    expect(saved?.reason).not.toBe("");
  });

  it("外部に渡るのは buildAiPayload の結果だけ（口座の名前・メモ・明細の ID・数字の並び・名義を含まない）", async () => {
    mapBank();
    importRows([
      row({ content: "振込 ヤマダ タロウ 1234567" }),
      row({ content: "カード 4111111111111111" }),
    ]);
    ctx.local.setAvailable(false);
    respond(ctx.external);
    const ids = [idOf("振込 ヤマダ タロウ 1234567"), idOf("カード 4111111111111111")];
    unwrap(await inferWithAi(ctx.deps, ids));
    expect(ctx.external.calls).toHaveLength(2);
    const account = ctx.uow.statements.listStatementAccounts()[0];
    for (const [i, id] of ids.entries()) {
      const record = ctx.uow.statements.listStatements().find((s) => s.id === id);
      if (record === undefined || account === undefined) throw new Error("fixture");
      expect(ctx.external.calls[i]?.payload).toEqual(buildAiPayload(record, account));
      const sent = JSON.stringify(ctx.external.calls[i]);
      for (const secret of [account.name, id, record.stableKey, "ヤマダ", "1234567", "4111111"]) {
        expect(sent).not.toContain(secret);
      }
    }
    // 文脈は相手になりうる科目（コードと名前）と税区分のコードだけ
    const context = ctx.external.calls[0]?.context as {
      accounts: { code: string; name: string }[];
      taxCategories: string[];
    };
    expect(context.accounts.some((a) => a.code === ctx.rentCode)).toBe(true);
    expect(context.accounts.every((a) => Object.keys(a).sort().join() === "code,name")).toBe(true);
    expect(context.accounts.map((a) => a.name)).not.toContain("事業主借");
    expect(context.taxCategories).toContain("PURCHASE_10");
  });
});

describe("inferWithAi: 対象と保存", () => {
  it("none でない候補（ルール・既存の仕訳・振替）の明細は AI を呼ばず、今の候補をそのまま返す", async () => {
    mapBank();
    importRows([row()]);
    const id = idOf("ショップ001");
    ctx.uow.statements.upsertStatementCandidate({
      statementId: id,
      method: "rule",
      purpose: "business",
      confidence: 75,
      reason: "過去の同じ内容",
      draftJson: JSON.stringify({ date: "2026-05-10", lines: [] }),
      ruleId: null,
      model: null,
      createdAt: "2026-05-10T00:00:00.000Z",
    });
    respond(ctx.local);
    const r = unwrap(await inferWithAi(ctx.deps, [id]));
    expect(r.results).toEqual([{ statementId: id, method: "rule", confidence: 75 }]);
    expect(ctx.local.calls).toHaveLength(0);
    expect(candidateOf(id)?.method).toBe("rule");
  });

  it("除外した明細・0 円の明細は AI を呼ばない", async () => {
    mapBank();
    importRows([row({ content: "除外する" }), row({ content: "ゼロ", amount: 0 })]);
    const excluded = idOf("除外する");
    ctx.uow.statements.setStatementExcluded(excluded, {
      at: "2026-05-11T00:00:00.000Z",
      reason: null,
    });
    respond(ctx.local);
    const r = unwrap(await inferWithAi(ctx.deps, [excluded, idOf("ゼロ")]));
    expect(r.results.map((x) => x.method)).toEqual(["none", "none"]);
    expect(ctx.local.calls).toHaveLength(0);
  });

  it("未知の明細の ID は STATEMENT_NOT_FOUND（何も書かない）", async () => {
    mapBank();
    importRows([row()]);
    respond(ctx.local);
    const e = errorOf(await inferWithAi(ctx.deps, [idOf("ショップ001"), "missing"]));
    expect(e.code).toBe("STATEMENT_NOT_FOUND");
    expect(ctx.local.calls).toHaveLength(0);
  });

  it("私用の口座: 私用の判定は仕訳にならない none、事業の判定は事業主貸・事業主借の行の案", async () => {
    mapPrivate();
    importRows([
      row({ accountName: "テスト現金", content: "私用の買い物" }),
      row({ accountName: "テスト現金", content: "事業の買い物" }),
    ]);
    respond(ctx.local, { purpose: "private" });
    const a = unwrap(await inferWithAi(ctx.deps, [idOf("私用の買い物")]));
    expect(a.results[0]?.method).toBe("none");
    expect(candidateOf(idOf("私用の買い物"))?.draftJson).toBeNull();

    respond(ctx.local, { purpose: "business" });
    const b = unwrap(await inferWithAi(ctx.deps, [idOf("事業の買い物")]));
    expect(b.results[0]?.method).toBe("local_ai");
    const draft = JSON.parse(
      candidateOf(idOf("事業の買い物"))?.draftJson ?? "null",
    ) as JournalDraft;
    const owner = ctx.masters.listAccounts().find((x) => x.name === "事業主借");
    expect(draft.lines.find((l) => l.side === "credit")?.accountId).toBe(owner?.id);
  });

  it("AI の待ちの間に状態が変わった明細（除外）は、結果を書かない", async () => {
    mapBank();
    importRows([row()]);
    const id = idOf("ショップ001");
    const racing = {
      async available() {
        return true;
      },
      async suggest() {
        ctx.uow.statements.setStatementExcluded(id, {
          at: "2026-05-11T00:00:00.000Z",
          reason: null,
        });
        return ok(suggestion());
      },
    };
    const r = unwrap(await inferWithAi({ ...ctx.deps, local: racing }, [id]));
    expect(candidateOf(id)?.method).toBe("none");
    expect(r.results).toEqual([{ statementId: id, method: "none", confidence: null }]);
  });

  it("仕訳・帳簿は変えない（INV-41）", async () => {
    mapBank();
    importRows([row()]);
    respond(ctx.local);
    const before = ctx.ledger.findJournals({ limit: 500 }).items.length;
    await inferWithAi(ctx.deps, [idOf("ショップ001")]);
    expect(ctx.ledger.findJournals({ limit: 500 }).items.length).toBe(before);
  });
});
