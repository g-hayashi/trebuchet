import { randomUUIDv7 } from "node:crypto";
import {
  acknowledgeRuns,
  createJournal,
  createRecurring,
  getRecurringDetail,
  ok,
  pauseRecurring,
  postDueRecurring,
  type RecurringUnitOfWork,
  recurringStatus,
  resumeRecurring,
  skipRecurringRun,
  voidJournal,
} from "@trebuchet/domain";
import type { Recurring, RecurringInput } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleInvoicingStore } from "../src/invoicing-repository.ts";
import { createRecurringUnitOfWork, DrizzleRecurringStore } from "../src/recurring-repository.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";
import { setupInvoicingDb } from "./invoicing-db-setup.ts";

// 005 US3: 定期仕訳の実 DB での往復・冪等性・巻き戻し。
// トリガー・CHECK・UNIQUE の個別の検査は invoicing-schema.test.ts（T002）

let tmp: TempDataDir;
let t: ReturnType<typeof setupInvoicingDb>;
let store: DrizzleRecurringStore;
let uow: RecurringUnitOfWork;
let deps: { uow: RecurringUnitOfWork; ids: { next(): string }; clock: { now(): string } };

const TODAY = "2026-10-26";

beforeEach(() => {
  tmp = useTempDataDir("recurring-repository");
  t = setupInvoicingDb({ taxable: true });
  store = new DrizzleRecurringStore(t.db);
  uow = createRecurringUnitOfWork(t.db);
  deps = { uow, ids: t.ids, clock: t.clock };
});
afterEach(() => tmp.cleanup());

const input = (over: Partial<RecurringInput> = {}): RecurringInput => ({
  name: "家賃",
  memo: "事務所の家賃",
  dayOfMonth: 25,
  startMonth: "2026-08",
  confirm: true,
  lines: [
    { side: "debit", accountId: t.accountId("地代家賃"), amount: 80_000 },
    { side: "credit", accountId: t.accountId("普通預金"), amount: 80_000 },
  ],
  ...over,
});

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const definition = (over: Partial<Recurring> = {}): Recurring => ({
  id: randomUUIDv7(),
  name: "家賃",
  memo: "事務所の家賃",
  dayOfMonth: 25,
  startMonth: "2026-08",
  endMonth: null,
  status: "active",
  version: 1,
  lines: [
    {
      lineNo: 1,
      side: "debit",
      accountId: t.accountId("地代家賃"),
      subAccountId: null,
      amount: 80_000,
      taxCategory: null,
      partnerId: null,
      description: "家賃",
    },
    {
      lineNo: 2,
      side: "credit",
      accountId: t.accountId("普通預金"),
      subAccountId: null,
      amount: 80_000,
      taxCategory: "OUT_OF_SCOPE",
      partnerId: null,
      description: null,
    },
  ],
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T09:00:00.000Z",
  ...over,
});

describe("定義と行の保存と読み戻し", () => {
  it("insertRecurring → getRecurring / listRecurring の往復（行は行番号の順、作成の順）", () => {
    const a = definition({ createdAt: "2026-10-24T09:00:00.000Z", name: "A" });
    const b = definition({
      createdAt: "2026-10-25T09:00:00.000Z",
      name: "B",
      endMonth: "2027-03",
      memo: null,
      status: "paused",
    });
    store.insertRecurring(b);
    store.insertRecurring(a);
    expect(store.getRecurring(a.id)).toEqual(a);
    expect(store.getRecurring(b.id)).toEqual(b);
    expect(store.listRecurring().map((d) => d.name)).toEqual(["A", "B"]);
    expect(store.getRecurring("no-such")).toBeNull();
  });

  it("updateRecurring は列を上書きし、行を全件置き換える", () => {
    const def = definition();
    store.insertRecurring(def);
    const [first] = def.lines;
    if (first === undefined) throw new Error("行がない");
    const updated: Recurring = {
      ...def,
      name: "家賃（変更）",
      dayOfMonth: 31,
      endMonth: "2027-01",
      version: 2,
      status: "paused",
      updatedAt: "2026-10-25T09:00:00.000Z",
      lines: [
        { ...first, amount: 90_000, partnerId: null },
        {
          lineNo: 2,
          side: "credit",
          accountId: t.accountId("普通預金"),
          subAccountId: null,
          amount: 50_000,
          taxCategory: null,
          partnerId: null,
          description: null,
        },
        {
          lineNo: 3,
          side: "credit",
          accountId: t.accountId("現金"),
          subAccountId: null,
          amount: 40_000,
          taxCategory: null,
          partnerId: null,
          description: null,
        },
      ],
    };
    store.updateRecurring(updated);
    expect(store.getRecurring(def.id)).toEqual(updated);
    expect(t.count("recurring_journal_lines")).toBe(3);

    store.updateRecurring({ ...updated, lines: updated.lines.slice(0, 2), version: 3 });
    expect(store.getRecurring(def.id)?.lines).toHaveLength(2);
    expect(t.count("recurring_journal_lines")).toBe(2);
  });

  it("回の保存・読み戻し・確認（acknowledged_at は一度だけ）", () => {
    const def = definition();
    store.insertRecurring(def);
    const posted = createJournal(
      { ledger: t.ledger, masters: t.masters, ids: t.ids, clock: t.clock },
      {
        date: "2026-08-25",
        lines: [
          { side: "debit", accountId: t.accountId("地代家賃"), amount: 1_000 },
          { side: "credit", accountId: t.accountId("普通預金"), amount: 1_000 },
        ],
      },
      { source: "recurring" },
    );
    const journalId = must(posted).journal.id;
    const run = {
      id: randomUUIDv7(),
      recurringId: def.id,
      targetMonth: "2026-08",
      status: "posted" as const,
      journalId,
      skipReason: null,
      createdAt: "2026-10-26T09:00:00.000Z",
      acknowledgedAt: null,
    };
    const skipped = {
      id: randomUUIDv7(),
      recurringId: def.id,
      targetMonth: "2026-07",
      status: "skipped" as const,
      journalId: null,
      skipReason: "休業",
      createdAt: "2026-10-26T09:00:00.000Z",
      acknowledgedAt: null,
    };
    store.insertRun(run);
    store.insertRun(skipped);
    expect(store.listRuns(def.id)).toEqual([skipped, run]);
    expect(store.listRuns()).toHaveLength(2);
    expect(store.listRuns("other")).toEqual([]);

    store.markRunsAcknowledged([run.id], "2026-10-27T09:00:00.000Z");
    expect(store.listRuns(def.id)[1]?.acknowledgedAt).toBe("2026-10-27T09:00:00.000Z");
    expect(() => store.markRunsAcknowledged([run.id], "2026-10-28T09:00:00.000Z")).toThrow();
  });

  it("同じ（定義, 月）の回・同じ仕訳の回の保存は一意制約の違反で例外", () => {
    const def = definition();
    store.insertRecurring(def);
    const skipped = (month: string, id = randomUUIDv7()) => ({
      id,
      recurringId: def.id,
      targetMonth: month,
      status: "skipped" as const,
      journalId: null,
      skipReason: "x",
      createdAt: "2026-10-26T09:00:00.000Z",
      acknowledgedAt: null,
    });
    store.insertRun(skipped("2026-08"));
    expect(() => store.insertRun(skipped("2026-08"))).toThrow();
    expect(t.count("recurring_runs")).toBe(1);
  });
});

describe("実 DB での判定（US3 Independent Test）", () => {
  it("毎月 25 日・開始 8 月の定義で、10 月 26 日に判定すると 3 件、もう一度走らせても増えない", () => {
    const def = must(createRecurring(deps, input(), TODAY));
    const first = postDueRecurring(deps, TODAY);
    expect(first.failed).toEqual([]);
    expect(first.posted.map((p) => p.journal.date)).toEqual([
      "2026-08-25",
      "2026-09-25",
      "2026-10-25",
    ]);
    expect(t.count("journals")).toBe(3);
    expect(t.count("recurring_runs")).toBe(3);
    expect(
      (
        t.db.$client.prepare("SELECT DISTINCT source FROM journals").all() as { source: string }[]
      ).map((r) => r.source),
    ).toEqual(["recurring"]);

    // 同じ回の登録を 2 回走らせても仕訳は 1 件だけ
    expect(postDueRecurring(deps, TODAY).posted).toEqual([]);
    expect(postDueRecurring(deps, TODAY).posted).toEqual([]);
    // 作り直した UnitOfWork（再起動）でも増えない
    const restarted = { ...deps, uow: createRecurringUnitOfWork(t.db) };
    expect(postDueRecurring(restarted, TODAY).posted).toEqual([]);
    expect(t.count("journals")).toBe(3);
    expect(t.count("recurring_runs")).toBe(3);

    // 仕訳の起点（FR-028）は定期仕訳と対象月を指す
    const origin = new DrizzleInvoicingStore(t.db).originOfJournal(
      first.posted[0]?.journal.id ?? "",
    );
    expect(origin).toEqual({
      kind: "recurring",
      recurringId: def.id,
      name: "家賃",
      targetMonth: "2026-08",
    });
  });

  it("回の保存が一意制約で失敗すると、同じトランザクションの仕訳も巻き戻る（R19）", () => {
    const def = must(createRecurring(deps, input(), TODAY));
    postDueRecurring(deps, TODAY);
    const before = t.count("journals");
    expect(() =>
      uow.run(({ ledger, masters, recurring }) => {
        const created = createJournal(
          { ledger, masters, ids: t.ids, clock: t.clock },
          {
            date: "2026-08-25",
            lines: [
              { side: "debit", accountId: t.accountId("地代家賃"), amount: 80_000 },
              { side: "credit", accountId: t.accountId("普通預金"), amount: 80_000 },
            ],
          },
          { source: "recurring" },
        );
        if (!created.ok) throw new Error("仕訳の登録に失敗");
        recurring.insertRun({
          id: randomUUIDv7(),
          recurringId: def.id,
          targetMonth: "2026-08",
          status: "posted",
          journalId: created.value.journal.id,
          skipReason: null,
          createdAt: "2026-10-26T09:00:00.000Z",
          acknowledgedAt: null,
        });
        return ok(null);
      }),
    ).toThrow();
    expect(t.count("journals")).toBe(before);
    expect(t.count("recurring_runs")).toBe(3);
  });

  it("登録した仕訳を取り消しても再登録されない", () => {
    must(createRecurring(deps, input({ startMonth: "2026-10" }), TODAY));
    const [posted] = postDueRecurring(deps, TODAY).posted;
    if (posted === undefined) throw new Error("登録されていない");
    must(
      voidJournal(
        { ledger: t.ledger, masters: t.masters, ids: t.ids, clock: t.clock },
        posted.journal.id,
        { reason: "誤り", version: posted.journal.version },
      ),
    );
    expect(postDueRecurring(deps, "2026-10-30").posted).toEqual([]);
    expect(t.count("journals")).toBe(1);
    expect(t.count("recurring_runs")).toBe(1);
  });

  it("停止・再開・飛ばし・確認が実 DB で通り、記録が残る", () => {
    const def = must(createRecurring(deps, input(), TODAY));
    postDueRecurring(deps, TODAY);
    must(pauseRecurring(deps, def.id, { version: 1 }));
    const resumed = must(resumeRecurring(deps, def.id, { version: 2 }, "2026-12-10"));
    expect(resumed).toMatchObject({ status: "active", startMonth: "2026-12", version: 3 });

    expect(postDueRecurring(deps, "2026-12-26").posted.map((p) => p.targetMonth)).toEqual([
      "2026-12",
    ]);
    // 2027 年度の会計期間がないので、2027-01 の回は blocked（OUT_OF_PERIOD）。飛ばして確定する
    const detail = must(getRecurringDetail(deps, def.id, "2027-01-26"));
    expect(detail.blocked.map((b) => [b.targetMonth, b.reason])).toEqual([
      ["2027-01", "OUT_OF_PERIOD"],
    ]);
    must(skipRecurringRun(deps, def.id, "2027-01", { reason: "年度の作成前" }, "2027-01-26"));
    expect(must(getRecurringDetail(deps, def.id, "2027-01-26")).blocked).toEqual([]);

    const status = must(recurringStatus(deps, "2027-01-26"));
    expect(status.unacknowledged).toHaveLength(4);
    must(
      acknowledgeRuns(
        deps,
        status.unacknowledged.map((u) => u.runId),
      ),
    );
    expect(must(recurringStatus(deps, "2027-01-26")).unacknowledged).toEqual([]);

    const audits = t.db.$client
      .prepare(
        "SELECT target_type, action FROM invoicing_audit_log WHERE target_type LIKE 'recurring_%' ORDER BY rowid",
      )
      .all() as { target_type: string; action: string }[];
    const kinds = new Set(audits.map((a) => `${a.target_type}:${a.action}`));
    for (const k of [
      "recurring_journal:create",
      "recurring_journal:pause",
      "recurring_journal:resume",
      "recurring_run:create",
      "recurring_run:skip",
      "recurring_run:acknowledge",
    ]) {
      expect(kinds.has(k)).toBe(true);
    }
  });
});
