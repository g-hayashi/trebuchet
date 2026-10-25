import { randomUUIDv7 } from "node:crypto";
import {
  type ImportBatch,
  type ImportRef,
  type ImportUnitOfWork,
  type JournalDraft,
  type NewJournal,
  ok,
  validateJournal,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImportUnitOfWork, DrizzleImportStore } from "../src/import-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { accountIdOf, createTestEntity, type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;
let store: DrizzleImportStore;
let uow: ImportUnitOfWork;

const clock = { now: () => "2026-10-19T09:00:00.000Z" };
const SHA = "0123456789abcdef".repeat(4);

beforeEach(() => {
  tmp = useTempDataDir("import-repo");
  db = openTenant(createTestEntity({ firstFiscalYear: 2025 }).id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
  store = new DrizzleImportStore(db);
  uow = createImportUnitOfWork(db);
});
afterEach(() => tmp.cleanup());

const accountId = (name: string) => accountIdOf(masters, name);

const context = () => ({
  accounts: masters.listAccounts(),
  subAccounts: masters.listSubAccounts(),
  partners: masters.listPartners(),
  tags: masters.listTags(),
  periods: masters.listFiscalPeriods(),
  taxSettings: masters.listTaxSettings(),
  taxRates: masters.listTaxRates(),
});

function newJournal(
  draft: JournalDraft,
  journalNo: number,
  source: NewJournal["source"],
  ctx = context(),
): NewJournal {
  const valid = validateJournal(draft, ctx);
  if (!valid.ok) throw new Error(JSON.stringify(valid.error));
  return {
    ...valid.value,
    id: randomUUIDv7(),
    journalNo,
    createdAt: clock.now(),
    lines: valid.value.lines.map((l) => ({ ...l, id: randomUUIDv7() })),
    source,
  };
}

const sale = (date: string, amount = 110_000): JournalDraft => ({
  date,
  lines: [
    { side: "debit", accountId: accountId("売掛金"), amount },
    { side: "credit", accountId: accountId("売上高"), amount },
  ],
});

const batchOf = (overrides: Partial<ImportBatch> = {}): ImportBatch => ({
  id: randomUUIDv7(),
  source: "freee_journal",
  fileName: "journal.csv",
  fileSha256: SHA,
  importedAt: clock.now(),
  periodFrom: "2025-01-01",
  periodTo: "2025-12-31",
  fiscalYears: [2025],
  countNew: 1,
  countAlready: 0,
  countExcluded: 1,
  countRejected: 0,
  countWarnings: 2,
  status: "active",
  voidedAt: null,
  voidReason: null,
  ...overrides,
});

const refOf = (journalId: string, batchId: string, freeeJournalId: string, freeeDate: string) =>
  ({
    journalId,
    batchId,
    freeeJournalId,
    freeeJournalNo: "1",
    freeeDate,
    snapshotJson: `{"id":"${freeeJournalId}"}`,
    revokedAt: null,
  }) satisfies ImportRef;

/** 取込の仕訳を登録し、取込の回と参照を作る */
function importJournals(entries: { freeeId: string; date: string }[], batch = batchOf()) {
  const result = uow.run(({ ledger: l, imports }) => {
    imports.insertBatch(batch);
    const refs = entries.map((e) => {
      const journal = l.insertJournal(newJournal(sale(e.date), l.nextJournalNo(), "import_freee"));
      return refOf(journal.id, batch.id, e.freeeId, e.date);
    });
    imports.insertRefs(refs);
    return ok({ batch, refs });
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const TABLES = [
  "sub_accounts",
  "partners",
  "tags",
  "journals",
  "journal_lines",
  "journal_line_tags",
  "audit_log",
  "import_batches",
  "import_journal_refs",
  "import_account_mappings",
  "import_tax_mappings",
] as const;
const counts = () => Object.fromEntries(TABLES.map((t) => [t, count(t)]));

describe("createImportUnitOfWork（INV-11）", () => {
  it("トランザクションの中で補助科目・取引先・タグ・仕訳・監査ログ・取込の記録を作ってから例外を投げると、どれも残らない", () => {
    const before = counts();
    expect(() =>
      uow.run(({ ledger: l, masters: m, imports }) => {
        const card = accountId("未払金");
        const sub = { id: randomUUIDv7(), accountId: card, name: "JALカード", isActive: true };
        m.insertSubAccount(sub);
        const partner = {
          id: randomUUIDv7(),
          name: "取引先A",
          honorific: null,
          memo: null,
          isActive: true,
        };
        m.insertPartner(partner);
        const tag = { id: randomUUIDv7(), name: "出張" };
        m.insertTag(tag);
        imports.upsertAccountMappings(
          [{ sourceName: "JALカード", accountId: card, subAccountId: sub.id }],
          clock.now(),
        );
        imports.upsertTaxMappings(
          [{ sourceName: "対象外", taxCategory: "OUT_OF_SCOPE" }],
          clock.now(),
        );
        const draft: JournalDraft = {
          date: "2025-03-01",
          lines: [
            {
              side: "debit",
              accountId: accountId("旅費交通費"),
              amount: 5000,
              partnerId: partner.id,
              tagIds: [tag.id],
            },
            { side: "credit", accountId: card, subAccountId: sub.id, amount: 5000 },
          ],
        };
        const journal = l.insertJournal(
          newJournal(draft, l.nextJournalNo(), "import_freee", {
            ...context(),
            subAccounts: [sub],
            partners: [partner],
            tags: [tag],
          }),
        );
        l.appendAudit({
          id: randomUUIDv7(),
          occurredAt: clock.now(),
          targetType: "journal",
          targetId: journal.id,
          action: "create",
          reason: null,
          beforeJson: null,
          afterJson: "{}",
        });
        const batch = batchOf();
        imports.insertBatch(batch);
        imports.insertRefs([refOf(journal.id, batch.id, "F-1", "2025-03-01")]);
        expect(count("journals")).toBe((before.journals ?? 0) + 1);
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(counts()).toEqual(before);
  });

  it("例外がなければ、すべてが同じトランザクションで保存され、仕訳の source は import_freee", () => {
    const { batch, refs } = importJournals([
      { freeeId: "F-1", date: "2025-03-01" },
      { freeeId: "F-2", date: "2025-04-01" },
    ]);
    expect(store.getBatch(batch.id)).toEqual(batch);
    const journal = ledger.getJournal(refs[0]?.journalId ?? "");
    expect(journal?.source).toBe("import_freee");
    expect(count("import_journal_refs")).toBe(2);
  });

  it("DB の制約の違反（取り消されていない参照の freee の仕訳ID の重複）でも全体が元に戻る", () => {
    importJournals([{ freeeId: "F-1", date: "2025-03-01" }]);
    const before = counts();
    expect(() => importJournals([{ freeeId: "F-1", date: "2025-03-01" }])).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(counts()).toEqual(before);
  });
});

describe("DrizzleImportStore", () => {
  it("activeRefsByFreeeIds・activeRefsInRange は revoked_at のある参照を返さない", () => {
    const first = importJournals([
      { freeeId: "F-1", date: "2025-03-01" },
      { freeeId: "F-2", date: "2025-06-30" },
    ]);
    const second = importJournals([{ freeeId: "F-3", date: "2025-12-31" }]);

    expect(
      store
        .activeRefsByFreeeIds(["F-1", "F-2", "F-3", "F-9"])
        .map((r) => r.freeeJournalId)
        .sort(),
    ).toEqual(["F-1", "F-2", "F-3"]);
    expect(store.activeRefsByFreeeIds([])).toEqual([]);
    expect(
      store
        .activeRefsInRange("2025-03-01", "2025-06-30")
        .map((r) => r.freeeJournalId)
        .sort(),
    ).toEqual(["F-1", "F-2"]);
    expect(store.activeRefsByFreeeIds(["F-1"])).toEqual([first.refs[0]]);

    store.voidBatch(first.batch.id, "誤った取込", "2026-10-20T00:00:00.000Z");

    expect(store.activeRefsByFreeeIds(["F-1", "F-2", "F-3"])).toEqual(second.refs);
    expect(store.activeRefsInRange("2025-01-01", "2025-12-31")).toEqual(second.refs);
  });

  it("voidBatch は取込の回を voided にし、その回の参照に revoked_at を設定する。取消済みの回は例外", () => {
    const { batch } = importJournals([{ freeeId: "F-1", date: "2025-03-01" }]);
    const other = importJournals([{ freeeId: "F-2", date: "2025-03-02" }]);
    const at = "2026-10-20T00:00:00.000Z";
    store.voidBatch(batch.id, "誤った取込", at);
    expect(store.getBatch(batch.id)).toEqual({
      ...batch,
      status: "voided",
      voidedAt: at,
      voidReason: "誤った取込",
    });
    expect(store.journalsOfBatch(batch.id).map((x) => x.ref.revokedAt)).toEqual([at]);
    expect(store.journalsOfBatch(other.batch.id).map((x) => x.ref.revokedAt)).toEqual([null]);
    expect(() => store.voidBatch(batch.id, "もう一度", at)).toThrow();
    expect(() => store.voidBatch(randomUUIDv7(), "ない", at)).toThrow();
    // 取り消した後は、同じ freee の仕訳ID をもう一度取り込める（INV-12）
    expect(() => importJournals([{ freeeId: "F-1", date: "2025-03-01" }])).not.toThrow();
  });

  it("journalsOfBatch は仕訳と参照を仕訳番号の順に返す（取消済みの仕訳を含む）", () => {
    const { batch, refs } = importJournals([
      { freeeId: "F-1", date: "2025-03-01" },
      { freeeId: "F-2", date: "2025-02-01" },
    ]);
    const first = ledger.getJournal(refs[0]?.journalId ?? "");
    if (first === undefined) throw new Error("仕訳がない");
    ledger.voidJournal(first.id, first.version, clock.now());
    const rows = store.journalsOfBatch(batch.id);
    expect(rows.map((r) => r.ref)).toEqual(refs);
    expect(rows.map((r) => r.journal.journalNo)).toEqual([1, 2]);
    expect(rows.map((r) => r.journal.status)).toEqual(["voided", "active"]);
    expect(rows[1]?.journal.lines).toHaveLength(2);
    expect(store.journalsOfBatch(randomUUIDv7())).toEqual([]);
  });

  it("listBatches は新しい順、getBatch は年度の配列を戻す。ない ID は undefined", () => {
    const older = batchOf({ importedAt: "2026-01-01T00:00:00.000Z", fiscalYears: [2025, 2026] });
    const newer = batchOf({ importedAt: "2026-02-01T00:00:00.000Z" });
    importJournals([{ freeeId: "F-1", date: "2025-03-01" }], older);
    importJournals([{ freeeId: "F-2", date: "2025-03-01" }], newer);
    expect(store.listBatches()).toEqual([newer, older]);
    expect(store.getBatch(older.id)?.fiscalYears).toEqual([2025, 2026]);
    expect(store.getBatch(randomUUIDv7())).toBeUndefined();
  });

  it("科目・税区分の対応表を追加・更新し、sourceName の順に返す", () => {
    const card = accountId("未払金");
    const sub = { id: randomUUIDv7(), accountId: card, name: "JALカード", isActive: true };
    masters.insertSubAccount(sub);
    store.upsertAccountMappings(
      [
        { sourceName: "交際費", accountId: accountId("接待交際費") },
        { sourceName: "JALカード", accountId: card, subAccountName: "JALカード" },
      ],
      clock.now(),
    );
    store.upsertAccountMappings(
      [{ sourceName: "JALカード", accountId: card, subAccountId: sub.id }],
      "2026-10-20T00:00:00.000Z",
    );
    expect(store.listAccountMappings()).toEqual([
      { sourceName: "JALカード", accountId: card, subAccountId: sub.id },
      { sourceName: "交際費", accountId: accountId("接待交際費") },
    ]);
    expect(() =>
      store.upsertAccountMappings(
        [{ sourceName: "X", accountId: card, subAccountId: sub.id, subAccountName: "X" }],
        clock.now(),
      ),
    ).toThrow(/CHECK constraint failed/);

    store.upsertTaxMappings(
      [
        { sourceName: "課税売上10%", taxCategory: "SALES_10" },
        { sourceName: "対象外", taxCategory: "OUT_OF_SCOPE" },
      ],
      clock.now(),
    );
    store.upsertTaxMappings(
      [{ sourceName: "課税売上10%", taxCategory: "PURCHASE_10" }],
      clock.now(),
    );
    expect(store.listTaxMappings()).toEqual([
      { sourceName: "対象外", taxCategory: "OUT_OF_SCOPE" },
      { sourceName: "課税売上10%", taxCategory: "PURCHASE_10" },
    ]);
  });

  it("manualJournalSignatures は期間内の手入力の有効な仕訳だけを返す", () => {
    const manual = ledger.insertJournal(newJournal(sale("2025-03-01", 1000), 1, undefined));
    const voided = ledger.insertJournal(newJournal(sale("2025-03-02", 2000), 2, "manual"));
    ledger.voidJournal(voided.id, voided.version, clock.now());
    ledger.insertJournal(newJournal(sale("2025-12-31", 3000), 3, "manual"));
    importJournals([{ freeeId: "F-1", date: "2025-03-01" }]);

    expect(store.manualJournalSignatures("2025-03-01", "2025-06-30")).toEqual([
      {
        journalId: manual.id,
        journalNo: 1,
        date: "2025-03-01",
        lines: [
          { side: "debit", accountId: accountId("売掛金"), amount: 1000 },
          { side: "credit", accountId: accountId("売上高"), amount: 1000 },
        ],
      },
    ]);
    expect(store.manualJournalSignatures("2025-01-01", "2025-12-31")).toHaveLength(2);
    expect(manual.source).toBe("manual");
  });
});
