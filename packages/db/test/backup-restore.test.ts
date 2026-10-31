import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packArchive, unpackArchive } from "../src/backup/archive.ts";
import {
  decryptBackup,
  decryptBackupWithRecoveryKey,
  encryptBackup,
} from "../src/backup/crypto.ts";
import { type RestoreSummary, restoreBackup } from "../src/backup/restore.ts";
import { createSnapshotDir, currentAppVersion, snapshotDataDir } from "../src/backup/snapshot.ts";
import type { SnapshotFile } from "../src/backup/types.ts";
import { Database } from "../src/driver.ts";
import { parseRecoveryKey } from "../src/recovery-key.ts";
import {
  closeAll,
  createAuthFile,
  type DbKeyScope,
  openEncryptedSqlite,
  openRegistry,
  withDataKeyOverride,
} from "../src/tenant-store.ts";
import { TEST_DATA_KEY, type TempDataDir, useTempDataDir } from "../src/testing.ts";
import { unwrapDataKey } from "../src/vault-crypto.ts";
import {
  addJournals,
  dumpSchema,
  dumpTables,
  EXCLUDED_REGISTRY_TABLES,
  recoveryFixture,
  seedAuthRows,
  seedEntities,
} from "./backup-fixtures.ts";

/** バックアップを取った時点の回復キー（DK はテスト用の固定の DK。この Mac の帳簿と同じ） */
const recovery = recoveryFixture(TEST_DATA_KEY);
const NOW = new Date("2026-11-01T01:02:03.000Z");

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("backup-restore");
});
afterEach(() => tmp.cleanup());

/** 作業場所は tmp.dir（`.tmp/` の下）の中だけ */
const src = () => join(tmp.dir, "src");
const dest = () => join(tmp.dir, "dest", "data");
const scratch = () => join(tmp.dir, "scratch");
const backupPath = () => join(tmp.dir, "backup.tbk");

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

type Spec = { name: string; journals: number; seed: number };

/** src に合成の事業体と認証の行を作る */
function seedSource(specs: Spec[]): { id: string; name: string }[] {
  return withDataDir(src(), () => {
    openRegistry();
    const entities = seedEntities(
      specs.map((s) => ({ ...s, kind: "individual", memo: "m", note: "n" })),
    );
    seedAuthRows("src");
    return entities;
  });
}

/** dir の DB を読み取り専用で開いて、全ての表の内容を返す */
function dumpDir(dir: string, exclude: readonly string[] = []) {
  const out: Record<string, ReturnType<typeof dumpTables>> = {};
  const open = (file: string, scope: DbKeyScope) =>
    openEncryptedSqlite(file, scope, { readonly: true, fileMustExist: true });
  const registry = open(join(dir, "registry.sqlite"), "registry");
  out.registry = dumpTables(registry, exclude);
  registry.close();
  const tenants = join(dir, "tenants");
  if (existsSync(tenants)) {
    for (const f of readdirSync(tenants).filter((n) => n.endsWith(".sqlite"))) {
      const db = open(join(tenants, f), { tenant: f.slice(0, -".sqlite".length) });
      out[f] = dumpTables(db);
      db.close();
    }
  }
  return out;
}

/** 復元先の registry を読み取り専用で開く（DK から作った鍵で暗号化されている） */
const openRestoredRegistry = (dir: string) =>
  openEncryptedSqlite(join(dir, "registry.sqlite"), "registry", { readonly: true });

function schemaOf(dir: string) {
  const db = openRestoredRegistry(dir);
  try {
    return dumpSchema(db);
  } finally {
    db.close();
  }
}

type BuildOptions = {
  appVersion?: { registry: number; tenant: number };
  mutate?: (files: SnapshotFile[]) => void;
  /** バックアップの DK と recovery の包み（既定はこの Mac の DK と `recovery`） */
  dk?: Uint8Array;
  wrap?: ReturnType<typeof recoveryFixture>["wrap"];
};

/** src から .tbk を作って backupPath() に書く */
function buildBackup(options: BuildOptions = {}): Buffer {
  const snapDir = createSnapshotDir(scratch());
  try {
    const snap = snapshotDataDir(src(), snapDir);
    options.mutate?.(snap.files);
    const bytes = encryptBackup(packArchive(snap), options.dk ?? TEST_DATA_KEY, {
      appVersion: options.appVersion ?? currentAppVersion(),
      macId: "mac-from-source",
      createdAt: "2026-10-31T09:00:00.000Z",
      recoveryWrap: options.wrap ?? recovery.wrap,
    });
    writeFileSync(backupPath(), bytes);
    return bytes;
  } finally {
    rmSync(snapDir, { recursive: true, force: true });
  }
}

type Overrides = Partial<Parameters<typeof restoreBackup>[0]>;

function run(overrides: Overrides = {}) {
  const summaries: RestoreSummary[] = [];
  const promise = restoreBackup({
    file: backupPath(),
    recoveryKey: recovery.text,
    dataDir: dest(),
    tmpRoot: scratch(),
    confirm: (s) => {
      summaries.push(s);
      return true;
    },
    now: () => NOW,
    ...overrides,
  });
  return { promise, summaries };
}

/** 復元で作られた auth.sqlite（暗号化しない）の表の件数と recovery の包み */
function readAuth(dir: string) {
  const db = new Database(join(dir, "auth.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const count = (table: string) =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const wraps = db
      .prepare("SELECT kind, credential_id, salt, iv, tag, wrapped FROM key_wraps")
      .all() as {
      kind: string;
      credential_id: string | null;
      salt: Buffer;
      iv: Buffer;
      tag: Buffer;
      wrapped: Buffer;
    }[];
    return {
      passkeys: count("passkeys"),
      sessions: count("sessions"),
      wraps,
    };
  } finally {
    db.close();
  }
}

/** 回復キーで復元後の auth.sqlite の recovery の包みを開いた DK */
function dkFromRestoredAuth(dir: string, recoveryText: string): Buffer | null {
  const wrap = readAuth(dir).wraps[0];
  const secret = parseRecoveryKey(recoveryText);
  if (wrap === undefined || secret === null) return null;
  return unwrapDataKey(wrap, secret, "recovery", null);
}

/** tmp.dir の下の全ファイルとフォルダの相対パス（`.tbk` の作業ファイルを除く観点で呼び出し側が比べる） */
function listAll(dir: string, base = dir): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // 読み取り専用で開くと SQLite が作る付属ファイルは、帳簿の内容ではないので数えない
    if (e.name.endsWith("-wal") || e.name.endsWith("-shm")) continue;
    const p = join(dir, e.name);
    out.push(p.slice(base.length));
    if (e.isDirectory()) out.push(...listAll(p, base));
  }
  return out.sort();
}

const siblings = (pattern: RegExp) =>
  readdirSync(join(tmp.dir, "dest")).filter((n) => pattern.test(n));

/**
 * 既存の帳簿のある dest を作る（別の事業体と認証の行つき）。`auth.sqlite` には recovery の包み
 * （既定は `recovery`。`wrap: null` なら auth.sqlite を作らない）を入れる。`dk` を渡すと、その DK で帳簿を暗号化する
 */
function seedDest(
  options: { dk?: Uint8Array; wrap?: ReturnType<typeof recoveryFixture>["wrap"] | null } = {},
): { id: string; name: string } {
  const seed = () => seedDestLedger();
  const made = options.dk === undefined ? seed() : withDataKeyOverride(options.dk, seed);
  const wrap = options.wrap === undefined ? recovery.wrap : options.wrap;
  if (wrap !== null) createAuthFile(join(dest(), "auth.sqlite"), wrap, "2026-10-30T00:00:00.000Z");
  return made;
}

function seedDestLedger(): { id: string; name: string } {
  const [e] = withDataDir(dest(), () => {
    openRegistry();
    const made = seedEntities([
      { name: "既存の事業", kind: "individual", seed: 77, journals: 3, memo: "d", note: "d" },
    ]);
    const db = openRegistry().$client;
    db.prepare("DELETE FROM app_settings").run();
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "mac_id",
      "mac-of-this-machine",
      "2026-10-30T00:00:00.000Z",
    );
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "backup_folder",
      "/folder-of-this-machine",
      "2026-10-30T00:00:00.000Z",
    );
    // 006: AI の接続の設定も端末の値（バックアップの元の値ではない）
    db.prepare("DELETE FROM ai_settings").run();
    db.prepare(
      "INSERT INTO ai_settings (id, local_enabled, external_enabled, external_base_url, external_model, updated_at) VALUES (1, 0, 1, ?, ?, ?)",
    ).run(
      "https://ai-of-this-machine.example.com",
      "model-of-this-machine",
      "2026-10-30T00:00:00.000Z",
    );
    return made;
  });
  if (e === undefined) throw new Error("seed 失敗");
  return e;
}

describe("restoreBackup: 空の場所への復元", () => {
  it("全ての表の内容が元と一致し（複数の事業体、数百の仕訳、取込・決算の表を含む）、端末の表は空", async () => {
    seedSource([
      { name: "事業A", journals: 150, seed: 1 },
      { name: "事業B", journals: 120, seed: 2 },
      { name: "事業C", journals: 40, seed: 3 },
    ]);
    const expected = dumpDir(src(), EXCLUDED_REGISTRY_TABLES);
    const expectedSchema = schemaOf(src());
    await buildBackup();
    mkdirSync(dest(), { recursive: true }); // 空の場所

    const { promise, summaries } = run();
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.entities.map((e) => e.name).sort()).toEqual(["事業A", "事業B", "事業C"]);
    expect(summaries[0]?.macId).toBe("mac-from-source");
    expect(summaries[0]?.differences).toEqual([]);
    // 全ての表の内容が元と一致する（INV-25・SC-003）
    const actual = dumpDir(dest(), EXCLUDED_REGISTRY_TABLES);
    expect(actual).toEqual(expected);
    expect(Object.keys(actual)).toHaveLength(4);
    const closing = Object.values(actual)
      .flatMap((t) => Object.keys(t))
      .filter((n) => n === "closing_notes" || n === "import_batches");
    expect(closing.length).toBeGreaterThan(0);
    // 端末の表の行がない
    const registry = openRestoredRegistry(dest());
    try {
      for (const table of EXCLUDED_REGISTRY_TABLES) {
        expect(registry.prepare(`SELECT count(*) AS n FROM "${table}"`).get()).toEqual({ n: 0 });
      }
    } finally {
      registry.close();
    }
    // 認証の表はバックアップに含めない。auth.sqlite は recovery の包みだけで作り直す（008 の D9）
    const auth = readAuth(dest());
    expect(auth.passkeys).toBe(0);
    expect(auth.sessions).toBe(0);
    expect(auth.wraps.map((w) => [w.kind, w.credential_id])).toEqual([["recovery", null]]);
    // その包みは、バックアップを取った時点の回復キーで、同じ DK に開く
    expect(dkFromRestoredAuth(dest(), recovery.text)?.equals(Buffer.from(TEST_DATA_KEY))).toBe(
      true,
    );
    expect(schemaOf(dest())).toEqual(expectedSchema);
    // 空の場所なので、復元前のバックアップと before-restore は作らない
    if (result.ok) {
      expect(result.value.beforeRestoreBackup).toBeNull();
      expect(result.value.previousDataDir).toBeNull();
    }
    expect(readdirSync(join(tmp.dir, "dest"))).toEqual(["data"]);
    expect(siblings(/\.restore-/)).toEqual([]);
  });

  it("存在しない場所（親だけある）にも復元できる", async () => {
    seedSource([{ name: "事業", journals: 5, seed: 1 }]);
    await buildBackup();
    mkdirSync(join(tmp.dir, "dest"), { recursive: true });
    expect((await run().promise).ok).toBe(true);
    expect(existsSync(join(dest(), "registry.sqlite"))).toBe(true);
  });

  it("事業体 0 件のバックアップを空の場所に復元でき、事業体 0 件の帳簿になる", async () => {
    withDataDir(src(), () => {
      openRegistry();
      seedAuthRows("src");
    });
    await buildBackup();
    const { promise, summaries } = run();
    expect((await promise).ok).toBe(true);
    expect(summaries[0]?.entities).toEqual([]);
    const registry = openRestoredRegistry(dest());
    try {
      expect(registry.prepare("SELECT count(*) AS n FROM entities").get()).toEqual({ n: 0 });
      expect(registry.prepare("SELECT count(*) AS n FROM app_settings").get()).toEqual({ n: 0 });
    } finally {
      registry.close();
    }
    expect(existsSync(join(dest(), "tenants"))).toBe(true);
    expect(readdirSync(join(dest(), "tenants"))).toEqual([]);
  });
});

describe("restoreBackup: 既存の帳簿がある場所への復元", () => {
  it("復元前のバックアップと before-restore ができ、元の内容が残り、app_settings が引き継がれる", async () => {
    seedSource([{ name: "事業A", journals: 10, seed: 1 }]);
    const expectedNew = dumpDir(src(), EXCLUDED_REGISTRY_TABLES);
    await buildBackup();
    seedDest();
    const before = dumpDir(dest());

    const { promise, summaries } = run();
    const result = await promise;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stamp = "20261101-010203";
    expect(result.value.beforeRestoreBackup).toBe(
      join(tmp.dir, "dest", `trebuchet-before-restore-${stamp}.tbk`),
    );
    expect(result.value.previousDataDir).toBe(`${dest()}.before-restore-${stamp}`);
    expect(summaries[0]?.hasExistingLedger).toBe(true);

    // 元の内容が before-restore に残る
    expect(dumpDir(`${dest()}.before-restore-${stamp}`)).toEqual(before);
    // 復元後は新しい内容。app_settings だけ元の Mac のもの（mac_id を含む）を引き継ぐ
    expect(dumpDir(dest(), EXCLUDED_REGISTRY_TABLES)).toEqual(expectedNew);
    const registry = openRestoredRegistry(dest());
    try {
      expect(registry.prepare("SELECT key, value FROM app_settings ORDER BY key").all()).toEqual([
        { key: "backup_folder", value: "/folder-of-this-machine" },
        { key: "mac_id", value: "mac-of-this-machine" },
      ]);
      // ai_settings も app_settings と同じく、元の Mac の値のまま引き継ぐ
      expect(
        registry
          .prepare(
            "SELECT id, local_enabled, external_enabled, external_base_url, external_model, updated_at FROM ai_settings",
          )
          .all(),
      ).toEqual([
        {
          id: 1,
          local_enabled: 0,
          external_enabled: 1,
          external_base_url: "https://ai-of-this-machine.example.com",
          external_model: "model-of-this-machine",
          updated_at: "2026-10-30T00:00:00.000Z",
        },
      ]);
    } finally {
      registry.close();
    }

    // 復元前のバックアップを同じ DK・同じ回復キーで復号できる（中身は元の帳簿）
    const bytes = readFileSync(result.value.beforeRestoreBackup ?? "");
    const decrypted = decryptBackup(bytes, TEST_DATA_KEY, currentAppVersion());
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) return;
    expect(decrypted.value.header.macId).toBe("mac-of-this-machine");
    const unpacked = unpackArchive(decrypted.value.archive);
    expect(unpacked.ok).toBe(true);
    if (unpacked.ok) {
      expect(unpacked.value.manifest.entities.map((e) => e.name)).toEqual(["既存の事業"]);
    }
    // 復元前のバックアップは別の DK では開かない。ヘッダーの包みは今の回復キーで開く
    expect(decryptBackup(bytes, randomBytes(32), currentAppVersion()).ok).toBe(false);
    expect(decryptBackupWithRecoveryKey(bytes, recovery.text, currentAppVersion()).ok).toBe(true);

    // 平文の展開先と平文の写しが残らない
    expect(siblings(/\.restore-/)).toEqual([]);
    expect(readdirSync(scratch()).filter((n) => n.startsWith("backup-snapshot-"))).toEqual([]);
  });

  it("復元先に同じ事業体があるとき、要約に事業体ごとの差（仕訳の件数、最後の更新）が出る", async () => {
    const [e] = seedSource([
      { name: "事業A", journals: 3, seed: 1 },
      { name: "事業B", journals: 2, seed: 2 },
    ]);
    await buildBackup();
    // いったん復元し、dest の事業 A に仕訳を足す
    expect((await run().promise).ok).toBe(true);
    withDataDir(dest(), () => addJournals(e?.id ?? "", 4, 9));

    const { promise, summaries } = run({ now: () => new Date("2026-11-02T00:00:00.000Z") });
    expect((await promise).ok).toBe(true);
    const diffs = summaries[0]?.differences ?? [];
    expect(diffs).toHaveLength(2);
    const a = diffs.find((d) => d.id === e?.id);
    expect(a).toMatchObject({
      name: "事業A",
      current: { journals: 7, lastUpdatedAt: "2026-10-31T09:00:00.000Z" },
      backup: { journals: 3, lastUpdatedAt: "2026-10-31T09:00:00.000Z" },
    });
  });

  it("バックアップにない事業体は差に出ない", async () => {
    seedSource([{ name: "事業A", journals: 1, seed: 1 }]);
    await buildBackup();
    seedDest();
    const { promise, summaries } = run();
    expect((await promise).ok).toBe(true);
    expect(summaries[0]?.differences).toEqual([]);
  });
});

describe("restoreBackup: 全部か無か", () => {
  async function failureSetup() {
    seedSource([{ name: "事業A", journals: 6, seed: 1 }]);
    seedDest();
    const before = dumpDir(dest());
    const files = listAll(dest());
    return { before, files };
  }

  function expectIntact(before: ReturnType<typeof dumpDir>, files: string[]) {
    expect(dumpDir(dest())).toEqual(before);
    expect(listAll(dest())).toEqual(files);
    expect(siblings(/\.restore-/)).toEqual([]);
    expect(siblings(/^data\.before-restore-/)).toEqual([]);
    const leftovers = existsSync(scratch())
      ? readdirSync(scratch()).filter((n) => n.startsWith("backup-snapshot-"))
      : [];
    expect(leftovers).toEqual([]);
  }

  it("展開の失敗で、元の dataDir が無傷で残り、展開先が残らない", async () => {
    const { before, files } = await failureSetup();
    await buildBackup();
    let calls = 0;
    const result = await run({
      io: {
        writeFile: (path, bytes) => {
          calls += 1;
          if (calls === 2) throw new Error("disk full");
          writeFileSync(path, bytes);
        },
      },
    }).promise;
    expect(result).toEqual({ ok: false, error: "RESTORE_FAILED" });
    expect(calls).toBe(2);
    expectIntact(before, files);
  });

  it("integrity_check の失敗（壊れた DB を含むバックアップ）で、元が残り、展開先が残らない", async () => {
    const { before, files } = await failureSetup();
    await buildBackup({
      mutate: (all) => {
        const tenant = all.find((f) => f.path.startsWith("tenants/"));
        if (tenant === undefined) throw new Error("tenant がない");
        // SQLite のヘッダーを壊す（SHA-256 は packArchive が壊れた中身で計算し直す）
        tenant.bytes = Buffer.concat([Buffer.from("not a database!!!"), tenant.bytes.subarray(17)]);
      },
    });
    const result = await run().promise;
    expect(result).toEqual({ ok: false, error: "RESTORE_FAILED" });
    expectIntact(before, files);
  });

  it("2 回目の改名の失敗で、1 回目を元に戻し、展開先を消す", async () => {
    const { before, files } = await failureSetup();
    await buildBackup();
    const renames: string[] = [];
    const result = await run({
      io: {
        rename: (from, to) => {
          renames.push(`${from} -> ${to}`);
          if (renames.length === 2) throw new Error("rename failed");
          renameSync(from, to);
        },
      },
    }).promise;
    expect(result).toEqual({ ok: false, error: "RESTORE_FAILED" });
    expect(renames).toHaveLength(3); // dataDir → before-restore、展開先 → dataDir（失敗）、元に戻す
    expectIntact(before, files);
  });

  it("復元前のバックアップの失敗で中止し、何も変えない", async () => {
    const { before, files } = await failureSetup();
    await buildBackup();
    // 復元前のバックアップの置き場所（dataDir の親）に、同じ名前のフォルダを作って書き込みを失敗させる
    mkdirSync(join(tmp.dir, "dest", ".trebuchet-before-restore-20261101-010203.tbk.partial"));
    const result = await run().promise;
    expect(result).toEqual({ ok: false, error: "BEFORE_BACKUP_FAILED" });
    rmSync(join(tmp.dir, "dest", ".trebuchet-before-restore-20261101-010203.tbk.partial"), {
      recursive: true,
    });
    expect(readdirSync(join(tmp.dir, "dest")).filter((n) => n.endsWith(".tbk"))).toEqual([]);
    expectIntact(before, files);
  });
});

describe("restoreBackup: 検査の失敗は何も作らない", () => {
  const snapshotOfTmp = () => listAll(tmp.dir);

  it.each([
    [
      "新しい版",
      { registry: currentAppVersion().registry + 1, tenant: currentAppVersion().tenant },
    ],
    ["古い版", { registry: currentAppVersion().registry - 1, tenant: currentAppVersion().tenant }],
    [
      "tenant が新しい版",
      { registry: currentAppVersion().registry, tenant: currentAppVersion().tenant + 1 },
    ],
  ])(
    "版の違うバックアップ（%s）は VERSION_MISMATCH で拒否し、何も作らない",
    async (_n, appVersion) => {
      seedSource([{ name: "事業A", journals: 2, seed: 1 }]);
      seedDest();
      await buildBackup({ appVersion });
      const before = snapshotOfTmp();
      const dump = dumpDir(dest());
      let confirmed = 0;
      const result = await run({
        confirm: () => {
          confirmed += 1;
          return true;
        },
      }).promise;
      expect(result).toEqual({ ok: false, error: "VERSION_MISMATCH" });
      expect(confirmed).toBe(0);
      expect(snapshotOfTmp()).toEqual(before);
      expect(dumpDir(dest())).toEqual(dump);
    },
  );

  it("誤った回復キー・形の違うキーは何も作らず、帳簿が変わらない（SC-004、INV-54）", async () => {
    seedSource([{ name: "事業A", journals: 2, seed: 1 }]);
    seedDest();
    await buildBackup();
    const before = snapshotOfTmp();
    const dump = dumpDir(dest());
    for (const recoveryKey of [recoveryFixture(TEST_DATA_KEY).text, "wrong key", ""]) {
      const result = await run({ recoveryKey }).promise;
      expect(result).toEqual({ ok: false, error: "INVALID" });
    }
    expect(snapshotOfTmp()).toEqual(before);
    expect(dumpDir(dest())).toEqual(dump);
  });

  it("1 バイトの書き換え、切り詰め、存在しないファイルも INVALID で、何も作らない", async () => {
    seedSource([{ name: "事業A", journals: 2, seed: 1 }]);
    seedDest();
    const bytes = await buildBackup();
    const dump = dumpDir(dest());
    const cases: Buffer[] = [];
    const flipped = Buffer.from(bytes);
    flipped[Math.floor(flipped.length / 2)] = (flipped[Math.floor(flipped.length / 2)] ?? 0) ^ 1;
    cases.push(flipped, bytes.subarray(0, bytes.length - 1), bytes.subarray(0, 40));
    for (const c of cases) {
      writeFileSync(backupPath(), c);
      const before = snapshotOfTmp();
      expect(await run().promise).toEqual({ ok: false, error: "INVALID" });
      expect(snapshotOfTmp()).toEqual(before);
    }
    rmSync(backupPath());
    expect(await run({ file: join(tmp.dir, "missing.tbk") }).promise).toEqual({
      ok: false,
      error: "INVALID",
    });
    expect(dumpDir(dest())).toEqual(dump);
  });

  it("確認で拒否すると CANCELLED で、何も作らない", async () => {
    seedSource([{ name: "事業A", journals: 2, seed: 1 }]);
    seedDest();
    await buildBackup();
    const before = snapshotOfTmp();
    const result = await run({ confirm: () => false }).promise;
    expect(result).toEqual({ ok: false, error: "CANCELLED" });
    expect(snapshotOfTmp()).toEqual(before);
  });

  it("回復キーはエラーの値にも要約にも出ない", async () => {
    seedSource([{ name: "事業A", journals: 1, seed: 1 }]);
    await buildBackup();
    const bad = recoveryFixture(TEST_DATA_KEY).text;
    expect(JSON.stringify(await run({ recoveryKey: bad }).promise)).not.toContain(bad);
    const ok = run();
    const result = await ok.promise;
    expect(JSON.stringify(result) + JSON.stringify(ok.summaries)).not.toContain(recovery.text);
  });
});

describe("restoreBackup: 鍵（008 の D9）", () => {
  it("新しい Mac（別の DK の空の場所）でも、バックアップの回復キーだけで復元でき、帳簿は取った DK で暗号化される", async () => {
    seedSource([{ name: "事業A", journals: 4, seed: 1 }]);
    const expected = dumpDir(src(), EXCLUDED_REGISTRY_TABLES);
    const otherDk = randomBytes(32);
    const otherRecovery = recoveryFixture(otherDk);
    buildBackup({ dk: otherDk, wrap: otherRecovery.wrap });
    mkdirSync(dest(), { recursive: true });

    // この Mac の DK（テスト用の固定の DK）ではなく、バックアップの DK で復元される
    const result = await run({ recoveryKey: otherRecovery.text }).promise;
    expect(result.ok).toBe(true);
    expect(withDataKeyOverride(otherDk, () => dumpDir(dest(), EXCLUDED_REGISTRY_TABLES))).toEqual(
      expected,
    );
    expect(() => dumpDir(dest())).toThrow(); // この Mac の DK では開かない
    expect(dkFromRestoredAuth(dest(), otherRecovery.text)?.equals(otherDk)).toBe(true);
    // この Mac の回復キーでは、バックアップの DK は開かない
    expect(await run({ recoveryKey: recovery.text }).promise).toEqual({
      ok: false,
      error: "INVALID",
    });
  });

  it("回復キーを再発行した後でも、古いバックアップを今の回復キーで復元でき、今の包みが残る", async () => {
    seedSource([{ name: "事業A", journals: 2, seed: 1 }]);
    const expected = dumpDir(src(), EXCLUDED_REGISTRY_TABLES);
    const reissued = recoveryFixture(TEST_DATA_KEY); // 再発行後のキー（DK は同じ）
    buildBackup(); // ヘッダーの包みは古い `recovery`
    seedDest({ wrap: reissued.wrap }); // 今の auth.sqlite の recovery は再発行後

    // 古いキーは、ヘッダーの包みで開く
    expect((await run({ recoveryKey: recovery.text }).promise).ok).toBe(true);
    expect(dkFromRestoredAuth(dest(), recovery.text)?.equals(Buffer.from(TEST_DATA_KEY))).toBe(
      true,
    );

    // 今のキーは、ヘッダーの包みでは開かず、今の auth.sqlite の包みで開く
    rmSync(dest(), { recursive: true, force: true });
    seedDest({ wrap: reissued.wrap });
    const result = await run({ recoveryKey: reissued.text }).promise;
    expect(result.ok).toBe(true);
    expect(dumpDir(dest(), EXCLUDED_REGISTRY_TABLES)).toEqual(expected);
    expect(dkFromRestoredAuth(dest(), reissued.text)?.equals(Buffer.from(TEST_DATA_KEY))).toBe(
      true,
    );
    expect(dkFromRestoredAuth(dest(), recovery.text)).toBeNull();
  });

  it("今の帳簿が別の DK で読めないとき、復元前のバックアップは作らず、元のデータ場所は before-restore に残す", async () => {
    seedSource([{ name: "事業A", journals: 2, seed: 1 }]);
    const expected = dumpDir(src(), EXCLUDED_REGISTRY_TABLES);
    buildBackup();
    seedDest({ dk: randomBytes(32), wrap: null }); // 別の DK の帳簿で、開く包みもない

    const { promise, summaries } = run();
    const result = await promise;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summaries[0]?.hasExistingLedger).toBe(true);
    expect(summaries[0]?.differences).toEqual([]);
    expect(result.value.beforeRestoreBackup).toBeNull();
    expect(result.value.previousDataDir).toBe(`${dest()}.before-restore-20261101-010203`);
    expect(existsSync(join(result.value.previousDataDir ?? "", "registry.sqlite"))).toBe(true);
    expect(dumpDir(dest(), EXCLUDED_REGISTRY_TABLES)).toEqual(expected);
  });
});

// 乱数が衝突しないことの確認（同じ秒に 2 回復元しても、前の before-restore を上書きしない）
describe("restoreBackup: 同じ秒の 2 回目", () => {
  it("復元前のバックアップと before-restore の名前が衝突せず、前のものを上書きしない", async () => {
    seedSource([{ name: "事業A", journals: 2, seed: 1 }]);
    await buildBackup();
    seedDest();
    const first = await run().promise;
    const second = await run().promise;
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.beforeRestoreBackup).not.toBe(first.value.beforeRestoreBackup);
    expect(second.value.previousDataDir).not.toBe(first.value.previousDataDir);
    expect(existsSync(first.value.beforeRestoreBackup ?? "")).toBe(true);
    expect(existsSync(first.value.previousDataDir ?? "")).toBe(true);
  });
});
