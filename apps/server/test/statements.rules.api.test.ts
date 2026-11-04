import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
} from "./invoicing-helpers.ts";
import { importStatementLines } from "./statements-helpers.ts";

// 006 US3: contracts/http-api.md §5（ルール）と §4.4 の rule・learn。承認 → 学習 → 候補 → 管理

let tmp: TempDataDir;
let ctx: InvoicingTestContext;

beforeEach(async () => {
  tmp = useTempDataDir("server-statements-rules-api");
  ctx = await createInvoicingTestContext();
});
afterEach(() => tmp.cleanup());

const st = () => ctx.e.statements;
const rules = () => ctx.e["inference-rules"];
const ruleId = (id: string) => ({ param: { ...ctx.param, ruleId: id } });

const line = (...cells: (string | number)[]) => cells.join("\t");
const BANK = "サンプル銀行";

const importLines = (...lines: string[]) => importStatementLines(st().imports, ctx.param, ...lines);
const list = async () =>
  (await okBody(await st().$get({ param: ctx.param, query: {} }))).statements;
const idOf = async (content: string) => {
  const found = (await list()).find((s) => s.content === content);
  if (found === undefined) throw new Error(`明細がない: ${content}`);
  return found.id;
};
const draftOf = (counter: string, amount = 1_200, date = "2026-05-10") => ({
  date,
  memo: "文房具",
  lines: [
    { side: "debit" as const, accountId: ctx.accountId(counter), amount },
    { side: "credit" as const, accountId: ctx.accountId("普通預金"), amount },
  ],
});
const approve = (statementId: string, json: Record<string, unknown> = {}) =>
  st()[":statementId"].approve.$post({ param: { ...ctx.param, statementId }, json });
const listRules = async (query: Record<string, string> = {}) =>
  (await okBody(await rules().$get({ param: ctx.param, query }))).rules;

beforeEach(async () => {
  const res = await ctx.e["statement-accounts"][":name"].$put({
    param: { ...ctx.param, name: BANK },
    json: { usage: "business", kind: "bank", accountId: ctx.accountId("普通預金") },
  });
  expect(res.status).toBe(200);
});

describe("承認からの学習（§4.4）", () => {
  it("承認するとルールができ、応答の rule に確信度つきで返る。一覧にも出る（§5.1）", async () => {
    expect(await listRules()).toEqual([]);
    await importLines(line("05/10(日)", "ショップ001", "-1,200", BANK, "", 0));
    const res = await approve(await idOf("ショップ001"), { draft: draftOf("消耗品費") });
    expect(res.status).toBe(201);
    const body = await okBody(res);
    expect(body.rule).toMatchObject({ hits: 1, overrides: 0, confidence: 60, status: "active" });

    const all = await listRules();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: body.rule?.id,
      normalizedContent: "ショップ#",
      counterAccountId: ctx.accountId("消耗品費"),
      purpose: "business",
      origin: "approval",
    });
    expect(await listRules({ status: "paused" })).toEqual([]);
  });

  it("learn を渡しても無視して常に学ぶ。ルールは managedBy auto（T018）", async () => {
    await importLines(line("05/10(日)", "ショップ001", "-1,200", BANK, "", 0));
    const res = await approve(await idOf("ショップ001"), {
      draft: draftOf("消耗品費"),
      learn: false,
    });
    expect(res.status).toBe(201);
    expect((await okBody(res)).rule).toMatchObject({ managedBy: "auto" });
    expect(await listRules()).toHaveLength(1);
  });

  it("PATCH で managedBy が user になり、以後の承認はそのルールを変えない（INV-71）", async () => {
    await importLines(
      line("05/10(日)", "ショップ001", "-1,200", BANK, "", 0),
      line("05/11(月)", "ショップ002", "-1,200", BANK, "", 0),
    );
    const first = await okBody(
      await approve(await idOf("ショップ001"), { draft: draftOf("消耗品費") }),
    );
    const id = first.rule?.id ?? "";
    const patched = await rules()[":ruleId"].$patch({
      ...ruleId(id),
      json: { counterAccountId: ctx.accountId("地代家賃") },
    });
    expect((await okBody(patched)).rule).toMatchObject({ managedBy: "user" });
    const before = await listRules();

    const res = await approve(await idOf("ショップ002"), {
      draft: draftOf("消耗品費", 1_200, "2026-05-11"),
    });
    expect(res.status).toBe(201);
    expect((await okBody(res)).rule).toBeUndefined();
    expect(await listRules()).toEqual(before);
    expect(before[0]).toMatchObject({ managedBy: "user", hits: 1, overrides: 0 });
  });

  it("purpose・partnerId を受け取り、学習に使う。存在しない取引先は 400 VALIDATION で何も書かない", async () => {
    await importLines(line("05/10(日)", "ショップ001", "-1,200", BANK, "", 0));
    const id = await idOf("ショップ001");
    const bad = await approve(id, {
      draft: draftOf("消耗品費"),
      partnerId: "00000000-0000-7000-8000-000000000001",
    });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("VALIDATION");
    expect(await listRules()).toEqual([]);

    const partnerId = await ctx.addPartner("取引先A");
    const res = await approve(id, {
      draft: draftOf("消耗品費"),
      partnerId,
      purpose: "business",
    });
    expect(res.status).toBe(201);
    expect((await okBody(res)).rule?.partnerId).toBe(partnerId);
  });

  it("学習したルールで、次の候補が作られる（POST /statements/candidates）", async () => {
    await importLines(
      line("05/10(日)", "ショップ001", "-1,200", BANK, "", 0),
      line("05/20(水)", "ショップ002", "-3,300", BANK, "", 0),
    );
    await approve(await idOf("ショップ001"), { draft: draftOf("消耗品費") });
    const built = await okBody(await st().candidates.$post({ param: ctx.param, json: {} }));
    expect(built.needsAi).toEqual([]);
    const second = (await list()).find((s) => s.content === "ショップ002");
    expect(second?.candidate).toMatchObject({ method: "rule", confidence: 60 });
    expect(second?.candidate?.reason).toContain("1 件");
  });
});

describe("初期作成（§5.2）", () => {
  const postJournal = async (description: string) => {
    const res = await ctx.e.journals.$post({
      param: ctx.param,
      json: {
        date: "2026-03-01",
        memo: "手入力",
        lines: [
          {
            side: "debit",
            accountId: ctx.accountId("消耗品費"),
            amount: 1_000,
            description,
          },
          { side: "credit", accountId: ctx.accountId("普通預金"), amount: 1_000 },
        ],
      },
    });
    expect(res.status).toBe(201);
  };

  it("dryRun は案だけを返し、実行すると作る。再実行は skipped", async () => {
    await postJournal("ショップ 001");
    await postJournal("ショップ 002");
    const dry = await okBody(
      await rules().seed.$post({ param: ctx.param, json: { dryRun: true } }),
    );
    expect(dry).toMatchObject({ created: 1, skipped: 0 });
    expect(dry.rules?.[0]).toMatchObject({ normalizedContent: "ショップ#", hits: 2 });
    expect(await listRules()).toEqual([]);

    const done = await okBody(await rules().seed.$post({ param: ctx.param, json: {} }));
    expect(done).toMatchObject({ created: 1, skipped: 0 });
    expect(await listRules()).toHaveLength(1);
    const again = await okBody(await rules().seed.$post({ param: ctx.param, json: {} }));
    expect(again).toMatchObject({ created: 0, skipped: 1 });
  });
});

describe("編集・停止・再開・履歴（§5.3〜§5.5）", () => {
  const seedOne = async () => {
    await importLines(line("05/10(日)", "ショップ001", "-1,200", BANK, "", 0));
    const body = await okBody(
      await approve(await idOf("ショップ001"), { draft: draftOf("消耗品費") }),
    );
    return body.rule?.id ?? "";
  };

  it("PATCH は内容を直して 200 { rule }。変えていない項目は残り、hits も残る", async () => {
    const id = await seedOne();
    const res = await rules()[":ruleId"].$patch({
      ...ruleId(id),
      json: { counterAccountId: ctx.accountId("地代家賃"), descriptionTemplate: "家賃" },
    });
    expect(res.status).toBe(200);
    expect((await okBody(res)).rule).toMatchObject({
      id,
      counterAccountId: ctx.accountId("地代家賃"),
      descriptionTemplate: "家賃",
      hits: 1,
      purpose: "business",
    });
  });

  it("PATCH のエラー: ルールがない 404、科目がない 422、補助科目・取引先の違反と不正な値は 400", async () => {
    const id = await seedOne();
    const missing = await rules()[":ruleId"].$patch({
      ...ruleId("00000000-0000-7000-8000-000000000001"),
      json: {},
    });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("INFERENCE_RULE_NOT_FOUND");

    const noAccount = await rules()[":ruleId"].$patch({
      ...ruleId(id),
      json: { counterAccountId: "00000000-0000-7000-8000-000000000001" },
    });
    expect(noAccount.status).toBe(422);
    expect((await errorOf(noAccount)).code).toBe("ACCOUNT_NOT_FOUND");

    const noPartner = await rules()[":ruleId"].$patch({
      ...ruleId(id),
      json: { partnerId: "00000000-0000-7000-8000-000000000001" },
    });
    expect(noPartner.status).toBe(400);
    expect((await errorOf(noPartner)).code).toBe("VALIDATION");

    const badTax = await rules()[":ruleId"].$patch({
      ...ruleId(id),
      json: { taxCategory: "BOGUS" as "OUT_OF_SCOPE" },
    });
    expect(badTax.status).toBe(400);
  });

  it("pause → 候補に使われない → resume → 履歴は追記の順で before・after つき（404 もある）", async () => {
    const id = await seedOne();
    await importLines(line("05/20(水)", "ショップ002", "-3,300", BANK, "", 0));

    const paused = await rules()[":ruleId"].pause.$post(ruleId(id));
    expect(paused.status).toBe(200);
    expect((await okBody(paused)).rule.status).toBe("paused");
    await st().candidates.$post({ param: ctx.param, json: {} });
    expect((await list()).find((s) => s.content === "ショップ002")?.candidate?.method).toBe("none");
    expect(await listRules({ status: "active" })).toEqual([]);

    const resumed = await rules()[":ruleId"].resume.$post(ruleId(id));
    expect((await okBody(resumed)).rule.status).toBe("active");
    expect((await list()).find((s) => s.content === "ショップ002")?.candidate?.method).toBe("rule");

    const history = (await okBody(await rules()[":ruleId"].history.$get(ruleId(id)))).history;
    expect(history.map((h) => h.action)).toEqual(["create", "pause", "resume"]);
    expect(history[0]).toMatchObject({ before: null });
    expect(history[1]?.after).toMatchObject({ status: "paused" });

    for (const call of [
      rules()[":ruleId"].pause.$post(ruleId("00000000-0000-7000-8000-000000000001")),
      rules()[":ruleId"].resume.$post(ruleId("00000000-0000-7000-8000-000000000001")),
      rules()[":ruleId"].history.$get(ruleId("00000000-0000-7000-8000-000000000001")),
    ]) {
      const res = await call;
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe("INFERENCE_RULE_NOT_FOUND");
    }
  });

  it("不正な status の絞り込みは 400", async () => {
    const res = await rules().$get({ param: ctx.param, query: { status: "bogus" as "active" } });
    expect(res.status).toBe(400);
  });
});
