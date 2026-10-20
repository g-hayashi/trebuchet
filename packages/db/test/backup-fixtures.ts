import { randomUUIDv7 } from "node:crypto";
import { createEntity, type EntityKind, type NewJournal, validateJournal } from "@trebuchet/domain";
import { balancedLinesArb, dateInPeriodArb, fc } from "@trebuchet/domain/testing";
import type Database from "better-sqlite3";
import { DrizzleClosingStore } from "../src/closing-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { DrizzleRegistryRepository } from "../src/registry-repository.ts";
import { openRegistry, openTenant } from "../src/tenant-store.ts";

/** 合成の事業体 1 件の指定。seed と journals から仕訳を決定的に作る */
export type EntitySpec = {
  name: string;
  kind: EntityKind;
  seed: number;
  journals: number;
  memo: string;
  note: string;
};

export type SeededEntity = { id: string; name: string };

const ids = { next: () => randomUUIDv7() };
const clock = { now: () => "2026-10-31T09:00:00.000Z" };

/** 事業体を作り、仕訳と決算の表（closing_notes）の行を入れる */
export function seedEntities(specs: EntitySpec[]): SeededEntity[] {
  return specs.map((spec) => seedEntity(spec));
}

function seedEntity(spec: EntitySpec): SeededEntity {
  const created = createEntity(
    {
      registry: new DrizzleRegistryRepository(openRegistry()),
      openTenant: (entityId) => new DrizzleMasterRepository(openTenant(entityId)),
      ids,
      clock,
    },
    { name: spec.name, kind: spec.kind, fiscalStartMonth: 1, firstFiscalYear: 2026 },
  );
  if (!created.ok) throw new Error(created.error.message);
  const entityId = created.value.id;
  const db = openTenant(entityId);
  const masters = new DrizzleMasterRepository(db);
  const ledger = new DrizzleLedgerRepository(db);
  const period = masters.listFiscalPeriods()[0];
  if (period === undefined) throw new Error("会計期間がない");
  const accounts = masters.listAccounts().filter((a) => a.isActive);
  const drafts = fc.sample(
    fc.record({ date: dateInPeriodArb(period), lines: balancedLinesArb(accounts) }),
    { seed: spec.seed, numRuns: spec.journals },
  );
  const ctx = {
    accounts: masters.listAccounts(),
    subAccounts: masters.listSubAccounts(),
    partners: masters.listPartners(),
    tags: masters.listTags(),
    periods: masters.listFiscalPeriods(),
    taxSettings: masters.listTaxSettings(),
    taxRates: masters.listTaxRates(),
  };
  ledger.transaction((tx) => {
    if (!(tx instanceof DrizzleLedgerRepository)) throw new Error("想定外のリポジトリ");
    for (const draft of drafts) {
      const valid = validateJournal({ ...draft, memo: spec.memo }, ctx);
      if (!valid.ok) throw new Error(JSON.stringify(valid.error));
      const journal: NewJournal = {
        ...valid.value,
        id: randomUUIDv7(),
        journalNo: tx.nextJournalNo(),
        createdAt: clock.now(),
        lines: valid.value.lines.map((l) => ({ ...l, id: randomUUIDv7() })),
      };
      tx.insertJournal(journal);
    }
  });
  new DrizzleClosingStore(db).upsertClosingNote({
    fiscalYear: 2026,
    kind: "special_circumstances",
    body: spec.note,
    updatedAt: clock.now(),
  });
  return { id: entityId, name: spec.name };
}

/** registry の端末に結びつく 7 表（バックアップから除く）に、marker を含む行を入れる */
export function seedAuthRows(marker: string): void {
  const db = openRegistry().$client;
  const now = clock.now();
  db.prepare(
    "INSERT INTO passkeys (id, public_key, counter, rp_id, name, created_at) VALUES (?, ?, 0, 'localhost', ?, ?)",
  ).run(`pk-${marker}`, Buffer.from(`pubkey-${marker}`), `name-${marker}`, now);
  db.prepare("INSERT INTO recovery_codes (id, code_hash, created_at) VALUES (?, ?, ?)").run(
    `rc-${marker}`,
    `hash-${marker}`,
    now,
  );
  db.prepare(
    "INSERT INTO sessions (id, token_hash, kind, rp_id, user_agent, created_at, last_seen_at) VALUES (?, ?, 'normal', 'localhost', ?, ?, ?)",
  ).run(`ss-${marker}`, `token-${marker}`, `agent-${marker}`, now, now);
  db.prepare(
    "INSERT INTO auth_events (id, occurred_at, kind, detail) VALUES (?, ?, 'sign_in', ?)",
  ).run(`ev-${marker}`, now, `detail-${marker}`);
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)").run(
    "backup_folder",
    `/folder-${marker}`,
    now,
  );
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)").run(
    "mac_id",
    `mac-${marker}`,
    now,
  );
  db.prepare(
    "INSERT INTO backup_runs (id, started_at, finished_at, trigger, status, summary) VALUES (?, ?, ?, 'manual', 'succeeded', ?)",
  ).run(`br-${marker}`, now, now, `summary-${marker}`);
  db.prepare(
    "INSERT INTO pairing_tokens (id, token_hash, rp_id, created_at, expires_at) VALUES (?, ?, 'localhost', ?, ?)",
  ).run(`pt-${marker}`, `pairing-${marker}`, now, now);
}

export const EXCLUDED_REGISTRY_TABLES = [
  "passkeys",
  "recovery_codes",
  "sessions",
  "auth_events",
  "app_settings",
  "backup_runs",
  "pairing_tokens",
] as const;

/** すべての表の内容を、行の JSON の並べ替えた配列にして返す（VACUUM は rowid を振り直すため順序に依存しない） */
export function dumpTables(db: Database.Database, exclude: readonly string[] = []) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const out: Record<string, string[]> = {};
  for (const { name } of tables.sort((a, b) => a.name.localeCompare(b.name))) {
    if (exclude.includes(name)) continue;
    const rows = db.prepare(`SELECT * FROM "${name}"`).all();
    out[name] = rows
      .map((r) => JSON.stringify(r, (_k, v) => (Buffer.isBuffer(v) ? v.toString("hex") : v)))
      .sort();
  }
  return out;
}

/** トリガー・索引・表の定義（名前順） */
export function dumpSchema(db: Database.Database) {
  return db
    .prepare(
      "SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
}

export function entitySpecArb(): fc.Arbitrary<EntitySpec> {
  return fc.record({
    name: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
    kind: fc.constantFrom<EntityKind>("individual", "corporation"),
    seed: fc.integer(),
    journals: fc.integer({ min: 0, max: 4 }),
    memo: fc.string({ maxLength: 10 }),
    note: fc.string({ maxLength: 20 }),
  });
}
