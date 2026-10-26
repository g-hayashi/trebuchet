import { randomUUIDv7 } from "node:crypto";
import {
  domainError,
  type EvalRunRecord,
  err,
  listEvalRuns,
  runEvaluation,
  type SuggestionProvider,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStatementUnitOfWork, DrizzleStatementStore } from "../src/statement-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { createTestEntity, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 006 T026（§1.9、R17）。評価の実行の記録（eval_runs）の永続化を実 DB で確かめる

const unavailableSuggestionProvider: SuggestionProvider = {
  available: async () => false,
  suggest: async () => err(domainError("VALIDATION", "AI を使えません")),
};

let tmp: TempDataDir;
let db: TenantDb;
let store: DrizzleStatementStore;

beforeEach(() => {
  tmp = useTempDataDir("statement-evals");
  db = openTenant(createTestEntity().id);
  store = new DrizzleStatementStore(db);
});
afterEach(() => tmp.cleanup());

const record = (over: Partial<EvalRunRecord> = {}): EvalRunRecord => ({
  id: randomUUIDv7(),
  splitDate: "2026-01-01",
  includeAi: false,
  sampleCount: 3,
  resultJson: JSON.stringify({
    fields: { counterAccount: 333, taxCategory: 1000, partner: 1000, purpose: 1000 },
    methods: [{ method: "rule", count: 3, matchRate: 333 }],
  }),
  modelsJson: "[]",
  createdAt: "2026-10-25T09:00:00.000Z",
  ...over,
});

describe("DrizzleStatementStore の評価の記録", () => {
  it("追加した記録を、新しい順（作成の日時、同じなら ID の降順）で返す。真偽は 0・1 で保存して戻す", () => {
    const old = record({ createdAt: "2026-10-24T09:00:00.000Z" });
    const aiRun = record({ includeAi: true, modelsJson: '["fm"]', id: "a-first" });
    const same = record({ id: "b-second" });
    for (const r of [old, aiRun, same]) store.insertEvalRun(r);
    const listed = store.listEvalRuns();
    expect(listed.map((r) => r.id)).toEqual(["b-second", "a-first", old.id]);
    expect(listed[1]).toEqual(aiRun);
    expect(
      (
        db.$client.prepare("SELECT include_ai FROM eval_runs WHERE id = ?").get("a-first") as {
          include_ai: number;
        }
      ).include_ai,
    ).toBe(1);
  });

  it("負の件数は CHECK で拒否される", () => {
    expect(() => store.insertEvalRun(record({ sampleCount: -1 }))).toThrow(/CHECK/);
  });

  it("runEvaluation は実 DB の UnitOfWork で 1 行だけ保存する（明細がなければ 0 件）", async () => {
    const uow = createStatementUnitOfWork(db);
    const result = await runEvaluation(
      {
        uow,
        ids: { next: () => randomUUIDv7() },
        clock: { now: () => "2026-10-25T09:00:00.000Z" },
        local: unavailableSuggestionProvider,
        external: unavailableSuggestionProvider,
        externalEnabled: false,
        models: { local: "fm", external: "external" },
      },
      { today: "2026-10-25" },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value).toMatchObject({
      splitDate: "2026-01-01",
      includeAi: false,
      sampleCount: 0,
      models: [],
    });
    const listed = listEvalRuns({ uow });
    if (!listed.ok) throw new Error("一覧に失敗");
    expect(listed.value).toEqual([result.value]);
  });
});
