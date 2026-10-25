import { randomUUIDv7 } from "node:crypto";
import { DrizzleLedgerRepository, DrizzleRecurringUnitOfWork, openTenant } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { createRecurring, type IdGenerator, type RecurringUnitOfWork } from "@trebuchet/domain";
import { JournalQuery, type RecurringInput } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRecurringScheduler } from "../src/lib/recurring-scheduler.ts";
import { createInvoicingTestContext, type InvoicingTestContext } from "./invoicing-helpers.ts";

// 005 US3 T022: 判定の起動（R18）。偽の時計で 2026-10-26 に tick し、毎月 25 日・開始 8 月の定義が 3 件登録される

/** UTC 03:00 = JST 12:00。今日は 2026-10-26（日付の境目から離す。R22） */
const NOW_1026 = "2026-10-26T03:00:00.000Z";
const clock = { now: () => NOW_1026 };
const ids: IdGenerator = { next: () => randomUUIDv7() };
const HUGE = 24 * 60 * 60 * 1000;

let tmp: TempDataDir;
let ctx: InvoicingTestContext;

beforeEach(async () => {
  tmp = useTempDataDir("server-recurring-scheduler");
  ctx = await createInvoicingTestContext(NOW_1026);
});
afterEach(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
});

const uowOf = (entityId: string): RecurringUnitOfWork =>
  new DrizzleRecurringUnitOfWork(openTenant(entityId));

const accountIdsOf = async (entityId: string) => {
  const res = await ctx.e.accounts.$get({ param: { entityId } });
  if (res.status !== 200) throw new Error(`accounts failed: ${res.status}`);
  const map = new Map((await res.json()).accounts.map((a) => [a.name, a.id]));
  const get = (name: string) => {
    const id = map.get(name);
    if (id === undefined) throw new Error(`科目がない: ${name}`);
    return id;
  };
  return { rent: get("地代家賃"), bank: get("普通預金") };
};

/** 今日が 2026-08-01 のときに定義を保存する（その時点では登録される回がない）。登録は scheduler に任せる */
const saveDefinition = async (entityId: string) => {
  const { rent, bank } = await accountIdsOf(entityId);
  const input = {
    name: "事務所の家賃",
    dayOfMonth: 25,
    startMonth: "2026-08",
    lines: [
      { side: "debit", accountId: rent, amount: 100_000 },
      { side: "credit", accountId: bank, amount: 100_000 },
    ],
  } as RecurringInput;
  const saved = createRecurring(
    { uow: uowOf(entityId), ids, clock: { now: () => "2026-08-01T03:00:00.000Z" } },
    input,
    "2026-08-01",
  );
  if (!saved.ok) throw new Error(`createRecurring failed: ${saved.error.code}`);
  return saved.value;
};

const journalsOf = (entityId: string) =>
  new DrizzleLedgerRepository(openTenant(entityId)).findJournals(JournalQuery.parse({})).items;

const scheduler = (entities: string[], open: (id: string) => RecurringUnitOfWork = uowOf) =>
  startRecurringScheduler({
    entities: () => entities,
    openUnitOfWork: open,
    ids,
    clock,
    intervalMs: HUGE,
  });

describe("startRecurringScheduler", () => {
  it("2026-10-26 に tick すると 8・9・10 月の 25 日付の 3 件が source = recurring で登録される", async () => {
    await saveDefinition(ctx.entityId);
    const s = scheduler([ctx.entityId]);
    await s.tick();
    s.stop();

    const journals = journalsOf(ctx.entityId);
    expect(journals.map((j) => j.date).sort()).toEqual(["2026-08-25", "2026-09-25", "2026-10-25"]);
    expect(journals.every((j) => j.source === "recurring")).toBe(true);
  });

  it("もう一度 tick しても、作り直したスケジューラーで tick しても増えない", async () => {
    await saveDefinition(ctx.entityId);
    const first = scheduler([ctx.entityId]);
    await first.tick();
    await first.tick();
    first.stop();
    expect(journalsOf(ctx.entityId)).toHaveLength(3);

    const second = scheduler([ctx.entityId]);
    await second.tick();
    second.stop();
    expect(journalsOf(ctx.entityId)).toHaveLength(3);
  });

  it("1 つの事業体の DB の失敗でほかの事業体は登録され、ログには名前だけが出る", async () => {
    const other = await (async () => {
      const res = await ctx.client.api.entities.$post({
        json: { name: "二つ目", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
      });
      if (res.status !== 201) throw new Error(`entity create failed: ${res.status}`);
      return (await res.json()).entity.id;
    })();
    await saveDefinition(ctx.entityId);
    await saveDefinition(other);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const broken: RecurringUnitOfWork = {
      transaction: () => {
        throw new Error("secret-detail: database is locked");
      },
    };
    const s = scheduler([ctx.entityId, other], (id) => (id === ctx.entityId ? broken : uowOf(id)));
    await s.tick();
    s.stop();

    expect(journalsOf(ctx.entityId)).toHaveLength(0);
    expect(journalsOf(other)).toHaveLength(3);
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-detail");
  });
});
