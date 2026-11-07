import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
} from "./invoicing-helpers.ts";
import { importStatementLines } from "./statements-helpers.ts";

// 006 US2: contracts/http-api.md §4.1・§4.2・§4.4〜§4.9 と §6.3。候補 → 承認・除外・取消 → 設定

let tmp: TempDataDir;
let ctx: InvoicingTestContext;

beforeEach(async () => {
  tmp = useTempDataDir("server-statements-approve-api");
  ctx = await createInvoicingTestContext();
});
afterEach(() => tmp.cleanup());

const st = () => ctx.e.statements;
const stId = (statementId: string) => ({ param: { ...ctx.param, statementId } });

const line = (...cells: (string | number)[]) => cells.join("\t");

const mapAccount = async (name: string, accountName: string) => {
  const res = await ctx.e["statement-accounts"][":name"].$put({
    param: { ...ctx.param, name },
    json: { usage: "business", kind: "bank", accountId: ctx.accountId(accountName) },
  });
  expect(res.status).toBe(200);
};

/** 行（日付 `MM/DD(曜)`・内容・金額・口座）を貼り付けて取り込む */
const importLines = (...lines: string[]) => importStatementLines(st().imports, ctx.param, ...lines);

const list = async (query: Record<string, string> = {}) =>
  (await okBody(await st().$get({ param: ctx.param, query }))).statements;
const idOf = async (content: string) => {
  const found = (await list()).find((s) => s.content === content);
  if (found === undefined) throw new Error(`明細がない: ${content}`);
  return found.id;
};

const BANK = "サンプル銀行";
const SUPPLIES_DRAFT = (amount = 1_200, date = "2026-05-10") => ({
  date,
  memo: "文房具",
  lines: [
    { side: "debit" as const, accountId: ctx.accountId("消耗品費"), amount },
    { side: "credit" as const, accountId: ctx.accountId("普通預金"), amount },
  ],
});

const approve = (statementId: string, json: Record<string, unknown> = {}) =>
  st()[":statementId"].approve.$post({ ...stId(statementId), json });

const journalsList = async () =>
  (await okBody(await ctx.e.journals.$get({ param: ctx.param, query: {} }))).journals;

beforeEach(async () => {
  await mapAccount(BANK, "普通預金");
});

describe("一覧と候補（§4.1・§4.2）", () => {
  it("取り込んだ明細は未処理で候補なし。候補を作ると none（needsAi に入る）で、絞り込める", async () => {
    await importLines(
      line("05/10(日)", "文房具", "-1,200", BANK, "", 0),
      line("06/01(月)", "売上入金", "3,000", BANK, "", 0),
    );
    const all = await list();
    expect(all.map((s) => [s.content, s.status, s.candidate])).toEqual([
      ["売上入金", "unprocessed", null],
      ["文房具", "unprocessed", null],
    ]);
    const built = await okBody(await st().candidates.$post({ param: ctx.param, json: {} }));
    expect(built.built).toBe(2);
    expect(built.needsAi).toHaveLength(2);
    expect((await list()).every((s) => s.candidate?.method === "none")).toBe(true);
    expect((await list({ from: "2026-06-01" })).map((s) => s.content)).toEqual(["売上入金"]);
    expect(await list({ status: "registered" })).toEqual([]);
    expect(await list({ status: "changed" })).toEqual([]);
  });

  it("statementIds を渡すと、その明細だけ。知らない ID は 404 STATEMENT_NOT_FOUND", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const built = await okBody(
      await st().candidates.$post({
        param: ctx.param,
        json: { statementIds: [await idOf("文房具")] },
      }),
    );
    expect(built.built).toBe(1);
    const res = await st().candidates.$post({
      param: ctx.param,
      json: { statementIds: ["00000000-0000-7000-8000-000000000001"] },
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("STATEMENT_NOT_FOUND");
  });

  it("重複の疑い（口座・内容・金額が同じで 3 日以内）は duplicateOf に相手の ID が出る", async () => {
    await importLines(
      line("05/10(日)", "文房具", "-1,200", BANK, "", 0),
      line("05/11(月)", "文房具", "-1,200", BANK, "", 0),
    );
    const all = await list();
    expect(all).toHaveLength(2);
    expect(all[0]?.duplicateOf).toEqual([all[1]?.id]);
    expect(all[1]?.duplicateOf).toEqual([all[0]?.id]);
  });

  it("不正な絞り込み（status）は 400 VALIDATION", async () => {
    const res = await st().$get({ param: ctx.param, query: { status: "bogus" as "registered" } });
    expect(res.status).toBe(400);
  });
});

describe("承認（§4.4）", () => {
  it("直した案で承認 → 201。仕訳帳に source = statement の仕訳ができ、明細は registered、warnings を返す", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const id = await idOf("文房具");
    const res = await approve(id, { draft: SUPPLIES_DRAFT() });
    expect(res.status).toBe(201);
    const body = await okBody(res);
    expect(body.journal).toMatchObject({
      source: "statement",
      status: "active",
      date: "2026-05-10",
    });
    expect(body.link).toMatchObject({ statementId: id, kind: "created" });
    expect(body.pairLink).toBeNull();
    expect(Array.isArray(body.warnings)).toBe(true);

    const journals = await journalsList();
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({ source: "statement" });
    const view = (await list()).find((s) => s.id === id);
    expect(view).toMatchObject({ status: "registered" });
    expect(view?.links).toEqual([{ journalId: body.journal?.id, kind: "created" }]);
  });

  it("候補も案もなければ 400 VALIDATION。登録済みの再承認は 409 STATEMENT_ALREADY_REGISTERED", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const id = await idOf("文房具");
    const none = await approve(id);
    expect(none.status).toBe(400);
    expect((await errorOf(none)).code).toBe("VALIDATION");
    expect((await approve(id, { draft: SUPPLIES_DRAFT() })).status).toBe(201);
    const again = await approve(id, { draft: SUPPLIES_DRAFT() });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("STATEMENT_ALREADY_REGISTERED");
  });

  it("明細の口座の行の合計が明細の金額と違えば 422 STATEMENT_AMOUNT_MISMATCH（details.expected・actual）。何も登録しない", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const res = await approve(await idOf("文房具"), { draft: SUPPLIES_DRAFT(1_300) });
    expect(res.status).toBe(422);
    const e = await errorOf(res);
    expect(e.code).toBe("STATEMENT_AMOUNT_MISMATCH");
    expect(e.details).toEqual({ expected: -1200, actual: -1300 });
    expect(await journalsList()).toEqual([]);
  });

  it("貸借が合わない案は 400 VALIDATION か 422 UNBALANCED で、仕訳は増えない", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const draft = SUPPLIES_DRAFT();
    draft.lines[0] = { ...draft.lines[0], amount: 1_100 } as never;
    const res = await approve(await idOf("文房具"), { draft });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("UNBALANCED");
    expect(await journalsList()).toEqual([]);
  });

  it("締め済みの年度の日付は 409 PERIOD_CLOSED。明細は未処理のまま", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const closed = await ctx.e["fiscal-periods"][":year"].close.$post({
      param: { ...ctx.param, year: "2026" },
    });
    expect(closed.status).toBe(200);
    const id = await idOf("文房具");
    const res = await approve(id, { draft: SUPPLIES_DRAFT() });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("PERIOD_CLOSED");
    expect((await list()).find((s) => s.id === id)?.status).toBe("unprocessed");
  });

  it("知らない明細は 404 STATEMENT_NOT_FOUND", async () => {
    const res = await approve("00000000-0000-7000-8000-000000000001", {
      draft: SUPPLIES_DRAFT(),
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("STATEMENT_NOT_FOUND");
  });

  it("振替の対は、候補のまま承認すると 1 つの仕訳に両方が結びつく（pairLink）", async () => {
    await mapAccount("サブ口座", "現金");
    await importLines(
      line("05/10(日)", "口座間の移動", "-5,000", BANK, "", 1),
      line("05/10(日)", "口座間の移動", "5,000", "サブ口座", "", 1),
    );
    await okBody(await st().candidates.$post({ param: ctx.param, json: {} }));
    const out = (await list()).find((s) => s.amount === -5000);
    expect(out?.candidate).toMatchObject({ method: "transfer", purpose: "business" });
    const body = await okBody(await approve(out?.id as string));
    expect(body.pairLink).toMatchObject({ kind: "created" });
    expect(await journalsList()).toHaveLength(1);
    expect((await list()).map((s) => s.status)).toEqual(["registered", "registered"]);
  });

  it("仕訳を取り消すと unprocessed に戻り、もう一度承認できる", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const id = await idOf("文房具");
    const first = await okBody(await approve(id, { draft: SUPPLIES_DRAFT() }));
    const voided = await ctx.e.journals[":journalId"].void.$post({
      param: { ...ctx.param, journalId: first.journal?.id as string },
      json: { reason: "誤り", version: first.journal?.version as number },
    });
    expect(voided.status).toBe(200);
    expect((await list()).find((s) => s.id === id)?.status).toBe("unprocessed");
    const second = await approve(id, { draft: SUPPLIES_DRAFT() });
    expect(second.status).toBe(201);
    expect((await list()).find((s) => s.id === id)?.status).toBe("registered");
  });
});

describe("まとめて承認（§4.5）", () => {
  it("選んだ行を承認し、できなかったものは failed（code・message）に残す", async () => {
    await mapAccount("サブ口座", "現金");
    await importLines(
      line("05/10(日)", "口座間の移動", "-5,000", BANK, "", 1),
      line("05/10(日)", "口座間の移動", "5,000", "サブ口座", "", 1),
      line("05/12(火)", "文房具", "-1,200", BANK, "", 0),
    );
    await okBody(await st().candidates.$post({ param: ctx.param, json: {} }));
    const memo = await idOf("文房具");
    const res = await st()["approve-bulk"].$post({
      param: ctx.param,
      json: {
        items: [
          { statementId: (await list()).find((s) => s.amount === -5000)?.id as string },
          { statementId: memo },
          { statementId: "00000000-0000-7000-8000-000000000001" },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = await okBody(res);
    expect(body.approved).toHaveLength(2);
    expect(body.failed.map((f) => [f.statementId, f.code]).sort()).toEqual(
      [
        [memo, "VALIDATION"],
        ["00000000-0000-7000-8000-000000000001", "STATEMENT_NOT_FOUND"],
      ].sort(),
    );
    expect(body.failed.every((f) => f.message.length > 0)).toBe(true);
  });

  it("items が空なら何も承認しない。items を省く・threshold・statementIds の旧い形は 400", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const none = await okBody(
      await st()["approve-bulk"].$post({ param: ctx.param, json: { items: [] } }),
    );
    expect(none).toEqual({ approved: [], failed: [] });
    const missing = await st()["approve-bulk"].$post({ param: ctx.param, json: {} as never });
    expect(missing.status).toBe(400);
    const old = await st()["approve-bulk"].$post({
      param: ctx.param,
      json: { statementIds: [await idOf("文房具")] } as never,
    });
    expect(old.status).toBe(400);
  });

  it("draft で登録できる。件数の上限（500）を超えると 400", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const id = await idOf("文房具");
    const body = await okBody(
      await st()["approve-bulk"].$post({
        param: ctx.param,
        json: { items: [{ statementId: id, draft: SUPPLIES_DRAFT() }] },
      }),
    );
    expect(body).toMatchObject({ approved: [id], failed: [] });
    const many = Array.from({ length: 501 }, () => ({ statementId: id }));
    const over = await st()["approve-bulk"].$post({ param: ctx.param, json: { items: many } });
    expect(over.status).toBe(400);
  });
});

describe("選んだ行の除外（§4.5a）", () => {
  it("除外し、登録済み・不明は failed に残す。statementIds が空なら何もしない", async () => {
    await importLines(
      line("05/10(日)", "文房具", "-1,200", BANK, "", 0),
      line("05/11(月)", "私用の買い物", "-500", BANK, "", 0),
      line("05/12(火)", "家賃", "-80,000", BANK, "", 0),
    );
    const [a, b, rent] = [await idOf("文房具"), await idOf("私用の買い物"), await idOf("家賃")];
    expect((await approve(rent, { draft: SUPPLIES_DRAFT(80_000, "2026-05-12") })).status).toBe(201);
    const res = await st()["exclude-bulk"].$post({
      param: ctx.param,
      json: {
        statementIds: [a, b, rent, "00000000-0000-7000-8000-000000000001"],
        reason: "私用",
      },
    });
    expect(res.status).toBe(200);
    const body = await okBody(res);
    expect(body.excluded).toEqual([a, b]);
    expect(body.failed.map((f) => [f.statementId, f.code])).toEqual([
      [rent, "STATEMENT_ALREADY_REGISTERED"],
      ["00000000-0000-7000-8000-000000000001", "STATEMENT_NOT_FOUND"],
    ]);
    expect(body.failed.every((f) => f.message.length > 0)).toBe(true);
    const all = await list();
    expect(all.find((s) => s.id === a)?.status).toBe("excluded");
    expect(all.find((s) => s.id === rent)?.status).toBe("registered");
    const empty = await okBody(
      await st()["exclude-bulk"].$post({ param: ctx.param, json: { statementIds: [] } }),
    );
    expect(empty).toEqual({ excluded: [], failed: [] });
  });

  it("statementIds が 500 件を超えると 400", async () => {
    const res = await st()["exclude-bulk"].$post({
      param: ctx.param,
      json: {
        statementIds: Array.from({ length: 501 }, () => "00000000-0000-7000-8000-000000000001"),
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("除外・除外の取消・変更の確認（§4.6〜§4.8）", () => {
  it("除外すると excluded。承認は 409 STATEMENT_EXCLUDED。取消は理由が必須（422 REASON_REQUIRED）", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const id = await idOf("文房具");
    const excluded = await st()[":statementId"].exclude.$post({ ...stId(id), json: {} });
    expect(excluded.status).toBe(200);
    expect((await okBody(excluded)).statement).toMatchObject({ id, status: "excluded" });

    const blocked = await approve(id, { draft: SUPPLIES_DRAFT() });
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).code).toBe("STATEMENT_EXCLUDED");

    const noReason = await st()[":statementId"].unexclude.$post({
      ...stId(id),
      json: { reason: " " },
    });
    expect(noReason.status).toBe(422);
    expect((await errorOf(noReason)).code).toBe("REASON_REQUIRED");

    const back = await st()[":statementId"].unexclude.$post({
      ...stId(id),
      json: { reason: "必要な支出だった" },
    });
    expect(back.status).toBe(200);
    expect((await okBody(back)).statement.status).toBe("unprocessed");
  });

  it("登録済みの明細の除外は 409 STATEMENT_ALREADY_REGISTERED。知らない明細は 404", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const id = await idOf("文房具");
    await approve(id, { draft: SUPPLIES_DRAFT() });
    const res = await st()[":statementId"].exclude.$post({ ...stId(id), json: { reason: "x" } });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("STATEMENT_ALREADY_REGISTERED");
    const missing = await st()[":statementId"].exclude.$post({
      ...stId("00000000-0000-7000-8000-000000000001"),
      json: {},
    });
    expect(missing.status).toBe(404);
  });

  it("変更の確認: 変更のない明細は 400 VALIDATION", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const res = await st()[":statementId"]["acknowledge-change"].$post(stId(await idOf("文房具")));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});

describe("結びつき（§4.4 の match・§4.9）と仕訳の詳細（FR-020）", () => {
  const existingJournal = async () => {
    const res = await ctx.e.journals.$post({
      param: ctx.param,
      json: {
        date: "2026-05-10",
        lines: [
          { side: "debit", accountId: ctx.accountId("地代家賃"), amount: 80_000 },
          { side: "credit", accountId: ctx.accountId("普通預金"), amount: 80_000 },
        ],
      },
    });
    expect(res.status).toBe(201);
    return (await okBody(res)).journal;
  };

  it("既存の仕訳に match で結びつける → 仕訳は増えない。外すと unprocessed。理由なしは 422 REASON_REQUIRED", async () => {
    const journal = await existingJournal();
    await importLines(line("05/10(日)", "家賃", "-80,000", BANK, "", 0));
    const id = await idOf("家賃");
    await okBody(await st().candidates.$post({ param: ctx.param, json: {} }));
    expect((await list()).find((s) => s.id === id)?.candidate).toMatchObject({
      method: "match",
      match: { journalId: journal.id },
    });
    const res = await approve(id);
    expect(res.status).toBe(201);
    const body = await okBody(res);
    expect(body.journal).toBeNull();
    expect(body.link).toMatchObject({ kind: "matched", journalId: journal.id });
    expect(await journalsList()).toHaveLength(1);

    const detail = await okBody(
      await ctx.e.journals[":journalId"].$get({ param: { ...ctx.param, journalId: journal.id } }),
    );
    expect(detail.statements).toEqual([{ statementId: id, kind: "matched" }]);

    const noReason = await st()[":statementId"].unlink.$post({ ...stId(id), json: { reason: "" } });
    expect(noReason.status).toBe(422);
    expect((await errorOf(noReason)).code).toBe("REASON_REQUIRED");
    const unlinked = await st()[":statementId"].unlink.$post({
      ...stId(id),
      json: { reason: "別の取引だった" },
    });
    expect(unlinked.status).toBe(200);
    expect((await okBody(unlinked)).statement).toMatchObject({ status: "unprocessed", links: [] });
    const after = await okBody(
      await ctx.e.journals[":journalId"].$get({ param: { ...ctx.param, journalId: journal.id } }),
    );
    expect(after.statements).toEqual([]);
  });

  it("created の結びつきは外せず 400 VALIDATION。仕訳の詳細に statements が出る", async () => {
    await importLines(line("05/10(日)", "文房具", "-1,200", BANK, "", 0));
    const id = await idOf("文房具");
    const body = await okBody(await approve(id, { draft: SUPPLIES_DRAFT() }));
    const res = await st()[":statementId"].unlink.$post({ ...stId(id), json: { reason: "確認" } });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
    const detail = await okBody(
      await ctx.e.journals[":journalId"].$get({
        param: { ...ctx.param, journalId: body.journal?.id as string },
      }),
    );
    expect(detail.statements).toEqual([{ statementId: id, kind: "created" }]);
  });

  it("結びつき先の行に別の明細があれば 409 JOURNAL_LINE_ALREADY_LINKED", async () => {
    const journal = await existingJournal();
    await importLines(
      line("05/10(日)", "家賃", "-80,000", BANK, "", 0),
      line("05/10(日)", "家賃2", "-80,000", BANK, "", 0),
    );
    const bankLine = journal.lines.find((l) => l.side === "credit");
    const match = { journalId: journal.id, lineId: bankLine?.id as string };
    expect((await approve(await idOf("家賃"), { match })).status).toBe(201);
    const res = await approve(await idOf("家賃2"), { match });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("JOURNAL_LINE_ALREADY_LINKED");
  });

  it("結びつきのない仕訳の詳細は statements が空", async () => {
    const journal = await existingJournal();
    const detail = await okBody(
      await ctx.e.journals[":journalId"].$get({ param: { ...ctx.param, journalId: journal.id } }),
    );
    expect(detail.statements).toEqual([]);
  });
});

describe("設定（§6.3）", () => {
  it("既定の値を返し、PUT で保存した値が GET で戻る", async () => {
    const first = await okBody(await ctx.e["statement-settings"].$get({ param: ctx.param }));
    expect(first.settings).toMatchObject({ bulkThreshold: 80, externalThreshold: 60 });
    const put = await ctx.e["statement-settings"].$put({
      param: ctx.param,
      json: { bulkThreshold: 90, externalThreshold: 40 },
    });
    expect(put.status).toBe(200);
    expect((await okBody(put)).settings).toMatchObject({
      bulkThreshold: 90,
      externalThreshold: 40,
    });
    const again = await okBody(await ctx.e["statement-settings"].$get({ param: ctx.param }));
    expect(again.settings).toMatchObject({ bulkThreshold: 90, externalThreshold: 40 });
  });

  it("0〜100 の整数でなければ 400 VALIDATION（保存しない）", async () => {
    for (const json of [
      { bulkThreshold: 101, externalThreshold: 50 },
      { bulkThreshold: 50, externalThreshold: -1 },
      { bulkThreshold: 50.5, externalThreshold: 50 },
    ]) {
      const res = await ctx.e["statement-settings"].$put({ param: ctx.param, json });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
    const kept = await okBody(await ctx.e["statement-settings"].$get({ param: ctx.param }));
    expect(kept.settings).toMatchObject({ bulkThreshold: 80, externalThreshold: 60 });
  });
});
