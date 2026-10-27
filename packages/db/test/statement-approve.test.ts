import { randomUUIDv7 } from "node:crypto";
import {
  acknowledgeChange,
  approveBulk,
  approveCandidate,
  buildCandidates,
  commitStatementRows,
  createJournal,
  excludeStatement,
  type JournalDraft,
  listStatements,
  type Result,
  type StatementRow,
  type StatementStore,
  type StatementUnitOfWork,
  saveStatementAccount,
  type TenantTx,
  unexcludeStatement,
  unlinkStatement,
  voidJournal,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { createStatementUnitOfWork, DrizzleStatementStore } from "../src/statement-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { accountIdOf, createTestEntity, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 006 T015（INV-47 の承認の側、INV-43）。承認の永続化を実 DB で確かめる:
// 障害の注入での全部か無か、部分 UNIQUE、除外・確認・取消の往復

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;
let store: DrizzleStatementStore;

const ids = { next: () => randomUUIDv7() };
const clock = { now: () => "2026-10-25T09:00:00.000Z" };

beforeEach(() => {
  tmp = useTempDataDir("statement-approve");
  db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
  store = new DrizzleStatementStore(db);
});
afterEach(() => tmp.cleanup());

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const ok = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const codeOf = <T>(r: Result<T>): string => {
  if (r.ok) throw new Error("成功しました（失敗を期待）");
  return r.error.code;
};

const deps = (uow: StatementUnitOfWork = createStatementUnitOfWork(db)) => ({ uow, ids, clock });
const bank = () => accountIdOf(masters, "普通預金");
const payable = () => accountIdOf(masters, "未払金");
const rent = () => accountIdOf(masters, "地代家賃");

const mapAccount = (name: string, over: Record<string, unknown> = {}) =>
  ok(
    saveStatementAccount(deps(), name, {
      usage: "business",
      kind: "bank",
      accountId: bank(),
      ...over,
    } as never),
  );

let shaSeq = 0;
const importRows = (rows: StatementRow[]) => {
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
const row = (over: Partial<StatementRow> = {}): StatementRow => ({
  accountName: "サンプル銀行",
  date: "2026-10-10",
  content: "ショップ001",
  amount: -1200,
  transferFlag: false,
  ...over,
});
const idOf = (content: string) => {
  const s = store.listStatements().find((x) => x.content === content);
  if (s === undefined) throw new Error(`明細がない: ${content}`);
  return s.id;
};
const statusOf = (id: string) => ok(listStatements(deps())).find((v) => v.id === id)?.status;
const rentDraft = (date = "2026-10-12", amount = 80_000): JournalDraft => ({
  date,
  memo: "家賃",
  lines: [
    { side: "debit", accountId: rent(), amount },
    { side: "credit", accountId: bank(), amount },
  ],
});

/** 既存の仕訳（出所 recurring）を 1 件作る */
const addJournal = (draft: JournalDraft) =>
  ok(createJournal({ ledger, masters, ids, clock }, draft, { source: "recurring" })).journal;

/** 書き込みを数え、`failAt` 回目の直前に例外を投げる UnitOfWork（db の実装を包む） */
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
  "audit_log",
  "statement_links",
  "statement_audit_log",
  "statements",
] as const;
const snapshot = () => ({
  counts: TABLES.map((t) => count(t)),
  links: db.$client
    .prepare("SELECT id, revoked_at, revoked_reason FROM statement_links ORDER BY rowid")
    .all(),
});

/** `failAt` を 1, 2, ... と増やして承認し、失敗のたびに全部巻き戻ることを確かめる。成功したら終わる */
function sweepFailures(
  uow: FaultInjectingUow,
  approve: () => Result<unknown>,
  after: () => void,
): number {
  for (let failAt = 1; failAt < 40; failAt++) {
    const before = snapshot();
    uow.failAt = failAt;
    let thrown = false;
    let result: Result<unknown> | undefined;
    try {
      result = approve();
    } catch {
      thrown = true;
    }
    uow.failAt = null;
    if (!thrown && result?.ok === true) {
      after();
      return failAt;
    }
    expect(snapshot()).toEqual(before);
  }
  throw new Error("成功しなかった");
}

describe("approveCandidate の永続化（実 DB）", () => {
  it("承認すると仕訳・結びつき・監査が書かれ、明細は registered。仕訳を取り消すと unprocessed に戻る", () => {
    mapAccount("サンプル銀行");
    importRows([row({ content: "家賃", amount: -80_000 })]);
    const id = idOf("家賃");
    const r = ok(approveCandidate(deps(), id, { draft: rentDraft() }));
    expect(r.journal?.source).toBe("statement");
    expect(count("journals")).toBe(1);
    const links = store.listStatementLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ statementId: id, kind: "created", revokedAt: null });
    expect(count("statement_audit_log")).toBeGreaterThan(1); // 取込の監査 + 結びつきの作成
    expect(statusOf(id)).toBe("registered");

    const j = ledger.getJournal(r.journal?.id ?? "");
    ok(
      voidJournal({ ledger, masters, ids, clock }, j?.id ?? "", {
        reason: "取消",
        version: j?.version ?? 1,
      }),
    );
    expect(statusOf(id)).toBe("unprocessed");
    // 再承認で、古い結びつきが失効し、有効な結びつきは 1 件
    ok(approveCandidate(deps(), id, { draft: rentDraft("2026-10-13") }));
    const all = store.listStatementLinks();
    expect(all).toHaveLength(2);
    expect(all.filter((l) => l.revokedAt === null)).toHaveLength(1);
    expect(all.find((l) => l.revokedAt !== null)?.revokedReason).toBeTruthy();
    expect(statusOf(id)).toBe("registered");
  });

  it("振替の対は 1 つの仕訳の別々の行に 2 件結びつく（INV-43）", () => {
    mapAccount("サンプル銀行");
    mapAccount("テストカードA", { kind: "card", usage: "mixed", accountId: payable() });
    importRows([
      row({ content: "カード引落", amount: -30_000, transferFlag: true }),
      row({
        accountName: "テストカードA",
        content: "お支払い",
        amount: 30_000,
        transferFlag: true,
        date: "2026-10-12",
      }),
    ]);
    ok(buildCandidates(deps()));
    const r = ok(approveCandidate(deps(), idOf("カード引落")));
    expect(count("journals")).toBe(1);
    expect(r.pairLink?.statementId).toBe(idOf("お支払い"));
    expect(new Set(store.listStatementLinks().map((l) => l.journalLineId)).size).toBe(2);
    expect(statusOf(idOf("お支払い"))).toBe("registered");
  });

  it("結びつけ先の行に別の明細が結びついていれば JOURNAL_LINE_ALREADY_LINKED（部分 UNIQUE も同じ行を拒否する）", () => {
    mapAccount("サンプル銀行");
    const j = addJournal(rentDraft("2026-10-12"));
    importRows([
      row({ content: "家賃", amount: -80_000, date: "2026-10-12" }),
      row({ content: "家賃の二重", amount: -80_000, date: "2026-10-11" }),
    ]);
    const credit = j.lines.find((l) => l.side === "credit");
    const ref = { journalId: j.id, lineId: credit?.id ?? "" };
    ok(approveCandidate(deps(), idOf("家賃"), { match: ref }));
    const before = snapshot();
    expect(codeOf(approveCandidate(deps(), idOf("家賃の二重"), { match: ref }))).toBe(
      "JOURNAL_LINE_ALREADY_LINKED",
    );
    expect(snapshot()).toEqual(before);
    // DB の部分 UNIQUE（有効な結びつきだけ）が、ドメインの検査をすり抜けた書き込みも止める
    expect(() =>
      store.insertStatementLink({
        id: randomUUIDv7(),
        statementId: idOf("家賃の二重"),
        journalId: j.id,
        journalLineId: ref.lineId,
        kind: "matched",
        createdAt: clock.now(),
        revokedAt: null,
        revokedReason: null,
      }),
    ).toThrow(/UNIQUE/);
    // 外せば、別の明細を結べる
    ok(unlinkStatement(deps(), idOf("家賃"), { reason: "誤り" }));
    ok(approveCandidate(deps(), idOf("家賃の二重"), { match: ref }));
    expect(store.listStatementLinks().filter((l) => l.revokedAt === null)).toHaveLength(1);
  });
});

describe("INV-47（承認の側）: 障害の注入", () => {
  it("どの書き込みで失敗しても、仕訳・結びつき・監査が残らず、最後は成功する（新規の承認）", () => {
    mapAccount("サンプル銀行");
    importRows([row({ content: "家賃", amount: -80_000 })]);
    const id = idOf("家賃");
    const uow = new FaultInjectingUow();
    const succeededAt = sweepFailures(
      uow,
      () => approveCandidate(deps(uow), id, { draft: rentDraft() }),
      () => {
        expect(count("journals")).toBe(1);
        expect(store.listStatementLinks()).toHaveLength(1);
        expect(statusOf(id)).toBe("registered");
      },
    );
    expect(succeededAt).toBeGreaterThan(3); // 仕訳・結びつき・監査と複数回の書き込みがある
  });

  it("取消のあとの再承認で、失効の書き込みの後に失敗しても失効が巻き戻る", () => {
    mapAccount("サンプル銀行");
    importRows([row({ content: "家賃", amount: -80_000 })]);
    const id = idOf("家賃");
    const first = ok(approveCandidate(deps(), id, { draft: rentDraft() }));
    const j = ledger.getJournal(first.journal?.id ?? "");
    ok(
      voidJournal({ ledger, masters, ids, clock }, j?.id ?? "", {
        reason: "取消",
        version: j?.version ?? 1,
      }),
    );
    const uow = new FaultInjectingUow();
    sweepFailures(
      uow,
      () => approveCandidate(deps(uow), id, { draft: rentDraft("2026-10-13") }),
      () => {
        expect(store.listStatementLinks().filter((l) => l.revokedAt === null)).toHaveLength(1);
        expect(statusOf(id)).toBe("registered");
      },
    );
    // 失敗の途中で、古い結びつきが失効したまま残ることはなかった（sweep の各回で snapshot を比べた）
    expect(store.listStatementLinks()).toHaveLength(2);
  });

  it("振替の対の承認も、どの書き込みで失敗しても全部巻き戻る（対の結びつきだけが残らない）", () => {
    mapAccount("サンプル銀行");
    mapAccount("テストカードA", { kind: "card", usage: "mixed", accountId: payable() });
    importRows([
      row({ content: "カード引落", amount: -30_000, transferFlag: true }),
      row({
        accountName: "テストカードA",
        content: "お支払い",
        amount: 30_000,
        transferFlag: true,
      }),
    ]);
    ok(buildCandidates(deps()));
    const uow = new FaultInjectingUow();
    sweepFailures(
      uow,
      () => approveCandidate(deps(uow), idOf("カード引落")),
      () => {
        expect(store.listStatementLinks()).toHaveLength(2);
        expect(count("journals")).toBe(1);
      },
    );
  });

  it("まとめて承認は明細ごとに 1 つの UnitOfWork（途中の明細の失敗でほかの承認は残る）", () => {
    mapAccount("サンプル銀行");
    importRows([
      row({ content: "家賃A", amount: -80_000, date: "2026-10-10" }),
      row({ content: "家賃B", amount: -70_000, date: "2026-10-11" }),
    ]);
    ok(buildCandidates(deps()));
    // 候補を作る段（match）は使わず、AI の候補を直接書いて、しきい値以上にする
    for (const [content, amount] of [
      ["家賃A", 80_000],
      ["家賃B", 70_000],
    ] as const) {
      store.upsertStatementCandidate({
        statementId: idOf(content),
        method: "rule",
        purpose: "business",
        confidence: 90,
        reason: "テスト",
        draftJson: JSON.stringify(rentDraft("2026-10-12", amount)),
        ruleId: null,
        model: null,
        createdAt: clock.now(),
      });
    }
    // B の案を、貸借が合わない形に壊す（承認で UNBALANCED になる）
    const broken = rentDraft("2026-10-12", 70_000);
    const lines = broken.lines.map((l) => (l.side === "debit" ? { ...l, amount: 60_000 } : l));
    store.upsertStatementCandidate({
      statementId: idOf("家賃B"),
      method: "rule",
      purpose: "business",
      confidence: 90,
      reason: "テスト",
      draftJson: JSON.stringify({ ...broken, lines }),
      ruleId: null,
      model: null,
      createdAt: clock.now(),
    });
    const r = ok(approveBulk(deps()));
    expect(r.approved).toEqual([idOf("家賃A")]);
    expect(r.failed.map((f) => [f.statementId, f.code])).toEqual([[idOf("家賃B"), "UNBALANCED"]]);
    expect(count("journals")).toBe(1);
    expect(statusOf(idOf("家賃B"))).toBe("unprocessed");
  });
});

describe("除外・変更の確認・結びつきの取消の永続化", () => {
  it("除外 → 除外の取消が往復し、監査に理由が残る。登録済みは除外できない", () => {
    mapAccount("サンプル銀行");
    importRows([row({ content: "A" }), row({ content: "家賃", amount: -80_000 })]);
    const a = idOf("A");
    const ex = ok(excludeStatement(deps(), a, { reason: "私用" }));
    expect(ex.status).toBe("excluded");
    expect(store.listStatements().find((s) => s.id === a)).toMatchObject({
      excludedAt: clock.now(),
      excludedReason: "私用",
    });
    expect(codeOf(approveCandidate(deps(), a, { draft: rentDraft() }))).toBe("STATEMENT_EXCLUDED");
    ok(unexcludeStatement(deps(), a, { reason: "誤り" }));
    expect(store.listStatements().find((s) => s.id === a)).toMatchObject({
      excludedAt: null,
      excludedReason: null,
    });
    const actions = db.$client
      .prepare("SELECT action, reason FROM statement_audit_log WHERE target_id = ? ORDER BY rowid")
      .all(a);
    expect(actions).toEqual([
      { action: "exclude", reason: "私用" },
      { action: "unexclude", reason: "誤り" },
    ]);
    const rentId = idOf("家賃");
    ok(approveCandidate(deps(), rentId, { draft: rentDraft() }));
    expect(codeOf(excludeStatement(deps(), rentId, {}))).toBe("STATEMENT_ALREADY_REGISTERED");
  });

  it("変更ありの確認は changed_ack_at を書き、取込の再書き込みで NULL に戻る", () => {
    mapAccount("サンプル銀行");
    importRows([row({ content: "変更前" })]);
    const id = idOf("変更前");
    store.markStatementChanged(id, JSON.stringify({ amount: -2000 }));
    const v = ok(acknowledgeChange(deps(), id));
    expect(v.changed).toBeNull();
    expect(store.listStatements()[0]?.changedAckAt).toBe(clock.now());
    store.markStatementChanged(id, JSON.stringify({ amount: -3000 }));
    expect(store.listStatements()[0]?.changedAckAt).toBeNull();
  });

  it("matched の結びつきを外すと revoked_* が書かれ、仕訳は残る。同じ結びつきの二重の失効は例外", () => {
    mapAccount("サンプル銀行");
    const j = addJournal(rentDraft("2026-10-12"));
    importRows([row({ content: "家賃", amount: -80_000, date: "2026-10-12" })]);
    const id = idOf("家賃");
    const credit = j.lines.find((l) => l.side === "credit");
    ok(approveCandidate(deps(), id, { match: { journalId: j.id, lineId: credit?.id ?? "" } }));
    const v = ok(unlinkStatement(deps(), id, { reason: "誤って結びつけた" }));
    expect(v.status).toBe("unprocessed");
    const link = store.listStatementLinks()[0];
    expect(link).toMatchObject({ revokedAt: clock.now(), revokedReason: "誤って結びつけた" });
    expect(ledger.getJournal(j.id)?.status).toBe("active");
    expect(() => store.revokeStatementLink(link?.id ?? "", clock.now(), "もう一度")).toThrow();
  });
});
