import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AppVersion,
  type BackupHeaderInput,
  currentAppVersion,
  type DbKeyScope,
  dataDir,
  encryptBackup,
  openEncryptedSqlite,
  packArchive,
  type Snapshot,
} from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { BackupInspection } from "@trebuchet/schema";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { fastCrypto, PASSPHRASE } from "./backup-helpers.ts";
import { createTestEntity, createTestSession, errorOf, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";

// T014: POST /backup/inspect（contracts/http-api.md「バックアップ」。R13、FR-024・027）

const ENTITY = "0192f3a0-0000-7000-8000-000000000001";
const CREATED_AT = "2026-10-20T09:00:00.000Z";
const MAC_ID = "9f3c2b1a-1111-4222-8333-444455556666";
const crypto = fastCrypto().crypto;

const snapshot: Snapshot = {
  files: [
    { path: "registry.sqlite", bytes: Buffer.from("registry-bytes") },
    { path: `tenants/${ENTITY}.sqlite`, bytes: Buffer.from("tenant-bytes!") },
  ],
  manifest: {
    files: [],
    entities: [
      {
        id: ENTITY,
        name: "事業 A",
        fiscalYears: [
          { year: 2025, journals: 3 },
          { year: 2026, journals: 12 },
        ],
      },
    ],
  },
};

/** .tbk を作る（鍵導出は軽くしてある。ファイルは1回作って使い回す） */
async function makeFile(version: AppVersion = currentAppVersion()): Promise<Buffer> {
  const header: BackupHeaderInput = { appVersion: version, macId: MAC_ID, createdAt: CREATED_AT };
  return encryptBackup(packArchive(snapshot), PASSPHRASE, header, crypto);
}

let good: Buffer;
let newer: Buffer;
let older: Buffer;
beforeAll(async () => {
  const v = currentAppVersion();
  good = await makeFile();
  newer = await makeFile({ registry: v.registry + 1, tenant: v.tenant });
  older = await makeFile({ registry: v.registry, tenant: Math.max(0, v.tenant - 1) });
});

let tmp: TempDataDir;
let cookie: string;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  tmp = useTempDataDir("server");
  await createTestEntity("事業 A");
  cookie = (await createTestSession()).cookie;
  app = createApp({ backup: { crypto } });
});
afterEach(() => tmp.cleanup());

const form = (file: Uint8Array | undefined, passphrase: string | null = PASSPHRASE) => {
  const f = new FormData();
  if (file !== undefined) f.append("file", new File([new Uint8Array(file)], "x.tbk"));
  if (passphrase !== null) f.append("passphrase", passphrase);
  return f;
};

const inspect = (body: FormData, target = app, headers?: Record<string, string>) =>
  target.request("/api/backup/inspect", {
    method: "POST",
    body,
    headers: headers ?? { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: cookie },
  });

/** registry（セッションを除く）と全事業体の DB の全ての表の内容（DK から作った鍵で開く。008 の D2） */
function dumpAll(): unknown {
  const dump = (path: string, skip: string[], scope: DbKeyScope) => {
    const db = openEncryptedSqlite(path, scope, { readonly: true, fileMustExist: true });
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      )
        .map((t) => t.name)
        .filter((n) => !skip.includes(n) && !n.startsWith("sqlite_"))
        .sort();
      return tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]);
    } finally {
      db.close();
    }
  };
  const tenantsDir = join(dataDir(), "tenants");
  return {
    registry: dump(join(dataDir(), "registry.sqlite"), ["sessions"], "registry"),
    tenants: readdirSync(tenantsDir)
      .filter((n) => n.endsWith(".sqlite"))
      .sort()
      .map((n) => [n, dump(join(tenantsDir, n), [], { tenant: n.replace(/\.sqlite$/, "") })]),
  };
}

describe("POST /api/backup/inspect", () => {
  it("正しいパスフレーズで要約を返す", async () => {
    const res = await inspect(form(good));
    expect(res.status).toBe(200);
    const body = (await res.json()) as BackupInspection;
    expect(body).toEqual({
      createdAt: CREATED_AT,
      macId: MAC_ID,
      appVersion: currentAppVersion(),
      entities: snapshot.manifest.entities,
    });
  });

  it("誤ったパスフレーズは 422 BACKUP_INVALID。応答にパスフレーズを含めない", async () => {
    const wrong = "wrong horse battery staple";
    const res = await inspect(form(good, wrong));
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("BACKUP_INVALID");
    expect(text).not.toContain(wrong);
  });

  it("1バイト書き換え・切り詰め・ファイルでない中身は 422 BACKUP_INVALID（誤ったパスフレーズと同じ応答）", async () => {
    const flipped = Buffer.from(good);
    flipped[flipped.length - 20] = (flipped[flipped.length - 20] ?? 0) ^ 0xff;
    const wrong = await inspect(form(good, "wrong horse battery staple"));
    const wrongBody = await wrong.json();
    for (const bad of [flipped, good.subarray(0, good.length - 1), Buffer.from("not a backup")]) {
      const res = await inspect(form(bad));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual(wrongBody);
    }
  });

  it("アプリの版が今と違う（新しい・古い）と 422 BACKUP_VERSION_MISMATCH", async () => {
    for (const file of [newer, older]) {
      const res = await inspect(form(file));
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe("BACKUP_VERSION_MISMATCH");
    }
  });

  it("file がない・passphrase がない → 400 VALIDATION", async () => {
    for (const body of [form(undefined), form(good, null)]) {
      const res = await inspect(body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
  });

  it("上限を超えるファイルは 413 FILE_TOO_LARGE", async () => {
    const small = createApp({ backup: { crypto, inspectMaxBytes: good.length - 1 } });
    const res = await inspect(form(good), small);
    expect(res.status).toBe(413);
    const error = await errorOf(res);
    expect(error.code).toBe("FILE_TOO_LARGE");
    expect(error.details).toEqual({ maxBytes: good.length - 1 });
    // ちょうどの大きさは通る
    const exact = createApp({ backup: { crypto, inspectMaxBytes: good.length } });
    expect((await inspect(form(good), exact)).status).toBe(200);
  });

  it("検査の前後で registry と事業体の DB の内容が同じ。平文の写しを残さない", async () => {
    const before = dumpAll();
    const filesBefore = readdirSync(dataDir(), { recursive: true }).sort();
    expect((await inspect(form(good))).status).toBe(200);
    expect((await inspect(form(good, "wrong horse battery staple"))).status).toBe(422);
    expect(dumpAll()).toEqual(before);
    expect(readdirSync(dataDir(), { recursive: true }).sort()).toEqual(filesBefore);
  });

  it("未サインインは 401", async () => {
    const res = await inspect(form(good), app, { Host: TEST_HOST, Origin: TEST_ORIGIN });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("UNAUTHENTICATED");
  });
});
