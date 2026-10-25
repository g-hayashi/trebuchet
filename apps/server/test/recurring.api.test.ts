import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
} from "./invoicing-helpers.ts";

// 005 US3: contracts/http-api.md §5。今日は 2026-10-31（偽の時計。invoicing-helpers の NOW）

let tmp: TempDataDir;
let ctx: InvoicingTestContext;

beforeEach(async () => {
  tmp = useTempDataDir("server-recurring-api");
  ctx = await createInvoicingTestContext();
});
afterEach(() => tmp.cleanup());

const r = () => ctx.e["recurring-journals"];
type PostJson = Parameters<ReturnType<typeof r>["$post"]>[0]["json"];

const input = (over: Record<string, unknown> = {}) =>
  ({
    name: "事務所の家賃",
    dayOfMonth: 25,
    startMonth: "2026-08",
    lines: [
      { side: "debit", accountId: ctx.accountId("地代家賃"), amount: 100_000 },
      { side: "credit", accountId: ctx.accountId("普通預金"), amount: 100_000 },
    ],
    ...over,
  }) as PostJson;

const create = (over: Record<string, unknown> = {}) =>
  r().$post({ param: ctx.param, json: input(over) });

const created = async (over: Record<string, unknown> = {}) => {
  const res = await create(over);
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return okBody(res);
};

const statusOf = async () => {
  const res = await r().status.$get({ param: ctx.param });
  expect(res.status).toBe(200);
  return okBody(res);
};

describe("POST /recurring-journals（§5.2）", () => {
  it("今日以前に登録される回があり confirm がなければ 409 RECURRING_CONFIRM_REQUIRED（件数と月）。何も保存しない", async () => {
    const res = await create();
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("RECURRING_CONFIRM_REQUIRED");
    expect(error.details).toEqual({ count: 3, months: ["2026-08", "2026-09", "2026-10"] });

    const list = await okBody(await r().$get({ param: ctx.param }));
    expect(list.recurring).toEqual([]);
  });

  it("confirm: true で保存し、その直後の判定で 3 件が登録される（posted は仕訳の参照）", async () => {
    const res = await create({ confirm: true });
    expect(res.status).toBe(201);
    const body = await okBody(res);
    expect(body.recurring).toMatchObject({ status: "active", version: 1, dayOfMonth: 25 });
    expect(body.posted.map((j) => j.date).sort()).toEqual([
      "2026-08-25",
      "2026-09-25",
      "2026-10-25",
    ]);

    const list = await okBody(await r().$get({ param: ctx.param }));
    expect(list.recurring).toHaveLength(1);
    expect(list.recurring[0]).toMatchObject({ postedCount: 3, nextDate: "2026-11-25" });
  });

  it("登録される回がなければ confirm なしで 201（posted は空）", async () => {
    const body = await created({ startMonth: "2026-11" });
    expect(body.posted).toEqual([]);
  });

  it("dayOfMonth 29・30 は 400 VALIDATION。31（末日）は保存できる", async () => {
    for (const dayOfMonth of [29, 30]) {
      const res = await create({ dayOfMonth, startMonth: "2026-11" });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
    const body = await created({ dayOfMonth: 31, startMonth: "2026-11" });
    expect(body.recurring.dayOfMonth).toBe(31);
  });

  it("貸借が合わない定義は 422 UNBALANCED", async () => {
    const lines = [
      { side: "debit", accountId: ctx.accountId("地代家賃"), amount: 100_000 },
      { side: "credit", accountId: ctx.accountId("普通預金"), amount: 90_000 },
    ];
    const res = await create({ lines, startMonth: "2026-11" });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("UNBALANCED");
  });
});

describe("PUT /recurring-journals/:id（§5.4）", () => {
  it("version が古ければ 409 VERSION_CONFLICT（currentVersion つき）。合っていれば version + 1", async () => {
    const { recurring } = await created({ startMonth: "2026-11" });
    const put = (version: number, name: string) =>
      r()[":id"].$put({
        param: { ...ctx.param, id: recurring.id },
        json: { ...input({ startMonth: "2026-11", name }), version } as never,
      });

    const stale = await put(99, "改名");
    expect(stale.status).toBe(409);
    const error = await errorOf(stale);
    expect(error.code).toBe("VERSION_CONFLICT");
    expect(error.details).toMatchObject({ recurringId: recurring.id, currentVersion: 1 });

    const ok = await put(1, "改名");
    expect(ok.status).toBe(200);
    expect((await okBody(ok)).recurring).toMatchObject({ name: "改名", version: 2 });
  });

  it("存在しない ID は 404 RECURRING_NOT_FOUND", async () => {
    const res = await r()[":id"].$put({
      param: { ...ctx.param, id: "01900000-0000-7000-8000-000000000000" },
      json: { ...input({ startMonth: "2026-11" }), version: 1 } as never,
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("RECURRING_NOT_FOUND");
  });
});

describe("停止と再開（§5.5・§5.6）", () => {
  it("停止は 200、再開は fromMonth から。登録される回がなければ confirm なしで 200", async () => {
    const { recurring } = await created({ startMonth: "2026-10", confirm: true });
    const id = recurring.id;

    const paused = await r()[":id"].pause.$post({
      param: { ...ctx.param, id },
      json: { version: 1 },
    });
    expect(paused.status).toBe(200);
    expect((await okBody(paused)).recurring).toMatchObject({ status: "paused", version: 2 });

    const resumed = await r()[":id"].resume.$post({
      param: { ...ctx.param, id },
      json: { version: 2, fromMonth: "2026-12" },
    });
    expect(resumed.status).toBe(200);
    const body = await okBody(resumed);
    expect(body.recurring).toMatchObject({ status: "active", startMonth: "2026-12" });
    expect(body.posted).toEqual([]);
  });

  it("再開で今日以前に登録される回があれば 409 RECURRING_CONFIRM_REQUIRED。confirm で登録される", async () => {
    const { recurring } = await created({ startMonth: "2026-11" });
    const id = recurring.id;
    const param = { ...ctx.param, id };
    await r()[":id"].pause.$post({ param, json: { version: 1 } });
    // 停止中は判定の対象外なので、開始月を過去にしても確認は要らない（version 2 → 3）
    const moved = await r()[":id"].$put({
      param,
      json: { ...input({ startMonth: "2026-08" }), version: 2 } as never,
    });
    expect(moved.status).toBe(200);

    const resume = (json: Record<string, unknown>) =>
      r()[":id"].resume.$post({ param, json: json as never });
    // 再開の月（既定は今日の月 = 10 月）から。停止の間の 8・9 月は登録しない
    const first = await resume({ version: 3 });
    expect(first.status).toBe(409);
    const error = await errorOf(first);
    expect(error.code).toBe("RECURRING_CONFIRM_REQUIRED");
    expect(error.details).toEqual({ count: 1, months: ["2026-10"] });

    const confirmed = await resume({ version: 3, confirm: true });
    expect(confirmed.status).toBe(200);
    const body = await okBody(confirmed);
    expect(body.recurring).toMatchObject({ status: "active", startMonth: "2026-10" });
    expect(body.posted.map((j) => j.date)).toEqual(["2026-10-25"]);
  });
});

describe("status・acknowledge・skip（§5.7〜§5.9）", () => {
  /**
   * 9 月から税抜経理にする（8 月は登録でき、9・10 月は 001 の検証の TAX_METHOD_UNSUPPORTED
   * = blocked の JOURNAL_INVALID）。API では適用の空白は作れない
   */
  const excludedFromSeptember = async () => {
    const res = await ctx.e["tax-settings"].$put({
      param: ctx.param,
      json: [
        {
          effectiveFrom: "2026-01-01",
          taxpayerStatus: "general",
          accountingMethod: "tax_included",
        },
        {
          effectiveFrom: "2026-09-01",
          taxpayerStatus: "general",
          accountingMethod: "tax_excluded",
        },
      ],
    });
    expect(res.status).toBe(200);
  };

  it("status は未確認の自動登録と blocked（JOURNAL_INVALID と details.code）を返し、acknowledge の後に未確認から消える", async () => {
    await excludedFromSeptember();
    const { recurring, posted } = await created({ confirm: true });
    expect(posted.map((j) => j.date)).toEqual(["2026-08-25"]);

    const before = await statusOf();
    expect(before.unacknowledged).toHaveLength(1);
    expect(before.unacknowledged[0]).toMatchObject({
      recurringId: recurring.id,
      name: "事務所の家賃",
      targetMonth: "2026-08",
      journal: { id: posted[0]?.id, date: "2026-08-25" },
    });
    const blocked = (month: string) => ({
      recurringId: recurring.id,
      name: "事務所の家賃",
      targetMonth: month,
      date: `${month}-25`,
      reason: "JOURNAL_INVALID",
      details: { code: "TAX_METHOD_UNSUPPORTED" },
    });
    expect(before.blocked).toEqual([blocked("2026-09"), blocked("2026-10")]);

    const ack = await r().acknowledge.$post({
      param: ctx.param,
      json: { runIds: before.unacknowledged.map((u) => u.runId) },
    });
    expect(ack.status).toBe(204);
    const after = await statusOf();
    expect(after.unacknowledged).toEqual([]);
    expect(after.blocked).toHaveLength(2);
  });

  it("acknowledge に存在しない回があれば 400 相当の VALIDATION（何も変えない）", async () => {
    const res = await r().acknowledge.$post({
      param: ctx.param,
      json: { runIds: ["01900000-0000-7000-8000-000000000000"] },
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("skip は blocked の回を「登録しない」にして blocked から消す。未来の月・登録済みの月は VALIDATION（field = month）", async () => {
    await excludedFromSeptember();
    const { recurring } = await created({ confirm: true });
    const skip = (month: string, reason: string) =>
      r()[":id"].runs[":month"].skip.$post({
        param: { ...ctx.param, id: recurring.id, month },
        json: { reason },
      });

    const ok = await skip("2026-09", "この月は日割りで払った");
    expect(ok.status).toBe(200);
    expect((await okBody(ok)).run).toMatchObject({
      targetMonth: "2026-09",
      status: "skipped",
      skipReason: "この月は日割りで払った",
      journalId: null,
    });
    expect((await statusOf()).blocked.map((b) => b.targetMonth)).toEqual(["2026-10"]);

    // 未来の月（11 月）、登録済み（8 月）、飛ばし済み（9 月）
    for (const month of ["2026-11", "2026-08", "2026-09"]) {
      const res = await skip(month, "理由");
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe("VALIDATION");
      expect(error.details).toMatchObject({ field: "month" });
    }
  });

  it("skip の理由が空なら REASON_REQUIRED", async () => {
    await excludedFromSeptember();
    const { recurring } = await created({ confirm: true });
    const res = await r()[":id"].runs[":month"].skip.$post({
      param: { ...ctx.param, id: recurring.id, month: "2026-09" },
      json: { reason: "  " },
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("REASON_REQUIRED");
  });

  it("/status は /:id より先に解決される。詳細は runs と blocked を返し、ない ID は 404", async () => {
    await excludedFromSeptember();
    const { recurring } = await created({ confirm: true });

    const detail = await okBody(
      await r()[":id"].$get({ param: { ...ctx.param, id: recurring.id } }),
    );
    expect(detail.recurring.id).toBe(recurring.id);
    expect(detail.runs.map((x) => [x.targetMonth, x.status])).toEqual([["2026-08", "posted"]]);
    expect(detail.blocked.map((b) => b.targetMonth)).toEqual(["2026-09", "2026-10"]);

    const missing = await r()[":id"].$get({
      param: { ...ctx.param, id: "01900000-0000-7000-8000-000000000000" },
    });
    expect(missing.status).toBe(404);
  });
});
