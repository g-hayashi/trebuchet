import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packArchive } from "../src/backup/archive.ts";
import { encryptBackup } from "../src/backup/crypto.ts";
import {
  RECEIPT_STORE_DIRNAME,
  ReceiptSyncError,
  receiptBackupName,
  receiptRefsFromSnapshotFiles,
  receiptStoreDir,
  restoreReceiptsFromStore,
  syncReceiptsToStore,
} from "../src/backup/receipts.ts";
import { restoreBackup } from "../src/backup/restore.ts";
import { createSnapshotDir, currentAppVersion, snapshotDataDir } from "../src/backup/snapshot.ts";
import { createReceiptFileStore, decryptReceipt } from "../src/receipt-files.ts";
import { closeAll, dataDir, openRegistry, openTenant, receiptFile } from "../src/tenant-store.ts";
import {
  createTestEntity,
  TEST_DATA_KEY,
  type TempDataDir,
  useTempDataDir,
} from "../src/testing.ts";
import { recoveryFixture, seedEntities } from "./backup-fixtures.ts";
import { receiptDb } from "./receipt-db-setup.ts";

// バックアップの証憑の写しと復元（010 T024・T025、R11、data-model §1.8、INV-68）

const recovery = recoveryFixture(TEST_DATA_KEY);
const dk = () => Buffer.from(TEST_DATA_KEY);
const NOW = new Date("2026-11-01T01:02:03.000Z");

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("backup-receipts");
});
afterEach(() => tmp.cleanup());

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const folder = () => join(tmp.dir, "backups");
const storeDir = () => receiptStoreDir(folder());
const sampleBytes = (label: string) => Buffer.from(`synthetic-receipt-${label}-${"x".repeat(64)}`);

/** 今のデータ場所に、事業体と証憑 n 件（DB の行と暗号化したファイル）を作る */
function addReceipts(entityId: string, labels: string[]): string[] {
  const store = createReceiptFileStore(entityId);
  const db = receiptDb(openTenant(entityId));
  return labels.map((label) => {
    const bytes = sampleBytes(label);
    const sha = store.digest(bytes);
    store.put(sha, bytes);
    db.addReceipt({ current_sha256: sha }, { sha256: sha });
    return sha;
  });
}

const listFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("receiptBackupName", () => {
  it("HMAC-SHA256(Kname, sha256) の 16 進で、Kname = HKDF(DK, 空, receipt-name/v1)。平文のハッシュと違う", () => {
    const sha = sha256(sampleBytes("a"));
    const kname = Buffer.from(
      hkdfSync("sha256", TEST_DATA_KEY, Buffer.alloc(0), "trebuchet/backup/receipt-name/v1", 32),
    );
    const expected = createHmac("sha256", kname).update(sha).digest("hex");
    const name = receiptBackupName(dk(), sha);
    expect(name).toBe(expected);
    expect(name).toMatch(/^[0-9a-f]{64}$/);
    expect(name).not.toBe(sha);
    // 同じ DK なら毎回同じ（増分の写しになる）。別の DK では変わる
    expect(receiptBackupName(dk(), sha)).toBe(name);
    expect(receiptBackupName(Buffer.alloc(32, 1), sha)).not.toBe(name);
  });
});

describe("syncReceiptsToStore", () => {
  it("置き場所の名前は平文のハッシュと違い、中身はデータ場所のファイルと同じバイト列", async () => {
    const e = createTestEntity();
    const shas = addReceipts(e.id, ["a", "b"]);
    mkdirSync(folder(), { recursive: true });

    const result = await syncReceiptsToStore({
      dk: dk(),
      storeDir: storeDir(),
      refs: [{ entityId: e.id, sha256s: shas }],
    });

    expect(result).toEqual({ copied: 2, present: 0 });
    // 置き場所は .tmp/ の下（useTempDataDir の中）で、証憑の写しは trebuchet-receipts/<entityId>/ に置く
    expect(storeDir().startsWith(tmp.dir)).toBe(true);
    expect(storeDir()).toBe(join(folder(), RECEIPT_STORE_DIRNAME));
    const names = listFiles(join(storeDir(), e.id));
    expect(names).toEqual(shas.map((s) => `${receiptBackupName(dk(), s)}.trc`).sort());
    for (const sha of shas) {
      expect(names.some((n) => n.includes(sha))).toBe(false);
      const copy = readFileSync(join(storeDir(), e.id, `${receiptBackupName(dk(), sha)}.trc`));
      expect(copy.equals(readFileSync(receiptFile(e.id, sha)))).toBe(true);
      // バックアップの DK で復号するとハッシュに一致する
      expect(sha256(decryptReceipt(copy, e.id, sha, dk()))).toBe(sha);
    }
    // 作業中の .partial を残さない
    expect(names.some((n) => n.endsWith(".partial"))).toBe(false);
  });

  it("2 回目は写さない。増えた分だけ写す", async () => {
    const e = createTestEntity();
    const [a] = addReceipts(e.id, ["a"]);
    mkdirSync(folder(), { recursive: true });
    const sync = (shas: string[]) =>
      syncReceiptsToStore({
        dk: dk(),
        storeDir: storeDir(),
        refs: [{ entityId: e.id, sha256s: shas }],
      });
    expect(await sync([a ?? ""])).toEqual({ copied: 1, present: 0 });
    const file = join(storeDir(), e.id, `${receiptBackupName(dk(), a ?? "")}.trc`);
    const past = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(file, past, past);

    expect(await sync([a ?? ""])).toEqual({ copied: 0, present: 1 });
    expect(statSync(file).mtime.getTime()).toBe(past.getTime());

    const [b] = addReceipts(e.id, ["b"]);
    expect(await sync([a ?? "", b ?? ""])).toEqual({ copied: 1, present: 1 });
    expect(statSync(file).mtime.getTime()).toBe(past.getTime());
  });

  it("証憑 0 件なら何も作らない", async () => {
    const e = createTestEntity();
    mkdirSync(folder(), { recursive: true });
    const result = await syncReceiptsToStore({
      dk: dk(),
      storeDir: storeDir(),
      refs: [{ entityId: e.id, sha256s: [] }],
    });
    expect(result).toEqual({ copied: 0, present: 0 });
    expect(existsSync(join(storeDir(), e.id))).toBe(false);
  });

  it("データ場所のファイルが欠けていれば ReceiptSyncError（名前の位置にも .partial にも残さない）", async () => {
    const e = createTestEntity();
    const [a, b] = addReceipts(e.id, ["a", "b"]);
    mkdirSync(folder(), { recursive: true });
    rmSync(receiptFile(e.id, b ?? ""));

    await expect(
      syncReceiptsToStore({
        dk: dk(),
        storeDir: storeDir(),
        refs: [{ entityId: e.id, sha256s: [a ?? "", b ?? ""] }],
      }),
    ).rejects.toBeInstanceOf(ReceiptSyncError);
    const leftover = listFiles(join(storeDir(), e.id));
    expect(leftover.some((n) => n.endsWith(".partial"))).toBe(false);
    expect(leftover).not.toContain(`${receiptBackupName(dk(), b ?? "")}.trc`);
  });

  it("データ場所のファイルが改ざんされていれば ReceiptSyncError（壊れたものを置き場所に入れない）", async () => {
    const e = createTestEntity();
    const [a] = addReceipts(e.id, ["a"]);
    mkdirSync(folder(), { recursive: true });
    const path = receiptFile(e.id, a ?? "");
    const bytes = readFileSync(path);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff;
    writeFileSync(path, bytes);

    await expect(
      syncReceiptsToStore({
        dk: dk(),
        storeDir: storeDir(),
        refs: [{ entityId: e.id, sha256s: [a ?? ""] }],
      }),
    ).rejects.toBeInstanceOf(ReceiptSyncError);
    expect(listFiles(join(storeDir(), e.id))).toEqual([]);
  });

  it("置き場所のファイルが欠けた（大きさが違う）ときは写し直す", async () => {
    const e = createTestEntity();
    const [a] = addReceipts(e.id, ["a"]);
    mkdirSync(folder(), { recursive: true });
    const sync = () =>
      syncReceiptsToStore({
        dk: dk(),
        storeDir: storeDir(),
        refs: [{ entityId: e.id, sha256s: [a ?? ""] }],
      });
    await sync();
    const file = join(storeDir(), e.id, `${receiptBackupName(dk(), a ?? "")}.trc`);
    writeFileSync(file, readFileSync(file).subarray(0, 10));

    expect(await sync()).toEqual({ copied: 1, present: 0 });
    expect(readFileSync(file).equals(readFileSync(receiptFile(e.id, a ?? "")))).toBe(true);
  });

  it("DK が違えば復号の検証で失敗する", async () => {
    const e = createTestEntity();
    const [a] = addReceipts(e.id, ["a"]);
    mkdirSync(folder(), { recursive: true });
    await expect(
      syncReceiptsToStore({
        dk: Buffer.alloc(32, 9),
        storeDir: storeDir(),
        refs: [{ entityId: e.id, sha256s: [a ?? ""] }],
      }),
    ).rejects.toBeInstanceOf(ReceiptSyncError);
  });
});

describe("restoreReceiptsFromStore", () => {
  it("置き場所から読み、データ場所と同じ名前・同じバイト列で書く。欠け・改ざんは数える", async () => {
    const e = createTestEntity();
    const [a, b, c] = addReceipts(e.id, ["a", "b", "c"]);
    mkdirSync(folder(), { recursive: true });
    const refs = [{ entityId: e.id, sha256s: [a ?? "", b ?? "", c ?? ""] }];
    await syncReceiptsToStore({ dk: dk(), storeDir: storeDir(), refs });
    const store = (s: string | undefined) =>
      join(storeDir(), e.id, `${receiptBackupName(dk(), s ?? "")}.trc`);
    rmSync(store(b));
    const tampered = readFileSync(store(c));
    tampered[20] = (tampered[20] ?? 0) ^ 0xff;
    writeFileSync(store(c), tampered);

    const target = join(tmp.dir, "restored");
    const result = restoreReceiptsFromStore({
      dk: dk(),
      storeDir: storeDir(),
      refs,
      targetDir: target,
    });

    expect(result).toEqual({ restored: 1, missing: 2 });
    expect(listFiles(join(target, e.id))).toEqual([`${a}.trc`]);
    expect(
      readFileSync(join(target, e.id, `${a}.trc`)).equals(readFileSync(receiptFile(e.id, a ?? ""))),
    ).toBe(true);
  });
});

describe("receiptRefsFromSnapshotFiles", () => {
  it("写した各事業体の DB の receipt_files.sha256 を重複なく読む。事業体の DB 以外は読まない", () => {
    const e1 = createTestEntity({ name: "A" });
    const e2 = createTestEntity({ name: "B" });
    const s1 = addReceipts(e1.id, ["a", "b"]);
    addReceipts(e2.id, []);
    const snapDir = createSnapshotDir(join(tmp.dir, "scratch"));
    try {
      const snapshot = snapshotDataDir(dataDir(), snapDir);
      const refs = receiptRefsFromSnapshotFiles(snapshot.files);
      expect(refs.map((r) => r.entityId).sort()).toEqual([e1.id, e2.id].sort());
      expect(refs.find((r) => r.entityId === e1.id)?.sha256s).toEqual([...s1].sort());
      expect(refs.find((r) => r.entityId === e2.id)?.sha256s).toEqual([]);
    } finally {
      rmSync(snapDir, { recursive: true, force: true });
    }
  });

  it("事業体の ID が UUID の形でない `tenants/<36 字>.sqlite` は読まない（isValidEntityId と同じ検査）", () => {
    const refs = receiptRefsFromSnapshotFiles([
      { path: `tenants/${"-".repeat(36)}.sqlite`, bytes: Buffer.from("not a database") },
      { path: `tenants/${"a".repeat(36)}.sqlite`, bytes: Buffer.from("not a database") },
    ]);
    expect(refs).toEqual([]);
  });
});

// ---- バックアップ → 復元の往復（INV-68、SC-006） ----

const src = () => join(tmp.dir, "src");
const dest = () => join(tmp.dir, "dest", "data");
const scratch = () => join(tmp.dir, "scratch");
const tbk = () => join(folder(), "backup.tbk");

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

/** src に事業体 2 件（証憑 3 件と 1 件）を作って置き場所へ写し、.tbk を書く */
async function backupWithReceipts(): Promise<{ entityIds: string[]; shas: string[][] }> {
  const made = withDataDir(src(), () => {
    openRegistry();
    const entities = seedEntities([
      { name: "事業A", kind: "individual", seed: 1, journals: 3, memo: "", note: "" },
      { name: "事業B", kind: "individual", seed: 2, journals: 2, memo: "", note: "" },
    ]);
    const shas = [
      addReceipts(entities[0]?.id ?? "", ["a1", "a2", "a3"]),
      addReceipts(entities[1]?.id ?? "", ["b1"]),
    ];
    return { entityIds: entities.map((x) => x.id), shas };
  });
  mkdirSync(folder(), { recursive: true });
  const snapDir = createSnapshotDir(scratch());
  try {
    const snapshot = withDataDir(src(), () => snapshotDataDir(src(), snapDir));
    const refs = receiptRefsFromSnapshotFiles(snapshot.files);
    // 同期の関数ではないので、データ場所の切り替えは自分で戻す
    process.env.TREBUCHET_DATA_DIR = src();
    try {
      await syncReceiptsToStore({ dk: dk(), storeDir: storeDir(), refs });
    } finally {
      process.env.TREBUCHET_DATA_DIR = tmp.dir;
    }
    writeFileSync(
      tbk(),
      encryptBackup(packArchive(snapshot), TEST_DATA_KEY, {
        appVersion: currentAppVersion(),
        macId: "mac-from-source",
        createdAt: "2026-10-31T09:00:00.000Z",
        recoveryWrap: recovery.wrap,
      }),
    );
  } finally {
    rmSync(snapDir, { recursive: true, force: true });
  }
  return made;
}

function restore(overrides: Partial<Parameters<typeof restoreBackup>[0]> = {}) {
  return restoreBackup({
    file: tbk(),
    recoveryKey: recovery.text,
    dataDir: dest(),
    tmpRoot: scratch(),
    confirm: () => true,
    now: () => NOW,
    receiptsDir: storeDir(),
    ...overrides,
  });
}

const receiptFilesIn = (dir: string, entityId: string) =>
  listFiles(join(dir, "receipts", entityId.toLowerCase()));

describe("restoreBackup: 証憑（INV-68）", () => {
  it("往復で、全証憑の名前・数・中身が元と同じ（復号してハッシュが一致する）", async () => {
    const { entityIds, shas } = await backupWithReceipts();
    mkdirSync(dest(), { recursive: true });

    const result = await restore();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.missingReceipts).toBe(0);
    entityIds.forEach((id, i) => {
      const expected = (shas[i] ?? []).map((s) => `${s}.trc`).sort();
      expect(receiptFilesIn(dest(), id)).toEqual(expected);
      for (const sha of shas[i] ?? []) {
        const restored = readFileSync(join(dest(), "receipts", id, `${sha}.trc`));
        expect(restored.equals(readFileSync(join(src(), "receipts", id, `${sha}.trc`)))).toBe(true);
        expect(sha256(decryptReceipt(restored, id, sha, dk()))).toBe(sha);
      }
    });
    expect(readdirSync(join(tmp.dir, "dest")).filter((n) => /\.restore-/.test(n))).toEqual([]);
  });

  it("INV-54 のまま: 証憑があっても .tbk は回復キーだけで開き、証憑の置き場所は .tbk の外", async () => {
    await backupWithReceipts();
    const bytes = readFileSync(tbk());
    // .tbk に証憑のバイト列も名前も入らない（暗号化された中身は見えないが、大きさは DB の写しだけ）
    expect(bytes.length).toBeLessThan(5 * 1024 * 1024);
    mkdirSync(dest(), { recursive: true });
    expect((await restore()).ok).toBe(true);
  });

  it("置き場所のファイルが 1 つ欠けると RECEIPTS_MISSING（件数つき）。何も変えない", async () => {
    const { entityIds, shas } = await backupWithReceipts();
    const victim = shas[0]?.[1] ?? "";
    rmSync(join(storeDir(), entityIds[0] ?? "", `${receiptBackupName(dk(), victim)}.trc`));
    mkdirSync(dest(), { recursive: true });
    writeFileSync(join(dest(), "marker.txt"), "unchanged");
    const before = readdirSync(join(tmp.dir, "dest")).sort();
    let reported = -1;

    const result = await restore({ onReceiptsMissing: (n) => (reported = n) });

    expect(result).toEqual({ ok: false, error: "RECEIPTS_MISSING" });
    expect(reported).toBe(1);
    expect(readdirSync(join(tmp.dir, "dest")).sort()).toEqual(before);
    expect(readFileSync(join(dest(), "marker.txt"), "utf8")).toBe("unchanged");
    expect(existsSync(join(dest(), "registry.sqlite"))).toBe(false);
  });

  it("置き場所のファイルが改ざんされていても RECEIPTS_MISSING。何も変えない", async () => {
    const { entityIds, shas } = await backupWithReceipts();
    const path = join(
      storeDir(),
      entityIds[1] ?? "",
      `${receiptBackupName(dk(), shas[1]?.[0] ?? "")}.trc`,
    );
    const bytes = readFileSync(path);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff;
    writeFileSync(path, bytes);
    mkdirSync(dest(), { recursive: true });

    const result = await restore();

    expect(result).toEqual({ ok: false, error: "RECEIPTS_MISSING" });
    expect(readdirSync(join(tmp.dir, "dest"))).toEqual(["data"]);
    expect(readdirSync(dest())).toEqual([]);
  });

  it("置き場所がまるごとなくても RECEIPTS_MISSING（全件を数える）", async () => {
    await backupWithReceipts();
    rmSync(storeDir(), { recursive: true, force: true });
    mkdirSync(dest(), { recursive: true });
    let reported = -1;

    const result = await restore({ onReceiptsMissing: (n) => (reported = n) });

    expect(result).toEqual({ ok: false, error: "RECEIPTS_MISSING" });
    expect(reported).toBe(4);
    expect(readdirSync(dest())).toEqual([]);
  });

  it("allowMissingReceipts なら帳簿だけ戻り、写せた証憑は書く。欠けた数を返す", async () => {
    const { entityIds, shas } = await backupWithReceipts();
    const victim = shas[0]?.[1] ?? "";
    rmSync(join(storeDir(), entityIds[0] ?? "", `${receiptBackupName(dk(), victim)}.trc`));
    mkdirSync(dest(), { recursive: true });

    const result = await restore({ allowMissingReceipts: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.missingReceipts).toBe(1);
    expect(existsSync(join(dest(), "registry.sqlite"))).toBe(true);
    expect(receiptFilesIn(dest(), entityIds[0] ?? "")).toEqual(
      (shas[0] ?? [])
        .filter((s) => s !== victim)
        .map((s) => `${s}.trc`)
        .sort(),
    );
    expect(receiptFilesIn(dest(), entityIds[1] ?? "")).toEqual(
      (shas[1] ?? []).map((s) => `${s}.trc`),
    );
  });

  it("証憑が 0 件の帳簿は receiptsDir がなくても今までどおり復元できる", async () => {
    withDataDir(src(), () => {
      openRegistry();
      seedEntities([
        { name: "事業", kind: "individual", seed: 1, journals: 2, memo: "", note: "" },
      ]);
    });
    mkdirSync(folder(), { recursive: true });
    const snapDir = createSnapshotDir(scratch());
    try {
      const snapshot = withDataDir(src(), () => snapshotDataDir(src(), snapDir));
      writeFileSync(
        tbk(),
        encryptBackup(packArchive(snapshot), TEST_DATA_KEY, {
          appVersion: currentAppVersion(),
          macId: "mac-from-source",
          createdAt: "2026-10-31T09:00:00.000Z",
          recoveryWrap: recovery.wrap,
        }),
      );
    } finally {
      rmSync(snapDir, { recursive: true, force: true });
    }
    mkdirSync(dest(), { recursive: true });

    const result = await restoreBackup({
      file: tbk(),
      recoveryKey: recovery.text,
      dataDir: dest(),
      tmpRoot: scratch(),
      confirm: () => true,
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(dest(), "receipts"))).toBe(false);
  });

  it("既存の帳簿があるとき、RECEIPTS_MISSING は復元前のバックアップも作らず何も変えない", async () => {
    const { entityIds, shas } = await backupWithReceipts();
    rmSync(
      join(storeDir(), entityIds[0] ?? "", `${receiptBackupName(dk(), shas[0]?.[0] ?? "")}.trc`),
    );
    // 今の帳簿（dest）には別の事業体がある
    withDataDir(dest(), () => {
      openRegistry();
      seedEntities([
        { name: "既存", kind: "individual", seed: 7, journals: 1, memo: "", note: "" },
      ]);
    });
    const before = readdirSync(join(tmp.dir, "dest")).sort();

    const result = await restore();

    expect(result).toEqual({ ok: false, error: "RECEIPTS_MISSING" });
    expect(readdirSync(join(tmp.dir, "dest")).sort()).toEqual(before);
  });
});
