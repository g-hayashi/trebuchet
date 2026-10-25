import { randomUUIDv7 } from "node:crypto";
import {
  createEntity,
  createJournal,
  domainError,
  err,
  type InvoicingAuditEntry,
  type JournalDraft,
  type LedgerRepository,
  type MasterRepository,
  ok,
  type Result,
  type TenantTx,
  type TenantUnitOfWork,
} from "@trebuchet/domain";
import { fc } from "@trebuchet/domain/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClosingUnitOfWork } from "../src/closing-repository.ts";
import { createImportUnitOfWork } from "../src/import-repository.ts";
import { createInvoicingUnitOfWork } from "../src/invoicing-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { createRecurringUnitOfWork } from "../src/recurring-repository.ts";
import { DrizzleRegistryRepository } from "../src/registry-repository.ts";
import { openRegistry, openTenant, type TenantDb } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

// TenantUnitOfWork の Drizzle 実装（drizzleUnitOfWork）。fn が ok を返せば確定し、
// err を返すか例外を投げれば fn の中の書き込み（入れ子の ledger.transaction を含む）がすべて残らない

let tmp: TempDataDir;
let db: TenantDb;

const ids = { next: () => randomUUIDv7() };
const clock = { now: () => "2026-10-24T09:00:00.000Z" };
const NOW = clock.now();

beforeEach(() => {
  tmp = useTempDataDir("unit-of-work");
  const created = createEntity(
    {
      registry: new DrizzleRegistryRepository(openRegistry()),
      openTenant: (entityId) => new DrizzleMasterRepository(openTenant(entityId)),
      ids,
      clock,
    },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
  );
  if (!created.ok) throw new Error(created.error.message);
  db = openTenant(created.value.id);
});
afterEach(() => tmp.cleanup());

const TABLES = [
  "journals",
  "journal_lines",
  "audit_log",
  "tags",
  "import_account_mappings",
  "closing_audit_log",
  "invoicing_audit_log",
] as const;

const counts = () =>
  Object.fromEntries(
    TABLES.map((t) => [
      t,
      (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );

const accountId = (masters: MasterRepository, name: string) => {
  const a = masters.listAccounts().find((x) => x.name === name);
  if (a === undefined) throw new Error(`科目がない: ${name}`);
  return a.id;
};

const draft = (masters: MasterRepository, amount = 1_000): JournalDraft => ({
  date: "2026-10-31",
  lines: [
    { side: "debit", accountId: accountId(masters, "現金"), amount },
    { side: "credit", accountId: accountId(masters, "売上高"), amount },
  ],
});

/** 001 の createJournal で仕訳を登録する（内側で ledger.transaction を使う） */
function post(tx: { ledger: LedgerRepository; masters: MasterRepository }): void {
  const r = createJournal({ ...tx, ids, clock }, draft(tx.masters));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
}

const audit = (over: Partial<InvoicingAuditEntry> = {}): InvoicingAuditEntry => ({
  id: randomUUIDv7(),
  occurredAt: NOW,
  targetType: "invoice",
  targetId: randomUUIDv7(),
  action: "create",
  reason: null,
  beforeJson: null,
  afterJson: "{}",
  ...over,
});

const failure = domainError("VALIDATION", "中止", { field: "x" });

type Body = (tx: TenantTx<object>, writeStore: () => void) => Result<number>;

/** 機能ごとの UnitOfWork と、その機能のストアへの 1 回の書き込み */
type Kind = { name: string; attempt: (db: TenantDb, body: Body) => Result<number> };

function kind<E extends object>(
  name: string,
  open: (db: TenantDb) => TenantUnitOfWork<E>,
  write: (tx: TenantTx<E>) => void,
): Kind {
  return { name, attempt: (db, body) => open(db).run((tx) => body(tx, () => write(tx))) };
}

const KINDS: Kind[] = [
  kind("取込", createImportUnitOfWork, (tx) =>
    tx.imports.upsertAccountMappings(
      [{ sourceName: `科目${randomUUIDv7()}`, accountId: accountId(tx.masters, "現金") }],
      NOW,
    ),
  ),
  kind("決算", createClosingUnitOfWork, (tx) =>
    tx.closing.appendClosingAudit({
      id: randomUUIDv7(),
      occurredAt: NOW,
      targetType: "fixed_asset",
      targetId: randomUUIDv7(),
      action: "create",
      reason: null,
      beforeJson: null,
      afterJson: "{}",
    }),
  ),
  kind("請求", createInvoicingUnitOfWork, (tx) => tx.invoicing.appendInvoicingAudit(audit())),
  kind("定期仕訳", createRecurringUnitOfWork, (tx) =>
    tx.recurring.appendRecurringAudit(audit({ targetType: "recurring_run" })),
  ),
];

type Op = "journal" | "tag" | "store";
type Outcome = "ok" | "err" | "throw";

describe.each(KINDS)("$name の UnitOfWork（drizzleUnitOfWork）", (kind) => {
  it("ok なら書き込みが残り、err・例外なら run の前と同じ（err と例外はそのまま返す・投げる）", () => {
    let tagSeq = 0;
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Op>("journal", "tag", "store"), { minLength: 1, maxLength: 4 }),
        fc.constantFrom<Outcome>("ok", "err", "throw"),
        (ops, outcome) => {
          const before = counts();
          const boom = new Error("途中で失敗");
          const call = () =>
            kind.attempt(db, (tx, writeStore) => {
              for (const op of ops) {
                if (op === "journal") post(tx);
                if (op === "tag") {
                  tagSeq += 1;
                  tx.masters.insertTag({ id: randomUUIDv7(), name: `タグ${tagSeq}` });
                }
                if (op === "store") writeStore();
              }
              if (outcome === "err") return err(failure);
              if (outcome === "throw") throw boom;
              return ok(ops.length);
            });

          if (outcome === "throw") {
            expect(call).toThrow(boom);
            expect(counts()).toEqual(before);
            return;
          }
          const result = call();
          if (outcome === "err") {
            expect(result).toEqual(err(failure));
            expect(counts()).toEqual(before);
            return;
          }
          expect(result).toEqual(ok(ops.length));
          const n = (op: Op) => ops.filter((o) => o === op).length;
          const after = counts();
          expect(after.journals).toBe((before.journals ?? 0) + n("journal"));
          expect(after.tags).toBe((before.tags ?? 0) + n("tag"));
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("drizzleUnitOfWork の入れ子", () => {
  it("内側の createJournal の err は内側だけで、外側が ok なら外側の仕訳は確定する", () => {
    const uow = createInvoicingUnitOfWork(db);
    const before = counts();
    const r = uow.run((tx) => {
      post(tx);
      const bad = createJournal({ ...tx, ids, clock }, { date: "2026-10-31", lines: [] });
      expect(bad.ok).toBe(false);
      return ok(null);
    });
    expect(r).toEqual(ok(null));
    expect(counts().journals).toBe((before.journals ?? 0) + 1);
  });
});
