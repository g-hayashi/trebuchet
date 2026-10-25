import { randomUUIDv7 } from "node:crypto";
import {
  approveCandidate,
  buildCandidates,
  commitStatementRows,
  createJournal,
  type InferenceRule,
  type JournalDraft,
  listRules,
  type PastedRow,
  pauseRule,
  type Result,
  type StatementStore,
  type StatementUnitOfWork,
  saveStatementAccount,
  seedRulesFromJournals,
  type TenantTx,
  updateRule,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { createStatementUnitOfWork, DrizzleStatementStore } from "../src/statement-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { accountIdOf, createTestEntity, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 006 T019（INV-47 のルールの側）。推定ルールの永続化を実 DB で確かめる:
// UNIQUE、履歴の追記のみ、承認の途中の障害でルールも残らない、停止・編集・初期作成の往復

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let store: DrizzleStatementStore;

const ids = { next: () => randomUUIDv7() };
const clock = { now: () => "2026-10-25T09:00:00.000Z" };

beforeEach(() => {
  tmp = useTempDataDir("statement-rules");
  db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
  store = new DrizzleStatementStore(db);
});
afterEach(() => tmp.cleanup());

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const ok = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const deps = (uow: StatementUnitOfWork = createStatementUnitOfWork(db)) => ({ uow, ids, clock });
const bank = () => accountIdOf(masters, "普通預金");
const rent = () => accountIdOf(masters, "地代家賃");
const supplies = () => accountIdOf(masters, "消耗品費");

const mapBank = () =>
  ok(
    saveStatementAccount(deps(), "サンプル銀行", {
      usage: "business",
      kind: "bank",
      accountId: bank(),
    } as never),
  );

let shaSeq = 0;
const importRows = (rows: PastedRow[]) => {
  shaSeq += 1;
  const sha256 = shaSeq.toString(16).padStart(64, "0");
  ok(
    commitStatementRows(deps(), {
      origin: "paste",
      rows,
      unreadable: [],
      sha256,
      expected: { inputSha256: sha256, countNew: rows.length },
    }),
  );
};
const row = (content: string, date = "2026-10-10"): PastedRow => ({
  accountName: "サンプル銀行",
  date,
  content,
  amount: -1200,
  transferFlag: false,
});
const idOf = (content: string) => {
  const s = store.listStatements().find((x) => x.content === content);
  if (s === undefined) throw new Error(`明細がない: ${content}`);
  return s.id;
};
const draftFor = (date: string, counter: string): JournalDraft => ({
  date,
  memo: "メモ",
  lines: [
    { side: "debit", accountId: counter, amount: 1200 },
    { side: "credit", accountId: bank(), amount: 1200 },
  ],
});

const rule = (over: Partial<InferenceRule> = {}): InferenceRule => ({
  id: randomUUIDv7(),
  normalizedContent: "店#",
  statementAccountId: null,
  counterAccountId: rent(),
  counterSubAccountId: null,
  partnerId: null,
  taxCategory: "OUT_OF_SCOPE",
  purpose: "business",
  descriptionTemplate: null,
  hits: 1,
  overrides: 0,
  status: "active",
  origin: "approval",
  createdAt: clock.now(),
  updatedAt: clock.now(),
  ...over,
});

describe("DrizzleStatementStore のルール", () => {
  it("往復する（追加・更新・一覧）。（内容, 口座）は一意で、口座なし（すべて）も 1 つだけ", () => {
    mapBank();
    const accountId = store.listStatementAccounts()[0]?.id ?? "";
    const all = rule();
    store.insertInferenceRule(all);
    store.insertInferenceRule(rule({ statementAccountId: accountId }));
    expect(store.listInferenceRules()).toHaveLength(2);
    expect(() => store.insertInferenceRule(rule())).toThrow(/UNIQUE/);
    expect(() => store.insertInferenceRule(rule({ statementAccountId: accountId }))).toThrow(
      /UNIQUE/,
    );

    store.updateInferenceRule({ ...all, hits: 5, status: "paused", updatedAt: "2026-10-26" });
    const back = store.listInferenceRules().find((r) => r.id === all.id);
    expect(back).toMatchObject({ hits: 5, status: "paused", updatedAt: "2026-10-26" });
    expect(() => store.updateInferenceRule(rule())).toThrow();
  });

  it("履歴は追記のみ（更新・削除はトリガーが拒否）。ルールごとに追記の順で読める", () => {
    const r = rule();
    store.insertInferenceRule(r);
    for (const action of ["create", "update"] as const) {
      store.appendInferenceRuleHistory({
        id: randomUUIDv7(),
        ruleId: r.id,
        action,
        beforeJson: null,
        afterJson: JSON.stringify(r),
        statementId: null,
        at: clock.now(),
      });
    }
    expect(store.listInferenceRuleHistory(r.id).map((h) => h.action)).toEqual(["create", "update"]);
    expect(store.listInferenceRuleHistory("other")).toEqual([]);
    expect(() =>
      db.$client.prepare("UPDATE inference_rule_history SET action = 'edit'").run(),
    ).toThrow(/append-only/);
    expect(() => db.$client.prepare("DELETE FROM inference_rule_history").run()).toThrow(
      /append-only/,
    );
  });
});

describe("承認からの学習（実 DB）", () => {
  it("承認でルールと履歴が書かれ、次の候補がルールから作られる。直して承認すると置き換わる", () => {
    mapBank();
    importRows([row("ショップ001"), row("ショップ002", "2026-10-11")]);
    ok(approveCandidate(deps(), idOf("ショップ001"), { draft: draftFor("2026-10-10", rent()) }));
    expect(store.listInferenceRules()).toHaveLength(1);
    expect(store.listInferenceRuleHistory(store.listInferenceRules()[0]?.id ?? "")).toHaveLength(1);

    ok(buildCandidates(deps()));
    const cand = store.listStatementCandidates().find((c) => c.statementId === idOf("ショップ002"));
    expect(cand).toMatchObject({ method: "rule", confidence: 60 });

    ok(
      approveCandidate(deps(), idOf("ショップ002"), {
        draft: draftFor("2026-10-11", supplies()),
      }),
    );
    const learned = store.listInferenceRules()[0];
    expect(learned).toMatchObject({ counterAccountId: supplies(), hits: 1, overrides: 1 });
  });

  it("learn: false ならルールも履歴も書かない", () => {
    mapBank();
    importRows([row("ショップ001")]);
    ok(
      approveCandidate(deps(), idOf("ショップ001"), {
        draft: draftFor("2026-10-10", rent()),
        learn: false,
      }),
    );
    expect(count("inference_rules")).toBe(0);
    expect(count("inference_rule_history")).toBe(0);
  });
});

// ---- 障害の注入（INV-47） ----

const WRITE_METHOD =
  /^(insert|upsert|append|replace|void|mark|update|delete|revoke|set|save|acknowledge)/;
class FaultInjectingUow implements StatementUnitOfWork {
  failAt: number | null = null;
  writes = 0;
  private readonly inner = createStatementUnitOfWork(db);

  run<T>(fn: (tx: TenantTx<{ statements: StatementStore }>) => Result<T>): Result<T> {
    this.writes = 0;
    return this.inner.run((tx) =>
      fn({
        ledger: this.wrap(tx.ledger),
        masters: this.wrap(tx.masters),
        statements: this.wrap(tx.statements),
      }),
    );
  }

  private wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get: (t, prop) => {
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof value !== "function" || typeof prop !== "string") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (prop === "transaction") {
          return (fn: (tx: object) => unknown) => method.call(t, (tx: object) => fn(this.wrap(tx)));
        }
        if (!WRITE_METHOD.test(prop)) return method.bind(t);
        return (...args: unknown[]) => {
          this.writes += 1;
          if (this.failAt !== null && this.writes === this.failAt) {
            throw new Error(`injected failure at write #${this.writes} (${prop})`);
          }
          return method.apply(t, args);
        };
      },
    });
  }
}

const TABLES = [
  "journals",
  "journal_lines",
  "statement_links",
  "statement_audit_log",
  "inference_rules",
  "inference_rule_history",
] as const;
const snapshot = () => ({
  counts: TABLES.map((t) => count(t)),
  rules: db.$client
    .prepare(
      "SELECT id, hits, overrides, counter_account_id, status FROM inference_rules ORDER BY rowid",
    )
    .all(),
});

describe("INV-47: 承認の途中の障害でルールも残らない（実 DB）", () => {
  for (const withExisting of [false, true]) {
    it(`書き込みのどこで失敗させても全部巻き戻り、成功すればルールが残る（既存のルール: ${withExisting}）`, () => {
      mapBank();
      importRows([row("ショップ001"), row("ショップ002", "2026-10-11")]);
      if (withExisting) {
        ok(
          approveCandidate(deps(), idOf("ショップ001"), { draft: draftFor("2026-10-10", rent()) }),
        );
      }
      ok(buildCandidates(deps()));
      const uow = new FaultInjectingUow();
      const target = idOf("ショップ002");
      let succeededAt = 0;
      for (let failAt = 1; failAt < 40; failAt++) {
        const before = snapshot();
        uow.failAt = failAt;
        let thrown = false;
        let result: Result<unknown> | undefined;
        try {
          result = approveCandidate(deps(uow), target, {
            draft: draftFor("2026-10-11", supplies()),
          });
        } catch {
          thrown = true;
        }
        uow.failAt = null;
        if (!thrown && result?.ok === true) {
          succeededAt = failAt;
          break;
        }
        expect(snapshot()).toEqual(before);
      }
      expect(succeededAt).toBeGreaterThan(1);
      const rules = store.listInferenceRules();
      expect(rules).toHaveLength(1);
      expect(rules[0]?.counterAccountId).toBe(supplies());
      expect(store.listInferenceRuleHistory(rules[0]?.id ?? "").length).toBe(withExisting ? 2 : 1);
    });
  }
});

describe("ルールの管理（実 DB）", () => {
  it("停止・編集・一覧・履歴が往復する", () => {
    mapBank();
    importRows([row("ショップ001")]);
    ok(approveCandidate(deps(), idOf("ショップ001"), { draft: draftFor("2026-10-10", rent()) }));
    const id = store.listInferenceRules()[0]?.id ?? "";
    ok(pauseRule(deps(), id));
    ok(updateRule(deps(), id, { counterAccountId: supplies() }));
    expect(ok(listRules(deps(), { status: "paused" }))[0]).toMatchObject({
      counterAccountId: supplies(),
      status: "paused",
    });
    expect(store.listInferenceRuleHistory(id).map((h) => h.action)).toEqual([
      "create",
      "pause",
      "edit",
    ]);
  });

  it("初期作成は、有効な手入力の仕訳からルールを作り、再実行では skipped。dryRun は書かない", () => {
    const ledgerDeps = { ledger: new DrizzleLedgerRepository(db), masters, ids, clock };
    for (const description of ["ショップ 001", "ショップ 002", "単発の店"]) {
      ok(
        createJournal(ledgerDeps, {
          date: "2026-10-01",
          memo: "手入力",
          lines: [
            { side: "debit", accountId: rent(), amount: 1000, description },
            { side: "credit", accountId: bank(), amount: 1000 },
          ],
        }),
      );
    }
    expect(ok(seedRulesFromJournals(deps(), { dryRun: true }))).toMatchObject({ created: 1 });
    expect(count("inference_rules")).toBe(0);
    expect(ok(seedRulesFromJournals(deps()))).toMatchObject({ created: 1, skipped: 0 });
    expect(store.listInferenceRules()[0]).toMatchObject({
      normalizedContent: "ショップ#",
      statementAccountId: null,
      origin: "seed",
      hits: 2,
    });
    expect(ok(seedRulesFromJournals(deps()))).toMatchObject({ created: 0, skipped: 1 });
    expect(count("inference_rules")).toBe(1);
  });
});
