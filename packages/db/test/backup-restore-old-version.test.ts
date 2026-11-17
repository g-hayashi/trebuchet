import { createHash, randomUUIDv7 } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packArchive, unpackArchive } from "../src/backup/archive.ts";
import { decryptBackup, encryptBackup } from "../src/backup/crypto.ts";
import { restoreBackup } from "../src/backup/restore.ts";
import { currentAppVersion } from "../src/backup/snapshot.ts";
import type { AppVersion, SnapshotFile } from "../src/backup/types.ts";
import { Database, drizzleOf } from "../src/driver.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import {
  closeAll,
  createAuthFile,
  type DbKeyScope,
  openEncryptedSqlite,
  openRegistry,
  openTenant,
} from "../src/tenant-store.ts";
import {
  createTestEntity,
  TEST_DATA_KEY,
  type TempDataDir,
  useTempDataDir,
} from "../src/testing.ts";
import { recoveryFixture } from "./backup-fixtures.ts";
import { migrationsUpTo } from "./migration-fixtures.ts";

/**
 * 古い版（マイグレーションの件数が今より少ない）のバックアップの復元。仮の場所で今の版までマイグレーションを当て、
 * 検査を通してから入れ替える。途中の失敗では元のデータ場所が無傷
 */

const recovery = recoveryFixture(TEST_DATA_KEY);
const NOW = new Date("2026-11-17T01:02:03.000Z");

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("backup-restore-old");
});
afterEach(() => tmp.cleanup());

const dest = () => join(tmp.dir, "dest", "data");
const scratch = () => join(tmp.dir, "scratch");
const backupPath = () => join(tmp.dir, "backup.tbk");

const migrationsFolder = (
  kind: "registry" | "tenant",
  count: number,
  extra?: { tag: string; sql: string },
) => migrationsUpTo(tmp.dir, kind, count, extra);

/** メモリーの上に古い版の DB を作り、fill で行を入れて、平文の SQLite のバイト列を返す（ディスクに書かない） */
function oldDbBytes(folder: string, fill: (db: Database.Database) => void): Buffer {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    migrate(drizzleOf(db, {}), { migrationsFolder: folder });
    fill(db);
    return db.serialize();
  } finally {
    db.close();
  }
}

type OldLedger = {
  entityId: string;
  journals: { id: string; journal_no: number; date: string; memo: string | null }[];
  balances: Record<string, number>;
};

const CASH = "acc-cash";
const SALES = "acc-sales";
const EXPENSE = "acc-expense";

/** 古い版の事業体 1 件（registry と tenant）の .tbk を backupPath() に書く */
function buildOldBackup(version: AppVersion, journals = 5): OldLedger {
  const entityId = randomUUIDv7().toLowerCase();
  const registry = oldDbBytes(migrationsFolder("registry", version.registry), (db) => {
    db.prepare(
      "INSERT INTO entities (id, name, kind, db_file, created_at) VALUES (?, '古い版の事業', 'individual', ?, '2026-01-01T00:00:00.000Z')",
    ).run(entityId, `tenants/${entityId}.sqlite`);
  });
  let rows: OldLedger["journals"] = [];
  const tenant = oldDbBytes(migrationsFolder("tenant", version.tenant), (db) => {
    rows = fillLedger(db, journals, "古い仕訳");
  });
  const files: SnapshotFile[] = [
    { path: "registry.sqlite", bytes: registry },
    { path: `tenants/${entityId}.sqlite`, bytes: tenant },
  ];
  const archive = packArchive({
    files,
    manifest: {
      files: [],
      entities: [{ id: entityId, name: "古い版の事業", fiscalYears: [{ year: 2026, journals }] }],
    },
  });
  writeFileSync(
    backupPath(),
    encryptBackup(archive, TEST_DATA_KEY, {
      appVersion: version,
      macId: "mac-of-old-app",
      createdAt: "2026-10-01T00:00:00.000Z",
      recoveryWrap: recovery.wrap,
    }),
  );
  return { entityId, journals: rows, balances: balancesOf(journals) };
}

/** 古い版の DB（tenant の先頭 2 件以上）に科目・会計期間・仕訳を入れる。入れた仕訳を返す */
function fillLedger(db: Database.Database, journals: number, memoPrefix: string) {
  const rows: OldLedger["journals"] = [];
  const account = db.prepare(
    "INSERT INTO accounts (id, code, name, category, normal_side, report_section, report_line, sort_order, is_system, is_active) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 1)",
  );
  account.run(CASH, "100", "現金", "asset", "debit", "BS_ASSET", 1);
  account.run(SALES, "400", "売上高", "revenue", "credit", "PL_SALES", 2);
  account.run(EXPENSE, "500", "消耗品費", "expense", "debit", "PL_EXPENSE", 3);
  const periodId = randomUUIDv7();
  db.prepare(
    "INSERT INTO fiscal_periods (id, fiscal_year, start_date, end_date, status) VALUES (?, 2026, '2026-01-01', '2026-12-31', 'open')",
  ).run(periodId);
  const journal = db.prepare(
    "INSERT INTO journals (id, journal_no, date, fiscal_period_id, memo, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
  );
  const line = db.prepare(
    "INSERT INTO journal_lines (id, journal_id, line_no, side, account_id, amount, tax_category, tax_amount) VALUES (?, ?, ?, ?, ?, ?, 'OUT_OF_SCOPE', 0)",
  );
  for (let i = 1; i <= journals; i++) {
    const id = randomUUIDv7();
    const date = `2026-0${1 + (i % 9)}-1${i % 10}`;
    const memo = i % 2 === 0 ? null : `${memoPrefix} ${i}`;
    journal.run(
      id,
      i,
      date,
      periodId,
      memo,
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    );
    const amount = 1000 * i + 7;
    const [debit, credit] = i % 3 === 0 ? [EXPENSE, CASH] : [CASH, SALES];
    line.run(randomUUIDv7(), id, 1, "debit", debit, amount);
    line.run(randomUUIDv7(), id, 2, "credit", credit, amount);
    rows.push({ id, journal_no: i, date, memo });
  }
  return rows;
}

/** 仕訳の組み立てと同じ規則で、科目ごとの残高（借方 − 貸方）を計算する */
function balancesOf(journals: number): Record<string, number> {
  const out: Record<string, number> = { [CASH]: 0, [SALES]: 0, [EXPENSE]: 0 };
  for (let i = 1; i <= journals; i++) {
    const amount = 1000 * i + 7;
    const [debit, credit] = i % 3 === 0 ? [EXPENSE, CASH] : [CASH, SALES];
    out[debit] = (out[debit] ?? 0) + amount;
    out[credit] = (out[credit] ?? 0) - amount;
  }
  return out;
}

/** dir を TREBUCHET_DATA_DIR にして fn を実行する（終わったら DB を閉じて戻す） */
function withDataDir<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  process.env.TREBUCHET_DATA_DIR = dir;
  closeAll();
  try {
    return fn();
  } finally {
    closeAll();
    process.env.TREBUCHET_DATA_DIR = tmp.dir;
  }
}

/** 既存の帳簿（今の版）を dest に作る。端末の設定（mac_id・ai_settings）と auth.sqlite つき */
function seedDest(): void {
  withDataDir(dest(), () => {
    createTestEntity({ name: "今の事業" });
    const db = openRegistry().$client;
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('mac_id', ?, ?)").run(
      "mac-of-this-machine",
      "2026-10-30T00:00:00.000Z",
    );
    db.prepare("DELETE FROM ai_settings").run();
    db.prepare(
      "INSERT INTO ai_settings (id, local_enabled, external_enabled, external_base_url, external_model, receipt_images_enabled, updated_at) VALUES (1, 0, 1, 'https://ai.example.com', 'model-x', 1, '2026-10-30T00:00:00.000Z')",
    ).run();
  });
  createAuthFile(join(dest(), "auth.sqlite"), recovery.wrap, "2026-10-30T00:00:00.000Z");
}

function run(io?: Parameters<typeof restoreBackup>[0]["io"]) {
  return restoreBackup({
    file: backupPath(),
    recoveryKey: recovery.text,
    dataDir: dest(),
    tmpRoot: scratch(),
    confirm: () => true,
    now: () => NOW,
    ...(io === undefined ? {} : { io }),
  });
}

/** 暗号化した DB を読み取り専用で開いて fn に渡す（マイグレーションは当てない） */
function readEncrypted<T>(file: string, scope: DbKeyScope, fn: (db: Database.Database) => T): T {
  const db = openEncryptedSqlite(file, scope, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const appliedCount = (db: Database.Database) =>
  (db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;

/** dir の下の全てのファイルとフォルダ（読み取り専用で開いたときの付属ファイルを除く） */
function listAll(dir: string, base = dir): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.endsWith("-wal") || e.name.endsWith("-shm")) continue;
    const p = join(dir, e.name);
    out.push(p.slice(base.length));
    if (e.isDirectory()) out.push(...listAll(p, base));
  }
  return out.sort();
}

const current = currentAppVersion();

describe("古い版のバックアップの復元", () => {
  it.each([
    ["最初期（registry 1・tenant 2）", { registry: 1, tenant: 2 }],
    ["証憑より前（registry 3・tenant 14）", { registry: 3, tenant: 14 }],
    [
      "1 つ前（registry・tenant とも 1 少ない）",
      {
        registry: current.registry - 1,
        tenant: current.tenant - 1,
      },
    ],
    ["tenant だけ古い", { registry: current.registry, tenant: current.tenant - 1 }],
  ])("%s: 入れ替えの前に今の版まで当て、仕訳・残高が同じまま開ける", async (_name, version) => {
    const old = buildOldBackup(version);
    seedDest();

    const result = await run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.appVersion).toEqual(version);

    // 入れ替えた時点で今の版まで当たっている（openTenant の初回の migrate に頼らない）
    const tenantPath = join(dest(), "tenants", `${old.entityId}.sqlite`);
    expect(readEncrypted(join(dest(), "registry.sqlite"), "registry", appliedCount)).toBe(
      current.registry,
    );
    expect(readEncrypted(tenantPath, { tenant: old.entityId }, appliedCount)).toBe(current.tenant);
    // 暗号化のまま（平文の SQLite の見出しではない）
    expect(readFileSync(tenantPath).subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3");
    expect(
      readFileSync(join(dest(), "registry.sqlite")).subarray(0, 15).toString("latin1"),
    ).not.toBe("SQLite format 3");

    withDataDir(dest(), () => {
      const registry = openRegistry().$client;
      expect(registry.prepare("SELECT id, name, status FROM entities").all()).toEqual([
        { id: old.entityId, name: "古い版の事業", status: "active" },
      ]);
      // 端末の設定は今の帳簿の値を引き継ぐ（古い registry でも、当てた後の表に入る）
      expect(registry.prepare("SELECT value FROM app_settings WHERE key = 'mac_id'").get()).toEqual(
        { value: "mac-of-this-machine" },
      );
      expect(
        registry
          .prepare("SELECT external_model, receipt_images_enabled FROM ai_settings WHERE id = 1")
          .get(),
      ).toEqual({ external_model: "model-x", receipt_images_enabled: 1 });

      const db = openTenant(old.entityId);
      expect(
        db.$client
          .prepare("SELECT id, journal_no, date, memo FROM journals ORDER BY journal_no")
          .all(),
      ).toEqual(old.journals);
      const balances: Record<string, number> = { [CASH]: 0, [SALES]: 0, [EXPENSE]: 0 };
      for (const l of new DrizzleLedgerRepository(db).linesInRange("2026-01-01", "2026-12-31")) {
        const signed = l.side === "debit" ? l.amount : -l.amount;
        balances[l.accountId] = (balances[l.accountId] ?? 0) + signed;
      }
      expect(balances).toEqual(old.balances);
      // 開いたときに未適用はない（起動時の退避も作られない）
      expect(existsSync(join(dest(), "pre-migrate"))).toBe(false);
    });
  });

  it("新しい版（tenant が今より 1 多い）は VERSION_MISMATCH で、何も作らず何も変えない", async () => {
    seedDest();
    writeFileSync(
      backupPath(),
      encryptBackup(Buffer.from("x"), TEST_DATA_KEY, {
        appVersion: { registry: current.registry, tenant: current.tenant + 1 },
        macId: "mac-of-new-app",
        createdAt: "2026-12-01T00:00:00.000Z",
        recoveryWrap: recovery.wrap,
      }),
    );
    const before = listAll(tmp.dir);
    let confirmed = 0;
    const result = await restoreBackup({
      file: backupPath(),
      recoveryKey: recovery.text,
      dataDir: dest(),
      tmpRoot: scratch(),
      confirm: () => {
        confirmed += 1;
        return true;
      },
      now: () => NOW,
    });
    expect(result).toEqual({ ok: false, error: "VERSION_MISMATCH" });
    expect(confirmed).toBe(0);
    expect(listAll(tmp.dir)).toEqual(before);
  });

  it("古い版でマイグレーションが途中で失敗すると RESTORE_FAILED で、元のデータ場所は無傷", async () => {
    buildOldBackup({ registry: current.registry, tenant: current.tenant - 1 });
    seedDest();
    const before = listAll(dest());
    const dump = withDataDir(dest(), () =>
      readEncrypted(join(dest(), "registry.sqlite"), "registry", (db) =>
        db.prepare("SELECT id, name FROM entities ORDER BY id").all(),
      ),
    );
    // 今の版のマイグレーションの後ろに、途中で失敗するもの（1 文目は通り、2 文目で失敗する）を差し込む
    const broken = migrationsFolder("tenant", current.tenant, {
      tag: "9999_broken",
      sql: "CREATE TABLE `half_done` (`x` integer) STRICT;\n--> statement-breakpoint\nINSERT INTO `no_such_table` VALUES (1);",
    });
    const result = await run({ migrationsFolders: { tenant: broken } });
    expect(result).toEqual({ ok: false, error: "RESTORE_FAILED" });

    expect(listAll(dest())).toEqual(before);
    const siblings = readdirSync(join(tmp.dir, "dest"));
    expect(siblings.filter((n) => n.includes(".restore-"))).toEqual([]);
    expect(siblings.filter((n) => n.includes(".before-restore-"))).toEqual([]);
    withDataDir(dest(), () => {
      expect(
        readEncrypted(join(dest(), "registry.sqlite"), "registry", (db) =>
          db.prepare("SELECT id, name FROM entities ORDER BY id").all(),
        ),
      ).toEqual(dump);
    });
  });
});

/**
 * 古いスキーマのままのデータ場所（アプリを更新した直後で、server を起動していない）を dest に作る。
 * registry・tenant を先頭の数件だけ当てて暗号化して置き、端末の設定（app_settings・ai_settings）と auth.sqlite を足す。
 * registryFolder を渡すと、registry にはそのフォルダを当てる（今より新しいデータ場所の再現）
 */
function seedOldDest(version: AppVersion, registryFolder?: string) {
  const entityId = randomUUIDv7().toLowerCase();
  mkdirSync(join(dest(), "tenants"), { recursive: true });
  const make = (
    file: string,
    scope: DbKeyScope,
    folder: string,
    fill: (db: Database.Database) => void,
  ) => {
    const db = openEncryptedSqlite(file, scope);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      migrate(drizzleOf(db, {}), { migrationsFolder: folder });
      fill(db);
    } finally {
      db.close();
    }
  };
  make(
    join(dest(), "registry.sqlite"),
    "registry",
    registryFolder ?? migrationsFolder("registry", version.registry),
    (db) => {
      db.prepare(
        "INSERT INTO entities (id, name, kind, db_file, created_at) VALUES (?, '今の事業', 'individual', ?, '2026-01-01T00:00:00.000Z')",
      ).run(entityId, `tenants/${entityId}.sqlite`);
      const setting = db.prepare(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, '2026-10-30T00:00:00.000Z')",
      );
      setting.run("mac_id", "mac-of-this-machine");
      setting.run("backup_folder", "/folder-of-this-machine");
      db.prepare(
        "INSERT INTO ai_settings (id, local_enabled, external_enabled, external_base_url, external_model, updated_at) VALUES (1, 0, 1, 'https://ai.example.com', 'model-x', '2026-10-30T00:00:00.000Z')",
      ).run();
    },
  );
  let journals: OldLedger["journals"] = [];
  make(
    join(dest(), "tenants", `${entityId}.sqlite`),
    { tenant: entityId },
    migrationsFolder("tenant", version.tenant),
    (db) => {
      journals = fillLedger(db, 3, "今の帳簿の仕訳");
    },
  );
  createAuthFile(join(dest(), "auth.sqlite"), recovery.wrap, "2026-10-30T00:00:00.000Z");
  return { entityId, journals };
}

/** dir の DB のファイル（付属の -wal・-shm を除く）の相対パスと SHA-256 */
function hashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of listAll(dir)) {
    if (!rel.endsWith(".sqlite")) continue;
    out[rel] = createHash("sha256")
      .update(readFileSync(join(dir, rel)))
      .digest("hex");
  }
  return out;
}

const scratchLeftovers = () => (existsSync(scratch()) ? readdirSync(scratch()) : []);

describe("古いスキーマのままのデータ場所への復元（server を起動する前）", () => {
  const destVersions: [string, AppVersion][] = [
    ["registry 1・tenant 2", { registry: 1, tenant: 2 }],
    ["registry 3・tenant 14", { registry: 3, tenant: 14 }],
  ];
  const backups: [string, () => AppVersion][] = [
    ["古い版のバックアップ", () => ({ registry: 1, tenant: 2 })],
    ["今の版のバックアップ", () => currentAppVersion()],
  ];

  for (const [destName, destVersion] of destVersions) {
    it.each(backups)(
      `データ場所が ${destName}: %s を復元でき、復元の前の写しが残り、端末の設定を引き継ぎ、元のファイルは変わらない`,
      async (_n, backupVersion) => {
        const old = buildOldBackup(backupVersion());
        const before = seedOldDest(destVersion);
        const beforeHashes = hashes(dest());

        const result = await run();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // 生きていたデータ場所は改名されただけで、DB のファイルは 1 バイトも変わっていない
        expect(result.value.previousDataDir).not.toBeNull();
        expect(hashes(result.value.previousDataDir ?? "")).toEqual(beforeHashes);

        // 復元の前の写しは今の版で、今の帳簿の事業体と仕訳を含む
        const saved = result.value.beforeRestoreBackup;
        expect(saved).not.toBeNull();
        const decrypted = decryptBackup(readFileSync(saved ?? ""), TEST_DATA_KEY, current);
        expect(decrypted.ok).toBe(true);
        if (!decrypted.ok) return;
        expect(decrypted.value.header.appVersion).toEqual(current);
        const unpacked = unpackArchive(decrypted.value.archive);
        expect(unpacked.ok).toBe(true);
        if (!unpacked.ok) return;
        expect(unpacked.value.manifest.entities).toEqual([
          { id: before.entityId, name: "今の事業", fiscalYears: [{ year: 2026, journals: 3 }] },
        ]);

        withDataDir(dest(), () => {
          const registry = openRegistry().$client;
          expect(registry.prepare("SELECT id FROM entities").all()).toEqual([{ id: old.entityId }]);
          expect(
            registry.prepare("SELECT key, value FROM app_settings ORDER BY key").all(),
          ).toEqual([
            { key: "backup_folder", value: "/folder-of-this-machine" },
            { key: "mac_id", value: "mac-of-this-machine" },
          ]);
          expect(
            registry
              .prepare("SELECT external_base_url, external_model FROM ai_settings WHERE id = 1")
              .get(),
          ).toEqual({ external_base_url: "https://ai.example.com", external_model: "model-x" });
          expect(
            openTenant(old.entityId)
              .$client.prepare(
                "SELECT id, journal_no, date, memo FROM journals ORDER BY journal_no",
              )
              .all(),
          ).toEqual(old.journals);
        });
        expect(scratchLeftovers()).toEqual([]);
      },
    );
  }

  it("データ場所が今より新しい版（古いアプリで新しいデータ）なら BEFORE_BACKUP_FAILED で、ファイルは変わらない", async () => {
    buildOldBackup(current);
    const future = migrationsFolder("registry", current.registry, {
      tag: "9999_future",
      sql: "CREATE TABLE `future_table` (`x` integer) STRICT;",
    });
    seedOldDest({ registry: current.registry, tenant: current.tenant }, future);
    const beforeHashes = hashes(dest());
    const result = await run();
    expect(result).toEqual({ ok: false, error: "BEFORE_BACKUP_FAILED" });
    expect(hashes(dest())).toEqual(beforeHashes);
    const siblings = readdirSync(join(tmp.dir, "dest"));
    expect(siblings.filter((n) => n !== "data")).toEqual([]);
    expect(scratchLeftovers()).toEqual([]);
  });

  it.each([
    ["復元先のマイグレーションの途中の失敗", "migration"],
    ["入れ替えの改名の失敗", "rename"],
  ] as const)(
    "%s では RESTORE_FAILED で、元のデータ場所の DB のファイルはバイト単位で変わらない",
    async (_n, kind) => {
      buildOldBackup({ registry: 1, tenant: 2 });
      seedOldDest({ registry: 3, tenant: 14 });
      const beforeHashes = hashes(dest());
      let renames = 0;
      const result = await run(
        kind === "migration"
          ? {
              migrationsFolders: {
                tenant: migrationsFolder("tenant", current.tenant, {
                  tag: "9999_broken",
                  sql: "CREATE TABLE `half_done` (`x` integer) STRICT;\n--> statement-breakpoint\nINSERT INTO `no_such_table` VALUES (1);",
                }),
              },
            }
          : {
              rename: (from, to) => {
                renames += 1;
                if (renames === 2) throw new Error("rename failed");
                renameSync(from, to);
              },
            },
      );
      expect(result).toEqual({ ok: false, error: "RESTORE_FAILED" });
      expect(hashes(dest())).toEqual(beforeHashes);
      const siblings = readdirSync(join(tmp.dir, "dest"));
      expect(siblings.filter((n) => n.includes(".restore-"))).toEqual([]);
      expect(siblings.filter((n) => n.includes(".before-restore-"))).toEqual([]);
      expect(scratchLeftovers()).toEqual([]);
    },
  );
});
